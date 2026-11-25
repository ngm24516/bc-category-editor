// The whole site from one origin: the editor page (web/), Discord sign-in (/auth), and the API (/api).
// One origin means the session cookie is first-party, so no CORS and no third-party-cookie problems.
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express from "express";
import { avatarUrl, createAuth } from "./auth.js";
import { createAdminRouter } from "./admin.js";
import { createCatalogRouter } from "./catalog.js";
import { createImportsRouter } from "./imports.js";
import { createMarketRouter } from "./market.js";
import { createStockroomRouter } from "./stockroom.js";
import { createSteam } from "./steam.js";
import { createSetsRouter } from "./sets.js";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

export function createApp({ pool, config, fetchImpl }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Container Apps terminates TLS in front of us.

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (config.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(compression());

  // Health probes for Container Apps. /readyz also proves the database is reachable.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", async (_req, res) => {
    try { await pool.query("SELECT 1"); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // CSRF defence for state-changing requests: SameSite=Lax cookies already stop most cross-site posts,
  // and we also require the request to come from our own origin.
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin !== config.publicUrl) return res.status(403).json({ error: "bad_origin" });
    next();
  });

  const auth = createAuth({ pool, config, fetchImpl });
  app.use(auth.loadUser);
  app.use("/auth", auth.router);

  app.use("/api", express.json({ limit: "5mb" }));
  app.get("/api/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not_signed_in" });
    const u = req.user;
    res.json({ id: u.id, discordId: u.discord_id, username: u.username, displayName: u.display_name || u.username,
      avatarUrl: avatarUrl(u), role: u.role });
  });
  app.use("/api/catalog", createCatalogRouter({ pool }));
  app.use("/api/sets", createSetsRouter({ pool, requireUser: auth.requireUser }));
  app.use("/api/stockroom", createStockroomRouter({ pool, requireUser: auth.requireUser }));
  app.use("/api", createMarketRouter({ pool, requireUser: auth.requireUser, config }));
  app.use("/api/admin", createAdminRouter({ pool, requireUser: auth.requireUser, config }));
  const steam = createSteam({ apiBase: config.steamApiBase, communityBase: config.steamCommunityBase, ...(fetchImpl ? { fetchImpl } : {}) });
  app.use("/api", createImportsRouter({ pool, requireUser: auth.requireUser, steam }));
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  app.get("/admin", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(WEB_DIR, "admin.html")); });
  app.use(express.static(WEB_DIR, {
    index: "index.html",
    setHeaders(res, file) {
      // The page itself must always be fresh; the big data and icon files can be cached briefly.
      res.setHeader("Cache-Control", file.endsWith(".html") ? "no-cache" : "public, max-age=3600");
    },
  }));

  // Never leak internals (stack traces, SQL) to the browser.
  app.use((err, req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({ error: "server_error" });
  });

  return app;
}
