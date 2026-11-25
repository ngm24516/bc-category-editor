// Admin dashboard API. Admins only (role set from ADMIN_DISCORD_IDS at sign-in); everyone else gets 403.
//
//   GET  /api/admin/overview          counts, the queue, schedule, recent imports, importer runs
//   GET  /api/admin/jobs/:id/log      the worker's log for one import
//   POST /api/admin/jobs/:id/retry    put a failed import back in the queue
//   POST /api/admin/jobs/retry-failed put every mod whose latest import failed back in the queue
//
// Shared tables only (jobs, runs, catalog): no per-user data, so no withUser() here.
import express from "express";

const ID = /^\d{1,18}$/;

// The next time the hourly update check runs: minute `minute` of the hour, UTC (matches infra/main.bicep).
export function nextHourlyRun(now, minute) {
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(minute);
  if (t <= now) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

const jobJson = r => ({
  id: Number(r.id), workshopId: r.workshop_id, title: r.title, reason: r.reason, status: r.status,
  error: r.error, attempts: r.attempts, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  seconds: r.started_at && r.finished_at ? Math.round((r.finished_at - r.started_at) / 1000) : null,
  modName: r.mod_name || null, hasLog: !!r.has_log,
  requestedBy: r.username ? (r.display_name || r.username) : null,
});

const runJson = r => ({
  id: Number(r.id), kind: r.kind, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
  seconds: r.finished_at ? Math.round((r.finished_at - r.started_at) / 1000) : null,
  processed: r.processed, succeeded: r.succeeded, failed: r.failed, error: r.error,
});

// Ids of failed jobs that are still the latest job for their Workshop item (nothing newer queued, running or done).
const LATEST_FAILED_SQL = `
  SELECT id FROM (SELECT DISTINCT ON (workshop_id) id, status FROM import_jobs ORDER BY workshop_id, created_at DESC, id DESC) l
   WHERE l.status = 'failed'`;

const JOB_COLUMNS = `j.id, j.workshop_id, j.title, j.reason, j.status, j.error, j.attempts, j.created_at, j.started_at,
  j.finished_at, j.log IS NOT NULL AS has_log, u.username, u.display_name, m.name AS mod_name
  FROM import_jobs j LEFT JOIN users u ON u.id = j.requested_by LEFT JOIN mods m ON m.id = j.mod_id`;

export function createAdminRouter({ pool, requireUser, config }) {
  const router = express.Router();
  router.use(requireUser, (req, res, next) => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden", message: "Admins only" });
    next();
  });
  const run = h => (req, res, next) => Promise.resolve(h(req, res)).catch(next);
  const requeue = async id => (await pool.query(
    `UPDATE import_jobs SET status = 'queued', error = NULL, attempts = 0, started_at = NULL, finished_at = NULL,
                            log = NULL, run_id = NULL, created_at = now()
      WHERE id = $1 AND status = 'failed'`, [id])).rowCount > 0;

  router.get("/overview", run(async (_req, res) => {
    const [counts, queue, recent, runs, lastRuns, failed] = await Promise.all([
      pool.query(`SELECT
          (SELECT count(*) FROM import_jobs WHERE status = 'queued')::int AS queued,
          (SELECT count(*) FROM import_jobs WHERE status = 'running')::int AS running,
          (SELECT count(*) FROM import_jobs WHERE status = 'done' AND finished_at > now() - interval '24 hours')::int AS done24,
          (SELECT count(*) FROM import_jobs WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed24,
          (SELECT count(*) FROM mods WHERE kind = 'workshop')::int AS mods,
          (SELECT count(*) FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE m.kind = 'workshop')::int AS versions,
          (SELECT count(*) FROM users)::int AS users,
          (SELECT min(created_at) FROM import_jobs WHERE status = 'queued') AS oldest_queued`),
      pool.query(`SELECT ${JOB_COLUMNS} WHERE j.status IN ('queued', 'running') ORDER BY j.created_at LIMIT 200`),
      pool.query(`SELECT ${JOB_COLUMNS} WHERE j.status IN ('done', 'failed') ORDER BY j.finished_at DESC LIMIT 100`),
      pool.query("SELECT * FROM importer_runs ORDER BY started_at DESC LIMIT 30"),
      pool.query(`SELECT DISTINCT ON (kind) kind, started_at, finished_at, status FROM importer_runs
                   ORDER BY kind, started_at DESC`),
      pool.query(`SELECT ${JOB_COLUMNS} WHERE j.id IN (${LATEST_FAILED_SQL}) ORDER BY j.finished_at DESC LIMIT 500`),
    ]);
    const c = counts.rows[0];
    const last = Object.fromEntries(lastRuns.rows.map(r => [r.kind, runJson(r)]));
    const now = new Date();
    // Queued work the importer hasn't picked up within a few polling intervals usually means the job can't start.
    const stalled = !!c.oldest_queued && !c.running && (now - c.oldest_queued) > config.importerPollSeconds * 4000;
    res.json({
      now,
      counts: { queued: c.queued, running: c.running, done24: c.done24, failed24: c.failed24, mods: c.mods, versions: c.versions, users: c.users },
      schedule: {
        importer: { trigger: "queue", pollSeconds: config.importerPollSeconds, lastRun: last.import || null, stalled },
        updates: { cron: `${config.updateCheckMinute} * * * *`, nextRun: nextHourlyRun(now, config.updateCheckMinute), lastRun: last["check-updates"] || null },
      },
      queue: queue.rows.map(jobJson),
      recent: recent.rows.map(jobJson),
      runs: runs.rows.map(runJson),
      failed: failed.rows.map(jobJson),
    });
  }));

  router.get("/jobs/:id/log", run(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const { rows: [j] } = await pool.query("SELECT log FROM import_jobs WHERE id = $1", [req.params.id]);
    if (!j) return res.status(404).json({ error: "not_found" });
    res.json({ log: j.log || "" });
  }));

  router.post("/jobs/retry-failed", run(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id FROM import_jobs WHERE id IN (${LATEST_FAILED_SQL})`);
    let queued = 0;
    for (const { id } of rows) {
      try { queued += (await requeue(id)) ? 1 : 0; } catch (err) { if (err.code !== "23505") throw err; }
    }
    res.json({ queued });
  }));

  router.post("/jobs/:id/retry", run(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    try {
      if (!(await requeue(req.params.id))) return res.status(409).json({ error: "not_failed", message: "Only failed imports can be retried" });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "already_queued", message: "That mod is already queued" });
      throw err;
    }
    res.status(204).end();
  }));

  return router;
}
