// Admin dashboard API: admins only; queue, schedule, history, logs, retry.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { nextHourlyRun } from "../server/admin.js";
import { startHarness } from "./helpers.js";

let h, pool, api, login;
before(async () => { h = await startHarness(); ({ pool, api, login } = h); });
after(() => h.stop());

describe("admin dashboard", () => {
  let admin, alice;
  beforeEach(async () => {
    await h.resetDb();
    admin = await login("code-admin"); alice = await login("code-alice");
    const { rows: [a] } = await pool.query("SELECT id FROM users WHERE username = 'alice'");
    await pool.query(`INSERT INTO import_jobs (workshop_id, reason, requested_by, title, status, created_at)
                      VALUES ('2200148440', 'request', $1, 'Queued mod', 'queued', now() - interval '1 minute'),
                             ('2200148441', 'update', NULL, 'Updating mod', 'running', now())`, [a.id]);
    const { rows: [r] } = await pool.query(
      `INSERT INTO importer_runs (kind, status, started_at, finished_at, processed, succeeded, failed)
       VALUES ('import', 'succeeded', now() - interval '10 minutes', now() - interval '9 minutes', 2, 1, 1) RETURNING id`);
    await pool.query(`INSERT INTO import_jobs (workshop_id, reason, requested_by, title, status, error, log, started_at, finished_at, run_id)
                      VALUES ('2200148442', 'request', $1, 'Broken mod', 'failed', 'No Build 42 mod in this Workshop item',
                              '12:00:00 Job 3: request 2200148442' || chr(10) || '12:00:05 Failed', now() - interval '10 minutes', now() - interval '9 minutes 50 seconds', $2),
                             ('2200148443', 'request', $1, 'Good mod', 'done', NULL, 'Imported', now() - interval '9 minutes 50 seconds', now() - interval '9 minutes', $2)`,
      [a.id, r.id]);
  });

  test("signed out gets 401, a normal user 403", async () => {
    assert.equal((await api(null, "GET", "/api/admin/overview")).status, 401);
    assert.equal((await api(alice, "GET", "/api/admin/overview")).status, 403);
    assert.equal((await api(alice, "GET", "/api/admin/jobs/1/log")).status, 403);
    assert.equal((await api(alice, "POST", "/api/admin/jobs/1/retry")).status, 403);
  });

  test("overview: counts, queue in order, recent results with who asked, runs, schedule", async () => {
    const o = await (await api(admin, "GET", "/api/admin/overview")).json();
    assert.equal(o.counts.queued, 1);
    assert.equal(o.counts.running, 1);
    assert.equal(o.counts.done24, 1);
    assert.equal(o.counts.failed24, 1);
    assert.deepEqual(o.queue.map(j => [j.title, j.status, j.requestedBy]), [["Queued mod", "queued", "Alice"], ["Updating mod", "running", null]]);
    const broken = o.recent.find(j => j.title === "Broken mod");
    assert.equal(broken.error, "No Build 42 mod in this Workshop item");
    assert.equal(broken.seconds, 10);
    assert.equal(broken.hasLog, true);
    assert.equal(o.runs[0].kind, "import");
    assert.equal(o.schedule.updates.cron, "17 * * * *");
    assert.ok(new Date(o.schedule.updates.nextRun) > new Date(o.now));
    assert.equal(o.schedule.importer.pollSeconds, 30);
    assert.equal(o.schedule.importer.stalled, false, "something is running");
  });

  test("queued work nobody picks up is flagged as stalled", async () => {
    await pool.query("UPDATE import_jobs SET status = 'failed' WHERE status = 'running'");
    await pool.query("UPDATE import_jobs SET created_at = now() - interval '10 minutes' WHERE status = 'queued'");
    const o = await (await api(admin, "GET", "/api/admin/overview")).json();
    assert.equal(o.schedule.importer.stalled, true);
  });

  test("a job's log", async () => {
    const { rows: [j] } = await pool.query("SELECT id FROM import_jobs WHERE title = 'Broken mod'");
    const r = await (await api(admin, "GET", `/api/admin/jobs/${j.id}/log`)).json();
    assert.match(r.log, /Failed/);
    assert.equal((await api(admin, "GET", "/api/admin/jobs/999999/log")).status, 404);
  });

  test("retry puts a failed import back in the queue; other states are refused", async () => {
    const { rows: [bad] } = await pool.query("SELECT id FROM import_jobs WHERE title = 'Broken mod'");
    const { rows: [good] } = await pool.query("SELECT id FROM import_jobs WHERE title = 'Good mod'");
    assert.equal((await api(admin, "POST", `/api/admin/jobs/${good.id}/retry`)).status, 409);
    assert.equal((await api(admin, "POST", `/api/admin/jobs/${bad.id}/retry`)).status, 204);
    const { rows: [after] } = await pool.query("SELECT status, error, attempts, log FROM import_jobs WHERE id = $1", [bad.id]);
    assert.deepEqual(after, { status: "queued", error: null, attempts: 0, log: null });
  });

  test("retry refuses when the same mod is already queued", async () => {
    await pool.query("INSERT INTO import_jobs (workshop_id, reason, status) VALUES ('2200148442', 'update', 'queued')");
    const { rows: [bad] } = await pool.query("SELECT id FROM import_jobs WHERE title = 'Broken mod'");
    assert.equal((await api(admin, "POST", `/api/admin/jobs/${bad.id}/retry`)).status, 409);
  });

  test("failed list holds mods whose latest import failed; Retry all requeues them; admins only", async () => {
    // An older failure that a later import fixed isn't listed.
    await pool.query(`INSERT INTO import_jobs (workshop_id, reason, title, status, error, created_at, finished_at) VALUES
      ('2200148443', 'request', 'Good mod', 'failed', 'old failure', now() - interval '1 day', now() - interval '1 day'),
      ('2200148444', 'update', 'Another broken mod', 'failed', 'Steam timed out', now() - interval '2 hours', now() - interval '2 hours')`);
    const o = await (await api(admin, "GET", "/api/admin/overview")).json();
    assert.deepEqual(o.failed.map(j => j.title).sort(), ["Another broken mod", "Broken mod"]);
    assert.equal((await api(alice, "POST", "/api/admin/jobs/retry-failed")).status, 403);
    const r = await api(admin, "POST", "/api/admin/jobs/retry-failed");
    assert.deepEqual(await r.json(), { queued: 2 });
    const { rows } = await pool.query("SELECT workshop_id FROM import_jobs WHERE status = 'queued' ORDER BY workshop_id");
    assert.deepEqual(rows.map(x => x.workshop_id), ["2200148440", "2200148442", "2200148444"]);
    assert.deepEqual((await (await api(admin, "GET", "/api/admin/overview")).json()).failed, []);
  });

  test("the /admin page is served", async () => {
    const r = await fetch(h.appUrl + "/admin");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Admin dashboard/);
  });
});

test("next hourly run is the next :17 in UTC", () => {
  assert.equal(nextHourlyRun(new Date("2026-11-23T05:10:00Z"), 17).toISOString(), "2026-11-23T05:17:00.000Z");
  assert.equal(nextHourlyRun(new Date("2026-11-23T05:17:00Z"), 17).toISOString(), "2026-11-23T06:17:00.000Z");
  assert.equal(nextHourlyRun(new Date("2026-11-23T23:50:00Z"), 17).toISOString(), "2026-11-24T00:17:00.000Z");
});
