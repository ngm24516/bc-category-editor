// Importing Workshop mods. Signed-in users only; every request is recorded against the account that made it.
//
//   POST /api/imports        { link }  a Workshop mod or collection link (or bare id)
//   GET  /api/imports                  my recent requests, each item's status, and my limits for today
//   GET  /api/imports/:id              one of my requests
//   GET  /api/admin/imports            admins: the import log for everyone (who asked for what, and the outcome)
//
// The API never downloads anything. It asks Steam for details, works out which items the catalog is missing,
// and queues them in import_jobs; the importer job (importer/worker.py) does the downloading.
import express from "express";
import { withUser } from "./db.js";
import { PZ_APP_ID, parseWorkshopId } from "./steam.js";

export const LIMITS = { modsPerDay: 10, collectionsPerDay: 1, collectionSize: 500, maxBytes: 4 * 1024 ** 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}

// What the catalog already has for each Workshop id: { modId, updatedAt of its newest version }.
async function catalogState(db, ids) {
  const { rows } = await db.query(
    `SELECT m.workshop_id, m.id, max(v.source_updated_at) AS updated_at
       FROM mods m LEFT JOIN mod_versions v ON v.mod_id = m.id
      WHERE m.workshop_id = ANY($1::text[]) GROUP BY m.id`, [ids]);
  return new Map(rows.map(r => [r.workshop_id, { modId: r.id, updatedAt: r.updated_at }]));
}

async function usage(db) {
  const { rows: [u] } = await db.query(
    `SELECT coalesce(sum(new_jobs) FILTER (WHERE kind = 'mod'), 0)::int AS mods,
            count(*) FILTER (WHERE kind = 'collection')::int AS collections
       FROM import_requests WHERE created_at > now() - interval '24 hours'`);
  return u;
}

const ITEM_SQL = `
  SELECT i.workshop_id, i.title, i.skipped, i.mod_id AS ready_mod, j.status AS job_status, j.error,
         j.mod_id AS job_mod, j.finished_at
    FROM import_request_items i LEFT JOIN import_jobs j ON j.id = i.job_id
   WHERE i.request_id = $1 ORDER BY i.title NULLS LAST, i.workshop_id`;

function itemJson(r) {
  let status, modId = null;
  if (r.skipped) status = "skipped";
  else if (r.ready_mod) { status = "ready"; modId = r.ready_mod; }
  else if (r.job_status === "done") { status = r.job_mod ? "ready" : "failed"; modId = r.job_mod; }
  else status = r.job_status || "failed";
  return { workshopId: r.workshop_id, title: r.title, status, modId,
    message: r.skipped || (status === "failed" ? (r.error || "No Build 42 items were found") : null) };
}

async function readRequest(db, id) {
  const { rows: [q] } = await db.query("SELECT id, kind, workshop_id, title, new_jobs, created_at FROM import_requests WHERE id = $1", [id]);
  if (!q) return null;
  const items = (await db.query(ITEM_SQL, [id])).rows.map(itemJson);
  return { id: q.id, kind: q.kind, workshopId: q.workshop_id, title: q.title, createdAt: q.created_at, items };
}

