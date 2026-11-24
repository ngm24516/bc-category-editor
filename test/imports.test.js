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
  STEAM.items.clear(); STEAM.collections.clear(); STEAM.pages.clear(); STEAM.down = false;
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

  test("a removed item gets a message that says so", async () => {
    STEAM.items.set("3000000003", { title: "Gone", banned: true });
    const r = await api(alice, "POST", "/api/imports", { link: "3000000003" });
    assert.equal(r.status, 410);
    assert.match((await r.json()).message, /Steam has removed this Workshop item/);
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

  test("a collection Steam removed still imports, if Steam lists its items", async () => {
    STEAM.items.set("3200000000", { title: "One/Life - Season 3", banned: true });
    STEAM.items.set("3200000005", { title: "Removed mod", banned: true });
    STEAM.collections.set("3200000000", ["3200000002", "3200000005"]);
    const r = await api(alice, "POST", "/api/imports", { link: link("3200000000") });
    assert.equal(r.status, 201);
    const q = await r.json();
    assert.equal(q.title, "One/Life - Season 3");
    const by = Object.fromEntries(q.items.map(i => [i.workshopId, i]));
    assert.equal(by["3200000002"].status, "queued");
    assert.equal(by["3200000005"].status, "skipped");
    assert.match(by["3200000005"].message, /Removed by Steam/);
  });

  test("a collection Steam hides from its API is read from its public page", async () => {
    // Removed collections: the API answers "no such item" and lists nothing, but the page still shows the mods.
    STEAM.items.delete("3200000000");
    STEAM.collections.delete("3200000000");
    const item = id => `<div class="collectionItem" id="sharedfile_${id}"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${id}">x</a></div>`;
    STEAM.pages.set("3200000000", `<html><head><title>Steam Workshop::One/Life - Season 3 &amp; more</title></head><body>
      <div class="workshopItemTitle">One/Life - Season 3</div>
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3999999999">another collection in the sidebar</a>
      <div class="collectionChildren">${["3200000001", "3200000002", "3200000003", "3200000002"].map(item).join("")}</div>
    </body></html>`);
    const r = await api(alice, "POST", "/api/imports", { link: link("3200000000") });
    assert.equal(r.status, 201);
    const q = await r.json();
    assert.equal(q.kind, "collection");
    assert.equal(q.title, "One/Life - Season 3 & more");
    assert.deepEqual(q.items.map(i => [i.workshopId, i.status]).sort(),
      [["3200000001", "ready"], ["3200000002", "queued"], ["3200000003", "skipped"]]);
    assert.deepEqual((await jobs()).map(j => j.workshop_id), ["3200000002"]);
  });

  test("a public mod Steam's API calls missing is read from its change-notes page", async () => {
    // Steam's API answers "result 9" for some public mods (e.g. Riku Emporium B42, 3623584152).
    STEAM.pages.set("changelog/3623584152", `<html><a href="https://steamcommunity.com/app/108600">Project Zomboid</a>
      <div class="workshopItemTitle">Riku Emporium B42</div>
      <div class="detailBox workshopAnnouncement noFooter changeLogCtn"><div class="changelog headline">Update: Nov 12 @ 8:31am</div><p id="1794501087"></p></div>
      <div class="detailBox workshopAnnouncement noFooter changeLogCtn"><p id="1791972199"></p></div></html>`);
    const r = await api(alice, "POST", "/api/imports", { link: link("3623584152") });
    assert.equal(r.status, 201);
    const q = await r.json();
    assert.equal(q.title, "Riku Emporium B42");
    assert.deepEqual(q.items.map(i => [i.workshopId, i.status]), [["3623584152", "queued"]]);
    const { rows: [job] } = await pool.query("SELECT title, source_updated_at FROM import_jobs");
    assert.equal(job.title, "Riku Emporium B42");
    assert.equal(new Date(job.source_updated_at).getTime(), 1794501087 * 1000);
  });

  test("a page for another game is still refused", async () => {
    STEAM.pages.set("changelog/3623584153", `<a href="https://steamcommunity.com/app/4000">Garry's Mod</a><div class="workshopItemTitle">Prop pack</div>`);
    const r = await api(alice, "POST", "/api/imports", { link: link("3623584153") });
    assert.equal(r.status, 400);
  });

  test("an item that is neither public nor a listed collection is still a clear 404", async () => {
    const r = await api(alice, "POST", "/api/imports", { link: link("3299999999") });
    assert.equal(r.status, 404);
    assert.match((await r.json()).message, /no public Workshop item/);
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
