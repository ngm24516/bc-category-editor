// Identity: "Log in with Discord" (OAuth2 authorization-code flow) and server-side sessions.
//
//   /auth/discord/login     -> random `state` in a short-lived cookie, redirect to Discord
//   /auth/discord/callback  -> check state, swap code for a token, ask Discord who this is,
//                              upsert the user, start a session, discard the Discord token
//   /auth/logout            -> delete the session
//
// The browser only ever holds an opaque random session token in an HttpOnly cookie.
// The database stores a SHA-256 hash of it.
import crypto from "node:crypto";
import express from "express";

const sha256 = s => crypto.createHash("sha256").update(s).digest();
const randomToken = () => crypto.randomBytes(32).toString("base64url");

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function cookie(name, value, { maxAgeSeconds, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function createAuth({ pool, config, fetchImpl = fetch }) {
  const router = express.Router();
  const { cookies, secure } = config;

  async function createSession(userId) {
    const token = randomToken();
    const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
    await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [sha256(token), userId, expires]);
    return { token, maxAgeSeconds: config.sessionDays * 86_400 };
  }

  // Attaches req.user (or null) on every request.
  async function loadUser(req, _res, next) {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[cookies.session];
    if (!token) return next();
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.discord_id, u.username, u.display_name, u.avatar, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
      req.user = rows[0] || null;
      next();
    } catch (err) { next(err); }
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "not_signed_in" });
    next();
  }

  router.get("/discord/login", (req, res) => {
    const state = randomToken();
    res.setHeader("Set-Cookie", cookie(cookies.state, state, { maxAgeSeconds: 600, secure }));
    const url = new URL(config.discord.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: config.discord.clientId,
      redirect_uri: config.discord.redirectUri,
      response_type: "code",
      scope: "identify",
      state,
      prompt: "none",
    }).toString();
    res.redirect(302, url.toString());
  });

  router.get("/discord/callback", async (req, res, next) => {
    const clearState = cookie(cookies.state, "", { maxAgeSeconds: 0, secure });
    const fail = (why) => { res.setHeader("Set-Cookie", clearState); res.redirect(302, `/?login=${why}`); };
    try {
      const { code, state, error } = req.query;
      if (error) return fail("cancelled");
      const expected = parseCookies(req.headers.cookie)[cookies.state];
      if (typeof code !== "string" || typeof state !== "string" || !expected ||
          state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
        return fail("expired");
      }

      const tokenRes = await fetchImpl(`${config.discord.apiBase}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: config.discord.redirectUri,
        }),
      });
      if (!tokenRes.ok) { console.warn("Discord token exchange failed:", tokenRes.status); return fail("discord"); }
      const { access_token: accessToken } = await tokenRes.json();

      const meRes = await fetchImpl(`${config.discord.apiBase}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!meRes.ok) { console.warn("Discord /users/@me failed:", meRes.status); return fail("discord"); }
      const me = await meRes.json();
      if (!me || typeof me.id !== "string" || !/^\d{5,25}$/.test(me.id)) return fail("discord");

      // We only needed the token to learn who this is. Revoke it (best effort) and keep nothing.
      fetchImpl(`${config.discord.apiBase}/oauth2/token/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token",
          client_id: config.discord.clientId, client_secret: config.discord.clientSecret }),
      }).catch(() => {});

      const role = config.adminDiscordIds.has(me.id) ? "admin" : "user";
      const { rows } = await pool.query(
        `INSERT INTO users (discord_id, username, display_name, avatar, role)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (discord_id) DO UPDATE
               SET username = EXCLUDED.username, display_name = EXCLUDED.display_name,
                   avatar = EXCLUDED.avatar, role = EXCLUDED.role, last_login_at = now()
         RETURNING id`,
        [me.id, String(me.username || "").slice(0, 100), me.global_name ? String(me.global_name).slice(0, 100) : null,
          me.avatar ? String(me.avatar).slice(0, 100) : null, role]);
      const session = await createSession(rows[0].id);
      res.setHeader("Set-Cookie", [clearState, cookie(cookies.session, session.token, { maxAgeSeconds: session.maxAgeSeconds, secure })]);
      res.redirect(302, "/?login=ok");
    } catch (err) { next(err); }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[cookies.session];
      if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
      res.setHeader("Set-Cookie", cookie(cookies.session, "", { maxAgeSeconds: 0, secure }));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return { router, loadUser, requireUser };
}

export function avatarUrl(user) {
  if (!user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=64`;
}
