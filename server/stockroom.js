// Stockroom inventories: each signed-in user's characters and what they have in their safehouse, imported
// from the Stockroom mod's save files (decoded in the browser; only item totals are sent). User data: every
// query goes through withUser() and the table has row-level security.
//
//   GET    /api/stockroom        { characters: [{ id, label, sequence, houses, items, importedAt }] }
//   PUT    /api/stockroom        { characters: [{ identity, label, sequence, houses, items }] } adds or replaces
//   DELETE /api/stockroom/:id    forgets one character
import express from "express";
import { withUser } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_TYPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
export const STOCKROOM_LIMITS = { characters: 20, items: 20000, houses: 50 };

class Invalid extends Error {}
const text = (v, max, what) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Invalid(`${what} must be text of up to ${max} characters`);
  return v.trim();
};

// One character from the request, cleaned; throws Invalid with a message for the user.
export function cleanCharacter(c) {
  if (!c || typeof c !== "object") throw new Invalid("Each character must be an object");
  const identity = text(c.identity, 300, "identity");
  const label = text(c.label, 200, "label");
  const sequence = Number.isSafeInteger(c.sequence) && c.sequence >= 0 ? c.sequence : 0;
  if (!c.items || typeof c.items !== "object" || Array.isArray(c.items)) throw new Invalid("items must be an object of item counts");
  const entries = Object.entries(c.items);
  if (entries.length > STOCKROOM_LIMITS.items) throw new Invalid(`At most ${STOCKROOM_LIMITS.items} different items per character`);
  const items = {};
  for (const [ft, n] of entries) {
    if (ft.length > 200 || !FULL_TYPE.test(ft)) throw new Invalid(`"${ft.slice(0, 60)}" isn't an item type like Base.Axe`);
    if (!Number.isSafeInteger(n) || n < 1 || n > 1e9) throw new Invalid(`The count for ${ft} must be a whole number from 1`);
    items[ft] = n;
  }
  const houses = Array.isArray(c.houses) ? c.houses.slice(0, STOCKROOM_LIMITS.houses).map(h => ({
    name: typeof h?.name === "string" ? h.name.slice(0, 120) : "Safehouse",
    containers: Number.isSafeInteger(h?.containers) && h.containers >= 0 ? h.containers : 0,
  })) : [];
  return { identity, label, sequence, items, houses };
}

const characterJson = r => ({
  id: r.id, label: r.label, sequence: Number(r.sequence), houses: r.houses, items: r.items, importedAt: r.imported_at,
});

export function createStockroomRouter({ pool, requireUser }) {
  const router = express.Router();
  router.use(requireUser);
  const bad = (res, message) => res.status(400).json({ error: "invalid", message });

  router.get("/", async (req, res) => {
    const rows = await withUser(pool, req.user.id, async db =>
      (await db.query("SELECT * FROM stockroom_characters ORDER BY imported_at DESC")).rows);
    res.json({ characters: rows.map(characterJson) });
  });

  router.put("/", async (req, res) => {
    const list = req.body?.characters;
    if (!Array.isArray(list) || !list.length) return bad(res, "Send { characters: [...] } with at least one character");
    let clean;
    try { clean = list.map(cleanCharacter); } catch (err) {
      if (err instanceof Invalid) return bad(res, err.message);
      throw err;
    }
    const rows = await withUser(pool, req.user.id, async db => {
      const { rows: [{ n }] } = await db.query(
        "SELECT count(*)::int AS n FROM stockroom_characters WHERE NOT (identity = ANY($1))", [clean.map(c => c.identity)]);
      if (n + clean.length > STOCKROOM_LIMITS.characters) return null;
      const out = [];
      for (const c of clean) {
        out.push((await db.query(
          `INSERT INTO stockroom_characters (user_id, identity, label, sequence, houses, items)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, identity) DO UPDATE SET label = EXCLUDED.label, sequence = EXCLUDED.sequence,
             houses = EXCLUDED.houses, items = EXCLUDED.items, imported_at = now()
           RETURNING *`,
          [req.user.id, c.identity, c.label, c.sequence, JSON.stringify(c.houses), JSON.stringify(c.items)])).rows[0]);
      }
      return out;
    });
    if (!rows) return bad(res, `You can keep up to ${STOCKROOM_LIMITS.characters} characters. Remove one first.`);
    res.json({ characters: rows.map(characterJson) });
  });

  router.delete("/:id", async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found", message: "No such character" });
    const n = await withUser(pool, req.user.id, async db =>
      (await db.query("DELETE FROM stockroom_characters WHERE id = $1", [req.params.id])).rowCount);
    if (!n) return res.status(404).json({ error: "not_found", message: "No such character" });
    res.status(204).end();
  });

  return router;
}
