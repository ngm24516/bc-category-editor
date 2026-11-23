// The shared catalog: base-game seed, catalog API, and setups that choose mods.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { insertItems, seedBaseGame } from "../server/catalog.js";
import { withUser } from "../server/db.js";
import { startHarness } from "./helpers.js";

let h, pool, api, login;
before(async () => { h = await startHarness(); ({ pool, api, login } = h); });
after(() => h.stop());

async function fresh() {
  await h.resetDb();
  await seedBaseGame(pool, () => {});
}

// A fake imported Workshop mod with one version.
async function addMod(workshopId, name, items) {
  const { rows: [m] } = await pool.query("INSERT INTO mods (kind, workshop_id, name) VALUES ('workshop', $1, $2) RETURNING id", [workshopId, name]);
  const { rows: [v] } = await pool.query(
    `INSERT INTO mod_versions (mod_id, label, game_version, icons, item_count)
     VALUES ($1, '2026-11-01', '42.22', '{"tile":32,"cols":64,"perSheet":4096,"sheets":0}', $2) RETURNING id`, [m.id, items.length]);
  await insertItems(pool, v.id, items);
  return { modId: m.id, versionId: v.id };
}

describe("base game seed", () => {
  beforeEach(fresh);

  test("is loaded once, and loading again is a no-op", async () => {
    assert.equal(await seedBaseGame(pool, () => {}), false);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM mod_versions");
    assert.equal(rows[0].n, 1);
  });

  test("/api/catalog/base describes it, signed out too", async () => {
    const base = await (await api(null, "GET", "/api/catalog/base")).json();
    assert.equal(base.kind, "base");
    assert.match(base.label, /^Build 42\./);
    assert.ok(base.itemCount > 4000);
  });

  test("a version returns items, category names and icon layout, cached as immutable", async () => {
    const base = await (await api(null, "GET", "/api/catalog/base")).json();
    const r = await api(null, "GET", `/api/catalog/versions/${base.versionId}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /immutable/);
    const v = await r.json();
    const axe = v.items.find(i => i[0] === "Base.Axe");
    assert.ok(axe, "Base.Axe is in the base game");
    assert.equal(axe.length, 7);
    assert.ok(axe[5] >= 0, "Base.Axe has an icon tile");
    assert.ok(Object.keys(v.catNames).length > 50);
    assert.equal(v.icons.tile, 32);
  });

  test("icon sheets are served as WebP", async () => {
    const base = await (await api(null, "GET", "/api/catalog/base")).json();
    const r = await api(null, "GET", `/api/catalog/versions/${base.versionId}/icons/0.webp`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/webp");
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal((await api(null, "GET", `/api/catalog/versions/${base.versionId}/icons/99.webp`)).status, 404);
  });

  test("unknown versions are 404", async () => {
    assert.equal((await api(null, "GET", "/api/catalog/versions/00000000-0000-0000-0000-000000000000")).status, 404);
    assert.equal((await api(null, "GET", "/api/catalog/versions/not-a-uuid")).status, 404);
  });
});

describe("mod search", () => {
  let brita, guns;
  beforeEach(async () => {
    await fresh();
    brita = await addMod("2200148440", "Brita's Weapon Pack", [["Base.BritaGun", "Brita Gun", "Weapon", "WepFire", "weapon", -1, ""]]);
    guns = await addMod("3000000001", "Gun Stores", []);
  });

  test("by name, case-insensitive", async () => {
    const r = await (await api(null, "GET", "/api/catalog/mods?q=brita")).json();
    assert.deepEqual(r.map(m => m.name), ["Brita's Weapon Pack"]);
    assert.equal(r[0].workshopId, "2200148440");
    assert.equal(r[0].versionId, brita.versionId);
  });

  test("by Workshop id or link", async () => {
    const r = await (await api(null, "GET", "/api/catalog/mods?q=" + encodeURIComponent("https://steamcommunity.com/sharedfiles/filedetails/?id=3000000001"))).json();
    assert.deepEqual(r.map(m => m.id), [guns.modId]);
  });

  test("empty search lists everything; the base game is never listed", async () => {
    const r = await (await api(null, "GET", "/api/catalog/mods?q=")).json();
    assert.deepEqual(r.map(m => m.name).sort(), ["Brita's Weapon Pack", "Gun Stores"]);
  });

  test("SQL wildcards in the search are treated as text", async () => {
    assert.deepEqual(await (await api(null, "GET", "/api/catalog/mods?q=%25")).json(), []);
  });

  test("lookup by ids", async () => {
    const r = await (await api(null, "GET", `/api/catalog/mods?ids=${guns.modId},${brita.modId},junk`)).json();
    assert.equal(r.length, 2);
  });
});

describe("setups choose mods", () => {
  let alice, bob, brita, guns;
  const base = { name: "OneLife", overrides: {}, definitions: {} };
  beforeEach(async () => {
    await fresh();
    alice = await login("code-alice"); bob = await login("code-bob");
    brita = await addMod("2200148440", "Brita's Weapon Pack", []);
    guns = await addMod("3000000001", "Gun Stores", []);
  });

  test("a new setup has no mods unless given some", async () => {
    const s = await (await api(alice, "POST", "/api/sets", base)).json();
    assert.deepEqual(s.mods, []);
  });

  test("mods keep their order", async () => {
    const s = await (await api(alice, "POST", "/api/sets", { ...base, mods: [guns.modId, brita.modId] })).json();
    assert.deepEqual(s.mods, [guns.modId, brita.modId]);
    const u = await (await api(alice, "PUT", `/api/sets/${s.id}`, { version: s.version, overrides: {}, definitions: {}, mods: [brita.modId, guns.modId] })).json();
    assert.deepEqual(u.mods, [brita.modId, guns.modId]);
    const list = await (await api(alice, "GET", "/api/sets")).json();
    assert.equal(list[0].modCount, 2);
  });

  test("PUT without mods leaves them as they are", async () => {
    const s = await (await api(alice, "POST", "/api/sets", { ...base, mods: [guns.modId] })).json();
    const u = await (await api(alice, "PUT", `/api/sets/${s.id}`, { version: s.version, overrides: { "Base.Axe": "X" }, definitions: {} })).json();
    assert.deepEqual(u.mods, [guns.modId]);
  });

  test("unknown, duplicate or malformed mod ids are refused", async () => {
    const { rows: [b] } = await pool.query("SELECT id FROM mods WHERE kind = 'base'");
    for (const mods of [["00000000-0000-0000-0000-000000000000"], [guns.modId, guns.modId], ["nope"], "x", [b.id]]) {
      assert.equal((await api(alice, "POST", "/api/sets", { ...base, mods })).status, 400, JSON.stringify(mods));
    }
  });

  test("Bob can't see Alice's mod choices, even with raw SQL", async () => {
    await api(alice, "POST", "/api/sets", { ...base, mods: [guns.modId] });
    const { rows: [b] } = await pool.query("SELECT id FROM users WHERE username = 'bob'");
    const n = await withUser(pool, b.id, db => db.query("SELECT * FROM set_mods"));
    assert.equal(n.rowCount, 0);
    assert.deepEqual(await (await api(bob, "GET", "/api/sets")).json(), []);
  });
});
