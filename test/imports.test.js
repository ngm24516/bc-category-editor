// Importing Workshop mods: login required, who-asked-for-what is recorded, daily limits, and sharing work.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { insertItems, seedBaseGame } from "../server/catalog.js";
import { withUser } from "../server/db.js";
import { STEAM, startHarness } from "./helpers.js";

let h, pool, api, login;
before(async () => { h = await startHarness(); ({ pool, api, login } = h); });
after(() => h.stop());

const link = id => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
async function fresh() {
  await h.resetDb();
  await seedBaseGame(pool, () => {});
  STEAM.items.clear(); STEAM.collections.clear(); STEAM.down = false;
}
// A mod already in the catalog, as of a given Steam update time (seconds).
async function inCatalog(workshopId, name, updated) {
  const { rows: [m] } = await pool.query("INSERT INTO mods (kind, workshop_id, name) VALUES ('workshop', $1, $2) RETURNING id", [workshopId, name]);
  const { rows: [v] } = await pool.query(
    `INSERT INTO mod_versions (mod_id, label, source_updated_at, game_version, icons, item_count)
     VALUES ($1, 'v1', to_timestamp($2), '42.22', '{"tile":32,"cols":64,"perSheet":4096,"sheets":0}', 1) RETURNING id`, [m.id, updated]);
  await insertItems(pool, v.id, [["X.Item", "Item", "", "", "", -1, ""]]);
  return m.id;
}
const jobs = async () => (await pool.query("SELECT workshop_id, status, reason, requested_by FROM import_jobs ORDER BY id")).rows;

describe("importing one mod", () => {
  let alice, bob;
  beforeEach(async () => { await fresh(); alice = await login("code-alice"); bob = await login("code-bob"); });

  test("requires sign-in", async () => {
    assert.equal((await api(null, "POST", "/api/imports", { link: link("2200148440") })).status, 401);
    assert.equal((await api(null, "GET", "/api/imports")).status, 401);
  });

  test("rejects links that aren't Workshop items", async () => {
    for (const bad of ["", "hello", "https://evil.example/?id=2200148440", "javascript:alert(1)"]) {
      assert.equal((await api(alice, "POST", "/api/imports", { link: bad })).status, 400, bad);
    }
  });

  test("unknown or non-Zomboid items are refused", async () => {
    STEAM.items.set("3000000002", { title: "Some other game's mod", app: 4000 });
    assert.equal((await api(alice, "POST", "/api/imports", { link: link("3000000001") })).status, 404);
    assert.equal((await api(alice, "POST", "/api/imports", { link: "3000000002" })).status, 400);
    assert.deepEqual(await jobs(), []);
  });

  test("a new mod is queued and the request records who asked", async () => {
    STEAM.items.set("2200148440", { title: "Brita's Weapon Pack" });
    const r = await api(alice, "POST", "/api/imports", { link: link("2200148440") });
    assert.equal(r.status, 201);
    const q = await r.json();
    assert.equal(q.kind, "mod");
    assert.equal(q.title, "Brita's Weapon Pack");
    assert.deepEqual(q.items.map(i => [i.workshopId, i.status]), [["2200148440", "queued"]]);
    const { rows: [a] } = await pool.query("SELECT id FROM users WHERE username = 'alice'");
    assert.deepEqual(await jobs(), [{ workshop_id: "2200148440", status: "queued", reason: "request", requested_by: a.id }]);
  });

  test("two people asking for the same mod share one job", async () => {
    STEAM.items.set("2200148440", { title: "Brita's Weapon Pack" });
    await api(alice, "POST", "/api/imports", { link: "2200148440" });
    const r = await (await api(bob, "POST", "/api/imports", { link: "2200148440" })).json();
    assert.equal(r.items[0].status, "queued");
    assert.equal((await jobs()).length, 1);
    const lim = (await (await api(bob, "GET", "/api/imports")).json()).limits;
    assert.equal(lim.modsToday, 0, "sharing someone else's job doesn't use Bob's limit");
  });

  test("a mod already in the catalog at Steam's latest version is ready at once", async () => {
    const modId = await inCatalog("2200148440", "Brita's Weapon Pack", 1_790_000_000);
    STEAM.items.set("2200148440", { title: "Brita's Weapon Pack", updated: 1_790_000_000 });
    const r = await (await api(alice, "POST", "/api/imports", { link: "2200148440" })).json();
    assert.deepEqual(r.items.map(i => [i.status, i.modId]), [["ready", modId]]);
    assert.deepEqual(await jobs(), []);
  });

  test("a catalog mod older than Steam's version is queued for import", async () => {
    await inCatalog("2200148440", "Brita's Weapon Pack", 1_780_000_000);
    STEAM.items.set("2200148440", { title: "Brita's Weapon Pack", updated: 1_790_000_000 });
    const r = await (await api(alice, "POST", "/api/imports", { link: "2200148440" })).json();
    assert.equal(r.items[0].status, "queued");
  });

  test("ten new mods a day, then 429; admins are exempt", async () => {
    for (let i = 0; i < 12; i++) STEAM.items.set(String(3100000000 + i), { title: `Mod ${i}` });
    for (let i = 0; i < 10; i++) assert.equal((await api(alice, "POST", "/api/imports", { link: String(3100000000 + i) })).status, 201);
    const r = await api(alice, "POST", "/api/imports", { link: "3100000010" });
    assert.equal(r.status, 429);
    assert.equal((await jobs()).length, 10, "the refused request queued nothing");
    const admin = await login("code-admin");
    assert.equal((await api(admin, "POST", "/api/imports", { link: "3100000011" })).status, 201);
  });

  test("Steam being down is a clear 502", async () => {
    STEAM.down = true;
    const r = await api(alice, "POST", "/api/imports", { link: "2200148440" });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, "steam_unavailable");
  });
});

