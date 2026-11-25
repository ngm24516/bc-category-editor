// The shared item catalog (read-only for users). No user data here, so no withUser().
//
//   GET /api/catalog/mods?q=text | ?ids=a,b   mods with their newest version (search or look up)
//   GET /api/catalog/versions/:id             items + category names + icon layout of one version
//   GET /api/catalog/versions/:id/icons/:n.webp
//   POST /api/catalog/lookup  { fullTypes } -> names and icons for those items (the Stockroom page)
//
// A version never changes once written, so its responses are cached "forever" by browsers and in memory.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import express from "express";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_TYPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
const IMMUTABLE = "public, max-age=31536000, immutable";
const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "seed", "vanilla");

// mod.info ids that mean a feature even when the importer didn't spot it in the files (Stockroom's own
// mod id; see importer/pzcatalog/features.py). Lower case. Applies to versions imported before detection, too.
export const FEATURE_MOD_IDS = { stockroom: "stockroom" };
const FEATURE_MOD_IDS_SQL = Object.entries(FEATURE_MOD_IDS).map(([id, f]) => `('${id}', '${f}')`).join(", ");

// Newest version of each mod, with the fields the editor's mod list needs.
const MOD_LIST_SQL = `
  SELECT m.id, m.kind, m.workshop_id, m.name, v.id AS version_id, v.label, v.item_count, v.features, v.created_at AS updated_at,
         coalesce(u.display_name, u.username) AS added_by
    FROM mods m
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN LATERAL (
      SELECT id, label, item_count, created_at,
             -- Features found in the files, plus ones a mod is known by its mod.info id for (see FEATURE_MOD_IDS).
             ARRAY(SELECT DISTINCT f FROM unnest(features || ARRAY(
               SELECT k.feature FROM unnest(mod_ids) AS i(id)
                 JOIN (VALUES ${FEATURE_MOD_IDS_SQL}) AS k(mod_id, feature) ON lower(i.id) = k.mod_id)) AS f ORDER BY f) AS features
        FROM mod_versions WHERE mod_id = m.id ORDER BY created_at DESC LIMIT 1
    ) v ON true`;

export const modJson = r => ({
  id: r.id, kind: r.kind, workshopId: r.workshop_id, name: r.name,
  versionId: r.version_id, label: r.label, itemCount: r.item_count, updatedAt: r.updated_at,
  features: r.features || [], addedBy: r.added_by || null,
});

export function createCatalogRouter({ pool }) {
  const router = express.Router();
  const versionCache = new Map(); // id -> JSON string; versions are immutable
  const run = h => (req, res, next) => Promise.resolve(h(req, res)).catch(next);

  router.get("/mods", run(async (req, res) => {
    const { q, ids } = req.query;
    let rows;
    if (typeof ids === "string" && ids) {
      const list = ids.split(",").filter(x => UUID.test(x)).slice(0, 500);
      rows = (await pool.query(`${MOD_LIST_SQL} WHERE m.id = ANY($1::uuid[])`, [list])).rows;
    } else {
      const text = typeof q === "string" ? q.trim().slice(0, 100) : "";
      const ws = text.match(/(?:id=)?(\d{6,20})\b/);
      rows = (await pool.query(
        `${MOD_LIST_SQL}
          WHERE m.kind = 'workshop' AND v.id IS NOT NULL
            AND ($1 = '' OR m.name ILIKE '%' || $1 || '%' OR m.workshop_id = $2)
          ORDER BY lower(m.name) LIMIT 50`,
        [text.replace(/[%_\\]/g, "\\$&"), ws ? ws[1] : null])).rows;
    }
    res.json(rows.map(modJson));
  }));

  router.get("/base", run(async (_req, res) => {
    const { rows } = await pool.query(`${MOD_LIST_SQL} WHERE m.kind = 'base'`);
    if (!rows[0]?.version_id) return res.status(503).json({ error: "catalog_not_ready", message: "The base game isn't loaded yet" });
    res.json(modJson(rows[0]));
  }));

  router.get("/versions/:id", run(async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(404).json({ error: "not_found" });
    let body = versionCache.get(id);
    if (!body) {
      const v = await pool.query(
        "SELECT v.id, v.mod_id, v.label, v.icons, m.name FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE v.id = $1", [id]);
      if (!v.rowCount) return res.status(404).json({ error: "not_found" });
      const items = await pool.query(
        `SELECT full_type, name, display_category, default_category, item_type, icon_tile, icon_name
           FROM catalog_items WHERE version_id = $1 ORDER BY full_type`, [id]);
      const names = await pool.query("SELECT category_id, display_name FROM catalog_category_names WHERE version_id = $1", [id]);
      const r = v.rows[0];
      body = JSON.stringify({
        id: r.id, modId: r.mod_id, name: r.name, label: r.label, icons: r.icons,
        items: items.rows.map(i => [i.full_type, i.name, i.display_category, i.default_category, i.item_type, i.icon_tile, i.icon_name]),
        catNames: Object.fromEntries(names.rows.map(n => [n.category_id, n.display_name])),
      });
      versionCache.set(id, body);
      if (versionCache.size > 200) versionCache.delete(versionCache.keys().next().value);
    }
    res.setHeader("Cache-Control", IMMUTABLE);
    res.type("application/json").send(body);
  }));

  // Names and icons for a list of item types, for pages that don't load the whole catalog (Stockroom).
  // The base game's name wins when there is one; the icon comes from any newest mod version that draws it.
  router.post("/lookup", run(async (req, res) => {
    const list = req.body?.fullTypes;
    if (!Array.isArray(list) || list.length > 20000 || list.some(f => typeof f !== "string" || f.length > 200 || !FULL_TYPE.test(f))) {
      return res.status(400).json({ error: "invalid", message: "Send { fullTypes: [\"Base.Axe\", ...] } (at most 20000)" });
    }
    const { rows } = await pool.query(`
      WITH want AS (SELECT DISTINCT unnest($1::text[]) AS ft),
      latest AS (SELECT DISTINCT ON (mod_id) id, mod_id, created_at FROM mod_versions ORDER BY mod_id, created_at DESC),
      pick AS (
        SELECT DISTINCT ON (c.full_type) c.full_type, c.name, c.version_id, c.icon_tile, c.icon_name
          FROM want w JOIN catalog_items c ON c.full_type = w.ft
          JOIN latest l ON l.id = c.version_id JOIN mods m ON m.id = l.mod_id
         ORDER BY c.full_type, (m.kind = 'base') DESC, (c.icon_tile >= 0) DESC, l.created_at DESC)
      SELECT p.full_type, p.name,
             CASE WHEN p.icon_tile >= 0 THEN p.version_id ELSE ic.version_id END AS icon_version,
             CASE WHEN p.icon_tile >= 0 THEN p.icon_tile ELSE ic.icon_tile END AS icon_tile
        FROM pick p
        LEFT JOIN LATERAL (
          SELECT c2.version_id, c2.icon_tile FROM catalog_items c2 JOIN latest l2 ON l2.id = c2.version_id
           WHERE p.icon_tile < 0 AND p.icon_name <> '' AND c2.icon_name = p.icon_name AND c2.icon_tile >= 0 LIMIT 1) ic ON true`,
    [list]);
    const versions = [...new Set(rows.map(r => r.icon_version).filter(Boolean))];
    const sets = versions.length ? (await pool.query("SELECT id, icons FROM mod_versions WHERE id = ANY($1)", [versions])).rows : [];
    res.json({
      iconSets: Object.fromEntries(sets.map(v => [v.id, { cols: v.icons.cols, perSheet: v.icons.perSheet }])),
      items: Object.fromEntries(rows.map(r => [r.full_type, { name: r.name, icon: r.icon_version ? [r.icon_version, r.icon_tile] : null }])),
    });
  }));

  router.get("/versions/:id/icons/:sheet.webp", run(async (req, res) => {
    const { id } = req.params, sheet = Number(req.params.sheet);
    if (!UUID.test(id) || !Number.isInteger(sheet) || sheet < 0) return res.status(404).end();
    const { rows } = await pool.query("SELECT webp FROM icon_sheets WHERE version_id = $1 AND sheet = $2", [id, sheet]);
    if (!rows[0]) return res.status(404).end();
    res.setHeader("Cache-Control", IMMUTABLE);
    res.type("image/webp").send(rows[0].webp);
  }));

  return router;
}

