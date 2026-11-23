// End-to-end API tests against a real Postgres and a fake Discord.
// Needs TEST_DATABASE_URL pointing at an empty database the tests may wipe
// (CI provides one; locally: docker compose up -d db, see README).
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import pg from "pg";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createPool, withUser } from "../server/db.js";
import { migrate } from "../server/migrate.js";

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error("Set TEST_DATABASE_URL to an empty Postgres database the tests may wipe");

// ---- fake Discord: each authorization code maps to a Discord user
const DISCORD_USERS = {
  "code-alice": { id: "100000000000000001", username: "alice", global_name: "Alice", avatar: "a1" },
  "code-bob": { id: "100000000000000002", username: "bob", global_name: null, avatar: null },
  "code-admin": { id: "100000000000000099", username: "nate", global_name: "Nate", avatar: null },
};
let discord, discordUrl, app, appUrl, pool;

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function resetDb() {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(DB_URL, () => {});
}

before(async () => {
  discord = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/oauth2/token" && req.method === "POST") {
        const p = new URLSearchParams(body);
        if (p.get("client_secret") !== "test-secret" || !DISCORD_USERS[p.get("code")]) { res.statusCode = 400; return res.end("{}"); }
        return res.end(JSON.stringify({ access_token: "tok-" + p.get("code"), token_type: "Bearer" }));
      }
      if (req.url === "/api/users/@me") {
        const code = String(req.headers.authorization || "").replace("Bearer tok-", "");
        if (!DISCORD_USERS[code]) { res.statusCode = 401; return res.end("{}"); }
        return res.end(JSON.stringify(DISCORD_USERS[code]));
      }
      if (req.url === "/api/oauth2/token/revoke") return res.end("{}");
      res.statusCode = 404; res.end("{}");
    });
  });
  discordUrl = await listen(discord);

  await resetDb();
  pool = createPool(DB_URL);
  const server = http.createServer();
  appUrl = await listen(server);
  const config = loadConfig({
    PUBLIC_URL: appUrl, DATABASE_URL: DB_URL,
    DISCORD_CLIENT_ID: "test-client", DISCORD_CLIENT_SECRET: "test-secret",
    DISCORD_API_BASE: discordUrl + "/api", DISCORD_AUTHORIZE_URL: discordUrl + "/oauth2/authorize",
    ADMIN_DISCORD_IDS: "100000000000000099",
  });
  app = createApp({ pool, config });
  server.on("request", app);
  app.server = server;
});

after(async () => {
  app.server.close(); discord.close();
  await pool.end();
});