describe("importing a collection", () => {
  let alice;
  beforeEach(async () => {
    await fresh(); alice = await login("code-alice");
    await inCatalog("3200000001", "Already here", 1_790_000_000);
    STEAM.items.set("3200000000", { title: "My server's mods" });
    STEAM.items.set("3200000001", { title: "Already here", updated: 1_790_000_000 });
    STEAM.items.set("3200000002", { title: "New one" });
    STEAM.items.set("3200000003", { title: "Not Zomboid", app: 4000 });
    STEAM.collections.set("3200000000", ["3200000001", "3200000002", "3200000003", "3200000004"]);
  });

  test("lists what's in the catalog, queues what's missing, explains what's skipped", async () => {
    const r = await (await api(alice, "POST", "/api/imports", { link: link("3200000000") })).json();
    assert.equal(r.kind, "collection");
    assert.equal(r.title, "My server's mods");
    const by = Object.fromEntries(r.items.map(i => [i.workshopId, i]));
    assert.equal(by["3200000001"].status, "ready");
    assert.equal(by["3200000002"].status, "queued");
    assert.equal(by["3200000003"].status, "skipped");
    assert.match(by["3200000003"].message, /Not a Project Zomboid mod/);
    assert.equal(by["3200000004"].status, "skipped");
    assert.deepEqual((await jobs()).map(j => j.workshop_id), ["3200000002"]);
  });

  test("one collection a day", async () => {
    assert.equal((await api(alice, "POST", "/api/imports", { link: "3200000000" })).status, 201);
    assert.equal((await api(alice, "POST", "/api/imports", { link: "3200000000" })).status, 429);
  });
});

describe("import status, privacy and the admin log", () => {
  let alice, bob, request;
  beforeEach(async () => {
    await fresh(); alice = await login("code-alice"); bob = await login("code-bob");
    STEAM.items.set("2200148440", { title: "Brita's Weapon Pack" });
    request = await (await api(alice, "POST", "/api/imports", { link: "2200148440" })).json();
  });

  test("status follows the job: done with a version = ready, failed shows its reason", async () => {
    const { rows: [m] } = await pool.query("INSERT INTO mods (kind, workshop_id, name) VALUES ('workshop', '2200148440', 'Brita') RETURNING id");
    await pool.query("UPDATE import_jobs SET status = 'done', mod_id = $1", [m.id]);
    let r = await (await api(alice, "GET", `/api/imports/${request.id}`)).json();
    assert.deepEqual([r.items[0].status, r.items[0].modId], ["ready", m.id]);
    await pool.query("UPDATE import_jobs SET status = 'failed', mod_id = NULL, error = 'No Build 42 mod in this Workshop item'");
    r = await (await api(alice, "GET", `/api/imports/${request.id}`)).json();
    assert.equal(r.items[0].status, "failed");
    assert.match(r.items[0].message, /Build 42/);
  });

  test("users only see their own requests, through the API and in the database", async () => {
    assert.equal((await api(bob, "GET", `/api/imports/${request.id}`)).status, 404);
    assert.deepEqual((await (await api(bob, "GET", "/api/imports")).json()).requests, []);
    const { rows: [b] } = await pool.query("SELECT id FROM users WHERE username = 'bob'");
    const seen = await withUser(pool, b.id, async db => (await db.query("SELECT * FROM import_request_items")).rowCount);
    assert.equal(seen, 0);
  });

  test("only admins can read the import log, which names who asked", async () => {
    assert.equal((await api(alice, "GET", "/api/admin/imports")).status, 403);
    const admin = await login("code-admin");
    const log = await (await api(admin, "GET", "/api/admin/imports")).json();
    assert.equal(log.length, 1);
    assert.equal(log[0].requestedBy.username, "alice");
    assert.equal(log[0].title, "Brita's Weapon Pack");
  });

  test("the catalog shows who first added a mod", async () => {
    const { rows: [a] } = await pool.query("SELECT id FROM users WHERE username = 'alice'");
    const { rows: [m] } = await pool.query("INSERT INTO mods (kind, workshop_id, name, created_by) VALUES ('workshop', '2200148440', 'Brita', $1) RETURNING id", [a.id]);
    await pool.query(`INSERT INTO mod_versions (mod_id, label, game_version, icons) VALUES ($1, 'v1', '42.22', '{"sheets":0}')`, [m.id]);
    const found = await (await api(null, "GET", "/api/catalog/mods?q=brita")).json();
    assert.equal(found[0].addedBy, "Alice");
  });
});
