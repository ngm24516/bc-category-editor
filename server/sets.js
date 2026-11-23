// Authorization: every route here runs inside withUser(), so Postgres row-level security limits
// all reads and writes to the signed-in user's rows. The user id comes from the session only.
//
//   GET    /api/sets          list my setups
//   POST   /api/sets          create one       { name, overrides, definitions, blacklist }
//   GET    /api/sets/:id      read one
//   PUT    /api/sets/:id      replace contents { name?, overrides, definitions, blacklist, version }
//   DELETE /api/sets/:id      delete one
//
// PUT uses optimistic concurrency: the client sends the version it loaded, and gets 409 if another
// tab or device saved in between, instead of silently overwriting it.
import express from "express";
import { withUser } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { overrides: 60_000, definitions: 5_000, key: 200, name: 80, blacklist: 500 };
// Nothing that would break an .ini line or section header.
const SAFE = /^[^\r\n\0[\]=]+$/;
const SAFE_VALUE = /^[^\r\n\0]+$/;

class BadRequest extends Error {}

function cleanMap(obj, label, max, valueRe) {
  if (obj === undefined) return [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new BadRequest(`${label} must be an object`);
  const entries = Object.entries(obj);
  if (entries.length > max) throw new BadRequest(`${label} has more than ${max} entries`);
  for (const [k, v] of entries) {
    if (typeof v !== "string" || !k || k.length > LIMITS.key || v.length < 1 || v.length > LIMITS.key ||
        !SAFE.test(k.trim()) || k !== k.trim() || !valueRe.test(v)) {
      throw new BadRequest(`${label} has an invalid entry: ${JSON.stringify(k).slice(0, 80)}`);
    }
  }
  return entries;
}

function cleanBody(body, { partial }) {
  if (!body || typeof body !== "object") throw new BadRequest("Expected a JSON body");
  const out = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > LIMITS.name) {
      throw new BadRequest(`name must be 1-${LIMITS.name} characters`);
    }
    out.name = body.name.trim();
  }
  if (body.blacklist !== undefined) {
    if (typeof body.blacklist !== "string" || body.blacklist.length > LIMITS.blacklist || /[\r\n\0]/.test(body.blacklist)) {
      throw new BadRequest("blacklist must be a short comma-separated string");
    }
    out.blacklist = body.blacklist;
  }
  out.overrides = cleanMap(body.overrides, "overrides", LIMITS.overrides, SAFE);
  out.definitions = cleanMap(body.definitions, "definitions", LIMITS.definitions, SAFE_VALUE);
  return out;
}

async function writeContents(db, setId, userId, overrides, definitions) {
  await db.query("DELETE FROM overrides WHERE set_id = $1", [setId]);
  await db.query("DELETE FROM custom_categories WHERE set_id = $1", [setId]);
  if (overrides.length) {
    await db.query(
      `INSERT INTO overrides (set_id, user_id, item, category)
       SELECT $1, $2, i, c FROM unnest($3::text[], $4::text[]) AS t(i, c)`,
      [setId, userId, overrides.map(e => e[0]), overrides.map(e => e[1])]);
  }
  if (definitions.length) {
    await db.query(
      `INSERT INTO custom_categories (set_id, user_id, category_id, display_name)
       SELECT $1, $2, i, n FROM unnest($3::text[], $4::text[]) AS t(i, n)`,
      [setId, userId, definitions.map(e => e[0]), definitions.map(e => e[1])]);
  }
}

async function readSet(db, id) {
  const { rows } = await db.query(
    "SELECT id, name, blacklist, version, created_at, updated_at FROM category_sets WHERE id = $1", [id]);
  if (!rows[0]) return null;
  const o = await db.query("SELECT item, category FROM overrides WHERE set_id = $1", [id]);
  const d = await db.query("SELECT category_id, display_name FROM custom_categories WHERE set_id = $1", [id]);
  const s = rows[0];
  return {
    id: s.id, name: s.name, blacklist: s.blacklist, version: s.version,
    createdAt: s.created_at, updatedAt: s.updated_at,
    overrides: Object.fromEntries(o.rows.map(r => [r.item, r.category])),
    definitions: Object.fromEntries(d.rows.map(r => [r.category_id, r.display_name])),
  };
}

