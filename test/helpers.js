// Shared test harness: the real app on a random port, a fake Discord, and helpers to sign in and call the API.
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createPool } from "../server/db.js";
import { migrate } from "../server/migrate.js";

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error("Set TEST_DATABASE_URL to an empty Postgres database the tests may wipe");

// Each authorization code maps to a Discord user.
export const DISCORD_USERS = {
  "code-alice": { id: "100000000000000001", username: "alice", global_name: "Alice", avatar: "a1" },
  "code-bob": { id: "100000000000000002", username: "bob", global_name: null, avatar: null },
  "code-admin": { id: "100000000000000099", username: "nate", global_name: "Nate", avatar: null },
};

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function cookiesFrom(res) {
  return res.headers.getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("="));
}

// Fake Steam: tests put Workshop items and collections here.
// pages: collection id -> the HTML of its public page (used when the API hides a removed collection).
export const STEAM = { items: new Map(), collections: new Map(), pages: new Map(), down: false };

export async function startHarness({ fetchImpl } = {}) {
  const steamServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/sharedfiles/filedetails/")) {
        const page = STEAM.down ? null : STEAM.pages.get(new URL(req.url, "http://x").searchParams.get("id"));
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(page ?? "<html><title>Steam Community :: Error</title><body>There was a problem accessing the item.</body></html>");
      }
      res.setHeader("Content-Type", "application/json");
      if (STEAM.down) { res.statusCode = 503; return res.end("{}"); }
      const p = new URLSearchParams(body);
      const ids = [...p.entries()].filter(([k]) => k.startsWith("publishedfileids[")).map(([, v]) => v);
      if (req.url === "/ISteamRemoteStorage/GetCollectionDetails/v1/") {
        const children = STEAM.collections.get(ids[0]);
        return res.end(JSON.stringify({ response: { result: 1, collectiondetails: [children
          ? { publishedfileid: ids[0], result: 1, children: children.map(c => ({ publishedfileid: c, filetype: 0 })) }
          : { publishedfileid: ids[0], result: 9 }] } }));
      }
      if (req.url === "/ISteamRemoteStorage/GetPublishedFileDetails/v1/") {
        return res.end(JSON.stringify({ response: { result: 1, publishedfiledetails: ids.map(id => {
          const d = STEAM.items.get(id);
          return d ? { publishedfileid: id, result: 1, consumer_app_id: d.app ?? 108600, title: d.title, time_updated: d.updated ?? 1_790_000_000, file_size: String(d.size ?? 1000), banned: !!d.banned }
                   : { publishedfileid: id, result: 9 };
        }) } }));
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  const steamUrl = await listen(steamServer);
  const discord = http.createServer((req, res) => {
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
  const discordUrl = await listen(discord);

  async function resetDb() {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await c.end();
    await migrate(DB_URL, () => {});
  }
  await resetDb();

  const pool = createPool(DB_URL);
  const server = http.createServer();
  const appUrl = await listen(server);
  const config = loadConfig({
    PUBLIC_URL: appUrl, DATABASE_URL: DB_URL,
    DISCORD_CLIENT_ID: "test-client", DISCORD_CLIENT_SECRET: "test-secret",
    DISCORD_API_BASE: discordUrl + "/api", DISCORD_AUTHORIZE_URL: discordUrl + "/oauth2/authorize",
    ADMIN_DISCORD_IDS: "100000000000000099",
    STEAM_API_BASE: steamUrl, STEAM_COMMUNITY_BASE: steamUrl,
    MARKET_ALLOW_PRIVATE: "1", // the marketplace tests run a fake marketplace on localhost
  });
  const app = createApp({ pool, config, fetchImpl });
  server.on("request", app);

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

  return {
    appUrl, pool, resetDb, login, api, cookiesFrom, DB_URL,
    stop: async () => { server.close(); discord.close(); steamServer.close(); await pool.end(); },
  };
}