// Loads the base game from seed/vanilla/ if this game version isn't in the catalog yet.
// Runs at start-up after migrations; a no-op when already loaded. Safe with several replicas (advisory lock).
export async function seedBaseGame(pool, log = console.log, dir = SEED_DIR) {
  const seed = JSON.parse(gunzipSync(await readFile(path.join(dir, "catalog.json.gz"))).toString("utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(727402)");
    let mod = (await client.query("SELECT id FROM mods WHERE kind = 'base'")).rows[0];
    if (!mod) mod = (await client.query("INSERT INTO mods (kind, name) VALUES ('base', 'Project Zomboid') RETURNING id")).rows[0];
    const exists = await client.query("SELECT 1 FROM mod_versions WHERE mod_id = $1 AND label = $2", [mod.id, seed.label]);
    if (exists.rowCount) { await client.query("COMMIT"); return false; }

    const { rows: [ver] } = await client.query(
      `INSERT INTO mod_versions (mod_id, label, game_version, icons, base_props, item_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [mod.id, seed.label, seed.game, seed.icons, seed.props, seed.items.length]);
    await insertItems(client, ver.id, seed.items);
    await insertCategoryNames(client, ver.id, seed.catNames);
    for (let i = 0; i < seed.icons.sheets; i++) {
      await client.query("INSERT INTO icon_sheets (version_id, sheet, webp) VALUES ($1, $2, $3)",
        [ver.id, i, await readFile(path.join(dir, `icons${i}.webp`))]);
    }
    await client.query("COMMIT");
    log(`Loaded the base game (${seed.label}, ${seed.items.length} items) into the catalog`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function insertItems(db, versionId, items) {
  for (let i = 0; i < items.length; i += 2000) {
    const chunk = items.slice(i, i + 2000);
    const col = k => chunk.map(r => r[k]);
    await db.query(
      `INSERT INTO catalog_items (version_id, full_type, name, display_category, default_category, item_type, icon_tile, icon_name)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[])`,
      [versionId, col(0), col(1), col(2), col(3), col(4), col(5), col(6)]);
  }
}

export async function insertCategoryNames(db, versionId, names) {
  const e = Object.entries(names || {});
  if (!e.length) return;
  await db.query(
    `INSERT INTO catalog_category_names (version_id, category_id, display_name)
     SELECT $1, * FROM unnest($2::text[], $3::text[])`, [versionId, e.map(x => x[0]), e.map(x => x[1])]);
}