export function createSetsRouter({ pool, requireUser }) {
  const router = express.Router();
  router.use(requireUser);

  const run = handler => async (req, res, next) => {
    try { await handler(req, res); } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: "invalid", message: err.message });
      if (err.code === "23505") return res.status(409).json({ error: "name_taken", message: "You already have a setup with that name" });
      next(err);
    }
  };
  const idParam = (req, res) => {
    if (!UUID.test(req.params.id)) { res.status(404).json({ error: "not_found" }); return null; }
    return req.params.id;
  };

  router.get("/", run(async (req, res) => {
    const sets = await withUser(pool, req.user.id, db => db.query(
      `SELECT s.id, s.name, s.version, s.updated_at,
              (SELECT count(*) FROM overrides o WHERE o.set_id = s.id)::int AS override_count,
              (SELECT count(*) FROM custom_categories c WHERE c.set_id = s.id)::int AS definition_count
         FROM category_sets s ORDER BY s.updated_at DESC`));
    res.json(sets.rows.map(r => ({ id: r.id, name: r.name, version: r.version, updatedAt: r.updated_at,
      overrideCount: r.override_count, definitionCount: r.definition_count })));
  }));

  router.post("/", run(async (req, res) => {
    const b = cleanBody(req.body, { partial: false });
    const set = await withUser(pool, req.user.id, async db => {
      const { rows } = await db.query(
        "INSERT INTO category_sets (user_id, name, blacklist) VALUES ($1, $2, COALESCE($3, 'Lore')) RETURNING id",
        [req.user.id, b.name, b.blacklist ?? null]);
      await writeContents(db, rows[0].id, req.user.id, b.overrides, b.definitions);
      return readSet(db, rows[0].id);
    });
    res.status(201).json(set);
  }));

  router.get("/:id", run(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const set = await withUser(pool, req.user.id, db => readSet(db, id));
    if (!set) return res.status(404).json({ error: "not_found" });
    res.json(set);
  }));

  router.put("/:id", run(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    if (!Number.isInteger(req.body?.version)) return res.status(400).json({ error: "invalid", message: "version is required" });
    // PUT replaces the whole setup, so a missing list must not be read as "delete everything".
    if (req.body.overrides === undefined || req.body.definitions === undefined) {
      return res.status(400).json({ error: "invalid", message: "overrides and definitions are required" });
    }
    const b = cleanBody(req.body, { partial: true });
    const result = await withUser(pool, req.user.id, async db => {
      const upd = await db.query(
        `UPDATE category_sets
            SET name = COALESCE($3, name), blacklist = COALESCE($4, blacklist),
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2
          RETURNING id`, [id, req.body.version, b.name ?? null, b.blacklist ?? null]);
      if (!upd.rowCount) {
        const exists = await db.query("SELECT version FROM category_sets WHERE id = $1", [id]);
        return exists.rowCount ? { conflict: exists.rows[0].version } : null;
      }
      await writeContents(db, id, req.user.id, b.overrides, b.definitions);
      return readSet(db, id);
    });
    if (!result) return res.status(404).json({ error: "not_found" });
    if (result.conflict !== undefined) {
      return res.status(409).json({ error: "version_conflict", message: "This setup was saved somewhere else since you loaded it", currentVersion: result.conflict });
    }
    res.json(result);
  }));

  router.delete("/:id", run(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const del = await withUser(pool, req.user.id, db => db.query("DELETE FROM category_sets WHERE id = $1", [id]));
    if (!del.rowCount) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  }));

  return router;
}