// ---- helpers
function cookiesFrom(res) {
  return res.headers.getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
}
async function login(code) {
  const start = await fetch(appUrl + "/auth/discord/login", { redirect: "manual" });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get("location"));
  assert.equal(loc.searchParams.get("scope"), "identify");
  assert.equal(loc.searchParams.get("redirect_uri"), appUrl + "/auth/discord/callback");
  const state = loc.searchParams.get("state");
  const cb = await fetch(`${appUrl}/auth/discord/callback?code=${code}&state=${state}`,
    { redirect: "manual", headers: { cookie: cookiesFrom(start).join("; ") } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/?login=ok");
  const session = cookiesFrom(cb).find(c => c.startsWith("bc_session="));
  assert.ok(session, "session cookie set");
  return session;
}
function api(session, method, path, body, extra = {}) {
  return fetch(appUrl + path, {
    method,
    headers: { ...(session ? { cookie: session } : {}), ...(body ? { "content-type": "application/json" } : {}), origin: appUrl, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const SAMPLE = {
  name: "OneLife",
  blacklist: "Lore",
  overrides: { "Base.Axe": "BC_Custom_ValZom_Weapon", "Base.Katana": "BC_Custom_ValZom_Weapon" },
  definitions: { BC_Custom_ValZom_Weapon: "ValZom - Weapon" },
};

describe("health", () => {
  test("liveness and readiness", async () => {
    assert.equal((await fetch(appUrl + "/healthz")).status, 200);
    assert.equal((await fetch(appUrl + "/readyz")).status, 200);
  });
  test("serves the editor page", async () => {
    const r = await fetch(appUrl + "/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Better Containers Category Editor/);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  });
});

describe("identity", () => {
  beforeEach(resetDb);

  test("signed out: /api/me is 401", async () => {
    assert.equal((await api(null, "GET", "/api/me")).status, 401);
  });

  test("Discord login creates the user and a working session", async () => {
    const s = await login("code-alice");
    const me = await (await api(s, "GET", "/api/me")).json();
    assert.equal(me.username, "alice");
    assert.equal(me.displayName, "Alice");
    assert.equal(me.role, "user");
    assert.match(me.avatarUrl, /cdn\.discordapp\.com\/avatars\/100000000000000001\/a1\.png/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
    assert.equal(rows[0].n, 1);
  });

  test("logging in again reuses the same user", async () => {
    await login("code-alice"); await login("code-alice");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
    assert.equal(rows[0].n, 1);
  });

  test("admins come from ADMIN_DISCORD_IDS", async () => {
    const s = await login("code-admin");
    assert.equal((await (await api(s, "GET", "/api/me")).json()).role, "admin");
  });

  test("callback with a wrong state is refused", async () => {
    const start = await fetch(appUrl + "/auth/discord/login", { redirect: "manual" });
    const r = await fetch(`${appUrl}/auth/discord/callback?code=code-alice&state=forged`,
      { redirect: "manual", headers: { cookie: cookiesFrom(start).join("; ") } });
    assert.equal(r.headers.get("location"), "/?login=expired");
    assert.ok(!cookiesFrom(r).some(c => c.startsWith("bc_session=")));
  });

  test("callback without the state cookie is refused", async () => {
    const r = await fetch(`${appUrl}/auth/discord/callback?code=code-alice&state=abc`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), "/?login=expired");
  });

  test("a code Discord rejects does not sign in", async () => {
    const start = await fetch(appUrl + "/auth/discord/login", { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const r = await fetch(`${appUrl}/auth/discord/callback?code=bogus&state=${state}`,
      { redirect: "manual", headers: { cookie: cookiesFrom(start).join("; ") } });
    assert.equal(r.headers.get("location"), "/?login=discord");
  });

  test("only a hash of the session token is stored", async () => {
    const s = await login("code-alice");
    const token = decodeURIComponent(s.split("=")[1]);
    const { rows } = await pool.query("SELECT token_hash FROM sessions");
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash.toString("base64url"), token);
  });

  test("logout ends the session", async () => {
    const s = await login("code-alice");
    assert.equal((await api(s, "POST", "/auth/logout")).status, 204);
    assert.equal((await api(s, "GET", "/api/me")).status, 401);
  });

  test("expired sessions are not accepted", async () => {
    const s = await login("code-alice");
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    assert.equal((await api(s, "GET", "/api/me")).status, 401);
  });
});

describe("category sets", () => {
  let alice, bob;
  beforeEach(async () => { await resetDb(); alice = await login("code-alice"); bob = await login("code-bob"); });

  test("signed out cannot use the API", async () => {
    assert.equal((await api(null, "GET", "/api/sets")).status, 401);
    assert.equal((await api(null, "POST", "/api/sets", SAMPLE)).status, 401);
  });

  test("create, list, read", async () => {
    const created = await api(alice, "POST", "/api/sets", SAMPLE);
    assert.equal(created.status, 201);
    const set = await created.json();
    assert.equal(set.version, 1);
    assert.deepEqual(set.overrides, SAMPLE.overrides);
    assert.deepEqual(set.definitions, SAMPLE.definitions);

    const list = await (await api(alice, "GET", "/api/sets")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].overrideCount, 2);
    assert.equal(list[0].definitionCount, 1);

    const read = await (await api(alice, "GET", `/api/sets/${set.id}`)).json();
    assert.deepEqual(read.overrides, SAMPLE.overrides);
  });

  test("update replaces contents and bumps the version", async () => {
    const set = await (await api(alice, "POST", "/api/sets", SAMPLE)).json();
    const r = await api(alice, "PUT", `/api/sets/${set.id}`,
      { version: 1, overrides: { "Base.Pan": "Cooking" }, definitions: {}, blacklist: "Lore, Junk" });
    assert.equal(r.status, 200);
    const upd = await r.json();
    assert.equal(upd.version, 2);
    assert.deepEqual(upd.overrides, { "Base.Pan": "Cooking" });
    assert.deepEqual(upd.definitions, {});
    assert.equal(upd.blacklist, "Lore, Junk");
    assert.equal(upd.name, "OneLife");
  });

  test("a stale version gets 409 instead of overwriting", async () => {
    const set = await (await api(alice, "POST", "/api/sets", SAMPLE)).json();
    await api(alice, "PUT", `/api/sets/${set.id}`, { version: 1, overrides: {}, definitions: {} });
    const r = await api(alice, "PUT", `/api/sets/${set.id}`, { version: 1, overrides: { "Base.Pan": "X" }, definitions: {} });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).currentVersion, 2);
  });

  test("PUT without the full lists is refused, so nothing is wiped by accident", async () => {
    const set = await (await api(alice, "POST", "/api/sets", SAMPLE)).json();
    assert.equal((await api(alice, "PUT", `/api/sets/${set.id}`, { version: 1, name: "Renamed" })).status, 400);
    const read = await (await api(alice, "GET", `/api/sets/${set.id}`)).json();
    assert.deepEqual(read.overrides, SAMPLE.overrides);
  });

  test("duplicate names are refused per user, allowed across users", async () => {
    await api(alice, "POST", "/api/sets", SAMPLE);
    assert.equal((await api(alice, "POST", "/api/sets", SAMPLE)).status, 409);
    assert.equal((await api(bob, "POST", "/api/sets", SAMPLE)).status, 201);
  });

  test("delete", async () => {
    const set = await (await api(alice, "POST", "/api/sets", SAMPLE)).json();
    assert.equal((await api(alice, "DELETE", `/api/sets/${set.id}`)).status, 204);
    assert.equal((await api(alice, "GET", `/api/sets/${set.id}`)).status, 404);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM overrides");
    assert.equal(rows[0].n, 0, "child rows are deleted too");
  });

  test("input that would break the .ini files is refused", async () => {
    for (const bad of [
      { ...SAMPLE, overrides: { "Base.Axe\n[Meta]": "X" } },
      { ...SAMPLE, overrides: { "Base.Axe": "X\nCategory=Y" } },
      { ...SAMPLE, definitions: { "BC_Custom_A]": "Name" } },
      { ...SAMPLE, name: "" },
      { ...SAMPLE, overrides: ["not", "an", "object"] },
    ]) {
      assert.equal((await api(alice, "POST", "/api/sets", bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    }
  });

  test("requests from another site are refused (CSRF)", async () => {
    const r = await api(alice, "POST", "/api/sets", SAMPLE, { origin: "https://evil.example" });
    assert.equal(r.status, 403);
    const noOrigin = await fetch(appUrl + "/api/sets", { method: "POST", headers: { cookie: alice, "content-type": "application/json" }, body: JSON.stringify(SAMPLE) });
    assert.equal(noOrigin.status, 403);
  });
});

describe("authorization: users only ever see their own data", () => {
  let alice, bob, aliceSet;
  beforeEach(async () => {
    await resetDb();
    alice = await login("code-alice"); bob = await login("code-bob");
    aliceSet = await (await api(alice, "POST", "/api/sets", SAMPLE)).json();
  });

  test("through the API: Bob can't list, read, change or delete Alice's setup", async () => {
    assert.deepEqual(await (await api(bob, "GET", "/api/sets")).json(), []);
    assert.equal((await api(bob, "GET", `/api/sets/${aliceSet.id}`)).status, 404);
    assert.equal((await api(bob, "PUT", `/api/sets/${aliceSet.id}`, { version: 1, overrides: {}, definitions: {} })).status, 404);
    assert.equal((await api(bob, "DELETE", `/api/sets/${aliceSet.id}`)).status, 404);
    const read = await (await api(alice, "GET", `/api/sets/${aliceSet.id}`)).json();
    assert.deepEqual(read.overrides, SAMPLE.overrides, "Alice's data is untouched");
  });

  test("in the database itself: row-level security hides other users' rows even from raw SQL", async () => {
    const { rows: [b] } = await pool.query("SELECT id FROM users WHERE username = 'bob'");
    const seen = await withUser(pool, b.id, async db => ({
      sets: (await db.query("SELECT * FROM category_sets")).rowCount,
      overrides: (await db.query("SELECT * FROM overrides")).rowCount,
      defs: (await db.query("SELECT * FROM custom_categories")).rowCount,
    }));
    assert.deepEqual(seen, { sets: 0, overrides: 0, defs: 0 });
  });

  test("with no user set, the database returns nothing", async () => {
    const { rowCount } = await pool.query("SELECT * FROM overrides");
    assert.equal(rowCount, 0);
  });

  test("Bob can't attach rows to Alice's setup by guessing its id", async () => {
    const { rows: [b] } = await pool.query("SELECT id FROM users WHERE username = 'bob'");
    await assert.rejects(withUser(pool, b.id, db => db.query(
      "INSERT INTO overrides (set_id, user_id, item, category) VALUES ($1, $2, 'Base.Axe', 'X')", [aliceSet.id, b.id])));
  });
});
