// Marketplaces: admins add them (checked against a fake marketplace), users choose one (RLS),
// prices are average / low / high over the recorded history, for library items only.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { firstPageUrl } from "../server/market.js";
import { getJsonSafely, isPublicAddress } from "../server/safe-fetch.js";
import { startHarness } from "./helpers.js";

let h, pool, api, login, market, marketUrl;
const MARKET = { status: 200, body: null, requests: [] };

before(async () => {
  h = await startHarness(); ({ pool, api, login } = h);
  market = http.createServer((req, res) => {
    MARKET.requests.push(req.url);
    res.writeHead(MARKET.status, { "Content-Type": "application/json" });
    res.end(typeof MARKET.body === "string" ? MARKET.body : JSON.stringify(MARKET.body));
  });
  await new Promise(r => market.listen(0, "127.0.0.1", r));
  marketUrl = `http://127.0.0.1:${market.address().port}/portal/marketplace?search=&shop=&sort=newest&page=1&pageSize=30`;
});
after(() => { market.close(); return h.stop(); });

const listing = (id, ft, price) => ({ listing_id: id, full_type: ft, price, quantity: 1, shop_name: "Shop" });

describe("marketplaces", () => {
  let admin, alice, bob;
  beforeEach(async () => {
    await h.resetDb();
    admin = await login("code-admin"); alice = await login("code-alice"); bob = await login("code-bob");
    MARKET.status = 200; MARKET.requests = [];
    MARKET.body = { total: 2, meta: { snapshot_updated_at: 1795460182 }, listings: [listing("l1", "Base.Axe", 120), listing("l2", "Base.Hammer", 15)] };
  });

  async function addMarket(name = "OneLife", url = marketUrl) {
    const r = await api(admin, "POST", "/api/admin/markets", { name, url });
    return { status: r.status, body: await r.json() };
  }

  test("only admins can add, change or remove marketplaces", async () => {
    assert.equal((await api(null, "POST", "/api/admin/markets", { name: "x", url: marketUrl })).status, 401);
    assert.equal((await api(alice, "POST", "/api/admin/markets", { name: "x", url: marketUrl })).status, 403);
    assert.equal((await api(alice, "GET", "/api/admin/markets")).status, 403);
    const { body: m } = await addMarket();
    assert.equal((await api(alice, "PATCH", `/api/admin/markets/${m.id}`, { enabled: false })).status, 403);
    assert.equal((await api(alice, "DELETE", `/api/admin/markets/${m.id}`)).status, 403);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplaces")).rows[0].n, 1);
  });

  test("adding checks the address answers like a marketplace, asking for page 1 of 100", async () => {
    const { status, body } = await addMarket();
    assert.equal(status, 201);
    assert.equal(body.name, "OneLife");
    assert.equal(body.sample.length, 2);
    assert.match(MARKET.requests[0], /[?&]page=1(&|$)/);
    assert.match(MARKET.requests[0], /[?&]pageSize=100(&|$)/);
    assert.equal((await addMarket("Again")).status, 409);

    MARKET.body = { hello: "world" };
    assert.equal((await addMarket("Not one", marketUrl + "&x=1")).body.error, "not_a_marketplace");
    MARKET.body = { listings: [{ name: "Axe", cost: 3 }] };
    assert.equal((await addMarket("Wrong shape", marketUrl + "&x=2")).body.error, "not_a_marketplace");
    MARKET.status = 500;
    assert.equal((await addMarket("Down", marketUrl + "&x=3")).body.error, "unreachable");
    assert.equal((await addMarket("Bad", "not a url")).status, 400);
  });

  test("outside tests, only public https addresses are fetched", async () => {
    for (const url of ["http://example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/metadata/instance",
      "https://10.0.0.5/x", "https://[::1]/x", "https://user:pw@example.com/x"]) {
      await assert.rejects(getJsonSafely(url), /https|private|local|user name/i, url);
    }
    assert.equal(isPublicAddress("8.8.8.8"), true);
    assert.equal(isPublicAddress("::ffff:10.0.0.1"), false);
    assert.equal(firstPageUrl("https://a.example/portal/marketplace?search=&shop=s1&page=4&pageSize=30"),
      "https://a.example/portal/marketplace?search=&shop=s1&page=1&pageSize=100&sort=newest");
  });

  test("each user chooses a marketplace; nobody else sees or changes that choice", async () => {
    const { body: m } = await addMarket();
    let r = await (await api(null, "GET", "/api/markets")).json();
    assert.deepEqual([r.markets.map(x => x.name), r.choice], [["OneLife"], null]);
    assert.equal(r.markets[0].url, undefined, "the API address is for admins only");
    assert.equal((await api(null, "PUT", "/api/markets/choice", { marketplaceId: m.id })).status, 401);
    assert.equal((await api(alice, "PUT", "/api/markets/choice", { marketplaceId: m.id })).status, 200);
    assert.equal((await (await api(alice, "GET", "/api/markets")).json()).choice, m.id);
    assert.equal((await (await api(bob, "GET", "/api/markets")).json()).choice, null, "alice's choice isn't bob's");
    assert.equal((await api(bob, "PUT", "/api/markets/choice", { marketplaceId: "00000000-0000-0000-0000-000000000000" })).status, 404);
    assert.equal((await api(bob, "PUT", "/api/markets/choice", { marketplaceId: "nope" })).status, 400);
    assert.equal((await api(alice, "PUT", "/api/markets/choice", { marketplaceId: null })).status, 200);
    assert.equal((await (await api(alice, "GET", "/api/markets")).json()).choice, null);
    // The table itself is protected by row-level security, not only by the API.
    await api(alice, "PUT", "/api/markets/choice", { marketplaceId: m.id });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM user_marketplaces");
    assert.equal(rows[0].n, 0, "without app.user_id set, no rows are visible");
  });

  test("overpriced listings are left out: placeholder prices and far-above-median ones; admins can change the rules", async () => {
    const { body: m } = await addMarket();
    const { rows: [mod] } = await pool.query("INSERT INTO mods (kind, name) VALUES ('base', 'Project Zomboid') RETURNING id");
    const { rows: [v] } = await pool.query(
      `INSERT INTO mod_versions (mod_id, label, game_version, icons) VALUES ($1, 'b', '42', '{}') RETURNING id`, [mod.id]);
    await pool.query(`INSERT INTO catalog_items (version_id, full_type, name) VALUES
      ($1, 'Base.Leek', 'Leek'), ($1, 'Base.Journal', 'Journal'), ($1, 'Base.IDCard', 'ID Card'), ($1, 'Base.Seeds', 'Seeds')`, [v.id]);
    await pool.query(`INSERT INTO market_listings (marketplace_id, listing_id, price, full_type, owner_name, last_seen) VALUES
      ($1, 'k1', 1, 'Base.Leek', 'a', now()), ($1, 'k2', 1, 'Base.Leek', 'b', now()), ($1, 'k3', 2, 'Base.Leek', 'c', now()),
      ($1, 'k4', 1000, 'Base.Leek', 'Stak', now()),
      ($1, 'j1', 100, 'Base.Journal', 'x', now()), ($1, 'j2', 99999, 'Base.Journal', 'chuckey', now()),
      ($1, 'i1', 99999, 'Base.IDCard', 'drmilkjug', now()),
      ($1, 's1', 1, 'Base.Seeds', 'x', now()), ($1, 's2', 1, 'Base.Seeds', 'y', now()), ($1, 's3', 10, 'Base.Seeds', 'z', now())`, [m.id]);
    await pool.query("UPDATE marketplaces SET last_crawl_at = (SELECT max(last_seen) FROM market_listings) WHERE id = $1", [m.id]);
    let p = (await (await api(null, "GET", `/api/markets/${m.id}/prices`)).json()).items;
    assert.deepEqual(p["Base.Leek"].slice(0, 4).concat(p["Base.Leek"][7]), [1.33, 1, 2, 3, 1], "1000 is over 10x the median of 1.5");
    assert.deepEqual([p["Base.Journal"][0], p["Base.Journal"][7]], [100, 1], "99,999 is a placeholder");
    assert.equal(p["Base.IDCard"], undefined, "only a placeholder listing: no price at all");
    assert.deepEqual(p["Base.Seeds"].slice(0, 3), [4, 1, 10], "10 vs 1 is under the 100 floor: kept");
    // Admins can change or turn off the rules; others can't.
    assert.equal((await api(alice, "PATCH", `/api/admin/markets/${m.id}`, { ignoreAt: null })).status, 403);
    assert.equal((await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { ignoreAt: -1 })).status, 400);
    assert.equal((await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { outlierFactor: 1 })).status, 400);
    const r = await (await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { ignoreAt: null, outlierFactor: 0 })).json();
    assert.deepEqual([r.ignoreAt, r.outlierFactor], [null, 0]);
    p = (await (await api(null, "GET", `/api/markets/${m.id}/prices`)).json()).items;
    assert.deepEqual([p["Base.Leek"][2], p["Base.Journal"][2], p["Base.IDCard"][0]], [1000, 99999, 99999], "rules off: everything counts");
  });

  test("an admin keeps the game server's economy settings with its marketplace; everyone gets them", async () => {
    const { body: m } = await addMarket();
    const set = { SellValuePercent: 200, PreciousMetalsSellValuePercent: 35, BandMinCrystalMeth: 350, EnableMeth: 1 };
    assert.equal((await api(alice, "PATCH", `/api/admin/markets/${m.id}`, { economySettings: set })).status, 403);
    for (const bad of [{ HubX: 3 }, { SellValuePercent: "200" }, { SellValuePercent: -1 }, [1], "x"]) {
      assert.equal((await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { economySettings: bad })).status, 400, JSON.stringify(bad));
    }
    const r = await (await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { economySettings: set })).json();
    assert.deepEqual(r.economySettings, set);
    const list = await (await api(null, "GET", "/api/markets")).json();
    assert.deepEqual(list.markets.find(x => x.id === m.id).economySettings, set, "signed out too: they're the server's, not a user's");
    await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { economySettings: null });
    assert.equal((await (await api(null, "GET", "/api/markets")).json()).markets.find(x => x.id === m.id).economySettings, null);
  });

  test("prices: average, low and high over every recorded listing price, library items only", async () => {
    const { body: m } = await addMarket();
    const { rows: [mod] } = await pool.query("INSERT INTO mods (kind, name) VALUES ('base', 'Project Zomboid') RETURNING id");
    const { rows: [v] } = await pool.query(
      `INSERT INTO mod_versions (mod_id, label, game_version, icons) VALUES ($1, 'b', '42', '{}') RETURNING id`, [mod.id]);
    await pool.query("INSERT INTO catalog_items (version_id, full_type, name) VALUES ($1, 'Base.Axe', 'Axe'), ($1, 'Base.Hammer', 'Hammer')", [v.id]);
    await pool.query(`INSERT INTO market_listings (marketplace_id, listing_id, price, full_type) VALUES
      ($1, 'l1', 100, 'Base.Axe'), ($1, 'l1', 130, 'Base.Axe'), ($1, 'l2', 40, 'Base.Axe'),
      ($1, 'l3', 15, 'Base.Hammer'), ($1, 'l4', 999, 'Base.NotInTheLibrary')`, [m.id]);
    let p = await (await api(null, "GET", `/api/markets/${m.id}/prices`)).json();
    assert.deepEqual(p.items, { "Base.Axe": [90, 40, 130, 3, null, null, null, 0, null], "Base.Hammer": [15, 15, 15, 1, null, null, null, 0, null] },
      "no full read yet: no current price");
    // A full read at time T: l1 (130, Bob) and l2 is gone; l5 (110, Alice) is new. Current lowest = 110 by Alice.
    await pool.query("UPDATE marketplaces SET last_crawl_at = '2026-11-25T00:00:00.123456Z' WHERE id = $1", [m.id]);
    await pool.query(`UPDATE market_listings SET last_seen = '2026-11-25T00:00:00.123456Z', owner_name = 'Bob', shop_name = 'Bob''s'
                       WHERE listing_id = 'l1' AND price = 130`);
    await pool.query(`INSERT INTO market_listings (marketplace_id, listing_id, price, full_type, quantity, owner_name, shop_name, last_seen)
                      VALUES ($1, 'l5', 110, 'Base.Axe', 3, 'Alice', 'Alice''s', '2026-11-25T00:00:00.123456Z'),
                             ($1, 'l6', 110, 'Base.Axe', 2, 'Zed', 'Zed''s', '2026-11-25T00:00:00.123456Z')`, [m.id]);
    p = await (await api(null, "GET", `/api/markets/${m.id}/prices`)).json();
    assert.deepEqual(p.items["Base.Axe"], [98, 40, 130, 5, 110, "Alice", "Alice's", 0, 5], "5 listed now at 110, in two listings");
    assert.deepEqual(p.items["Base.Hammer"].slice(4), [null, null, null, 0, null], "not listed now");
    await api(admin, "PATCH", `/api/admin/markets/${m.id}`, { enabled: false });
    assert.equal((await api(null, "GET", `/api/markets/${m.id}/prices`)).status, 404, "a disabled marketplace isn't served");
    const list = await (await api(admin, "GET", "/api/admin/markets")).json();
    assert.deepEqual([list.markets[0].items, list.markets[0].history], [2, 7]);
    assert.equal((await api(admin, "DELETE", `/api/admin/markets/${m.id}`)).status, 204);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM market_listings")).rows[0].n, 0, "history goes with it");
  });
});