export function createImportsRouter({ pool, requireUser, steam }) {
  const router = express.Router();
  const run = h => async (req, res, next) => {
    try { await h(req, res); } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.error, message: err.message });
      next(err);
    }
  };

  router.get("/admin/imports", requireUser, run(async (req, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
    const { rows } = await pool.query(
      `SELECT j.id, j.workshop_id, j.title, j.reason, j.status, j.error, j.created_at, j.finished_at,
              u.username, u.discord_id, m.name AS mod_name
         FROM import_jobs j LEFT JOIN users u ON u.id = j.requested_by LEFT JOIN mods m ON m.id = j.mod_id
        ORDER BY j.created_at DESC LIMIT 200`);
    res.json(rows.map(r => ({ id: r.id, workshopId: r.workshop_id, title: r.title, reason: r.reason, status: r.status,
      error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, modName: r.mod_name,
      requestedBy: r.username ? { username: r.username, discordId: r.discord_id } : null })));
  }));

  router.use("/imports", requireUser);

  router.get("/imports", run(async (req, res) => {
    const out = await withUser(pool, req.user.id, async db => {
      const { rows } = await db.query("SELECT id FROM import_requests ORDER BY created_at DESC LIMIT 20");
      const requests = [];
      for (const r of rows) requests.push(await readRequest(db, r.id));
      const u = await usage(db);
      return { requests, limits: { ...LIMITS, modsToday: u.mods, collectionsToday: u.collections, exempt: req.user.role === "admin" } };
    });
    res.json(out);
  }));

  router.get("/imports/:id", run(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const r = await withUser(pool, req.user.id, db => readRequest(db, req.params.id));
    if (!r) return res.status(404).json({ error: "not_found" });
    res.json(r);
  }));

  router.post("/imports", express.json({ limit: "4kb" }), run(async (req, res) => {
    const id = parseWorkshopId(req.body?.link);
    if (!id) throw new HttpError(400, "invalid", "Paste a Steam Workshop link (…/filedetails/?id=123) or its number");
    const exempt = req.user.role === "admin";

    // 1. Ask Steam what this is.
    let children, info, pageTitle = null;
    try {
      children = await steam.collectionChildren(id);
      info = await steam.details(children ? [id, ...children.slice(0, LIMITS.collectionSize)] : [id]);
    } catch (err) {
      console.warn("Steam lookup failed:", err.message);
      throw new HttpError(502, "steam_unavailable", "Steam didn't answer. Try again in a minute.");
    }
    // Steam's API hides the items of a collection it has removed; its public page may still list them.
    if (!children && !info.get(id)?.ok) {
      let fromPage = null;
      try { fromPage = await steam.collectionFromPage(id); } catch (err) { console.warn("Steam page read failed:", err.message); }
      if (fromPage) {
        children = fromPage.ids;
        pageTitle = fromPage.title;
        try { info = await steam.details([id, ...children.slice(0, LIMITS.collectionSize)]); } catch (err) {
          console.warn("Steam lookup failed:", err.message);
          throw new HttpError(502, "steam_unavailable", "Steam didn't answer. Try again in a minute.");
        }
      }
    }
    // Public items Steam's API won't describe are read from their pages instead.
    try { await steam.withPageFallback(info, children ? children.slice(0, LIMITS.collectionSize) : [id]); } catch (err) {
      console.warn("Steam page read failed:", err.message);
    }
    const kind = children ? "collection" : "mod";
    const head = info.get(id);
    // A collection is only a list: if Steam still gives us its items, each one is checked on its own below,
    // even when the collection page itself was removed or hidden.
    if (kind === "mod") {
      if (head?.removed) {
        throw new HttpError(410, "removed", "Steam has removed this Workshop item for breaking its rules, so it can't be imported. If it was a collection, its page no longer lists its mods: import them one by one, or use a copy of the collection.");
      }
      if (!head || !head.ok) {
        throw new HttpError(404, "not_found", "Steam has no public Workshop item with that number (it may be private, friends-only or deleted)");
      }
      if (head.appId !== PZ_APP_ID) throw new HttpError(400, "not_zomboid", "That Workshop item isn't a Project Zomboid mod");
    }
    if (children && children.length > LIMITS.collectionSize) {
      throw new HttpError(400, "too_big", `Collections can have at most ${LIMITS.collectionSize} items`);
    }
    const ids = [...new Set(children || [id])];

    const result = await withUser(pool, req.user.id, async db => {
      // 2. Daily limits (admins are exempt).
      const u = await usage(db);
      if (!exempt && kind === "collection" && u.collections >= LIMITS.collectionsPerDay) {
        throw new HttpError(429, "limit", "You can import one collection a day. Try again tomorrow.");
      }

      // 3. Decide, per item: already in the catalog, skip, or needs importing.
      const state = await catalogState(db, ids);
      const plan = ids.map(w => {
        const d = info.get(w);
        if (d?.removed) return { w, title: d.title, skipped: "Removed by Steam for breaking its rules" };
        if (!d || !d.ok) return { w, title: d?.title || null, skipped: "Not available on Steam (private, friends-only or deleted)" };
        if (d.appId !== PZ_APP_ID) return { w, title: d.title, skipped: "Not a Project Zomboid mod" };
        if (d.size > LIMITS.maxBytes) return { w, title: d.title, skipped: "Larger than 4 GB" };
        const have = state.get(w);
        if (have?.updatedAt && d.updatedAt && have.updatedAt >= d.updatedAt) return { w, title: d.title, ready: have.modId };
        return { w, title: d.title, updatedAt: d.updatedAt, queue: true };
      });

      // 4. Queue what's missing; an item someone else already queued is shared, not queued twice.
      let newJobs = 0;
      for (const p of plan.filter(x => x.queue)) {
        const ins = await db.query(
          `INSERT INTO import_jobs (workshop_id, reason, requested_by, source_updated_at, title)
           VALUES ($1, 'request', $2, $3, $4)
           ON CONFLICT (workshop_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id`,
          [p.w, req.user.id, p.updatedAt, p.title]);
        if (ins.rowCount) { p.job = ins.rows[0].id; newJobs++; }
        else p.job = (await db.query("SELECT id FROM import_jobs WHERE workshop_id = $1 AND status IN ('queued', 'running')", [p.w])).rows[0]?.id;
      }
      if (!exempt && kind === "mod" && newJobs && u.mods + newJobs > LIMITS.modsPerDay) {
        throw new HttpError(429, "limit", `You can import ${LIMITS.modsPerDay} new mods a day. Try again tomorrow.`);
      }

      // 5. Record the request: who asked for what.
      const { rows: [q] } = await db.query(
        "INSERT INTO import_requests (user_id, kind, workshop_id, title, new_jobs) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [req.user.id, kind, id, head?.title || pageTitle, newJobs]);
      for (const p of plan) {
        await db.query(
          `INSERT INTO import_request_items (request_id, user_id, workshop_id, title, job_id, mod_id, skipped)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [q.id, req.user.id, p.w, p.title, p.job || null, p.ready || null, p.skipped || null]);
      }
      return readRequest(db, q.id);
    });
    res.status(201).json(result);
  }));

  return router;
}
