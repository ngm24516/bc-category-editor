// Marketplaces: in-game shops whose listings the market job records every hour (importer/market.py).
// Admins add them; every account picks the one whose prices the editor shows.
//
//   GET    /api/markets                   enabled marketplaces, and the signed-in user's choice
//   PUT    /api/markets/choice            { marketplaceId | null }   (signed in; user data, RLS)
//   GET    /api/markets/:id/prices        { items: { fullType: [avg, low, high, listings, nowLow, owner, shop] } }
//   GET    /api/admin/markets             every marketplace with its address, status and counts (admins)
//   POST   /api/admin/markets             { name, url } checks the address answers like a marketplace, then adds it
//   PATCH  /api/admin/markets/:id         { enabled, ignoreAt, outlierFactor }
//   DELETE /api/admin/markets/:id         removes it and its whole price history
//
// Prices are per item; each listing counts once per price it was seen at (market_listings).
import express from "express";
import { withUser } from "./db.js";
import { FetchError, getJsonSafely } from "./safe-fetch.js";

// A listing left out of prices: at or above the marketplace's placeholder price, or far above its item's median
// (that many times, with at least 3 listings of the item and a price of at least 100). Uses lst/stats/mk above.
const OVERPRICED = `(
  (mk.ignore_at IS NOT NULL AND l.price >= mk.ignore_at)
  OR (coalesce(mk.outlier_factor, 0) > 0 AND s.cnt >= 3 AND l.price >= 100 AND l.price > mk.outlier_factor * s.med))`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_TYPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;

const marketJson = (r, admin) => ({
  id: r.id, name: r.name, enabled: r.enabled,
  lastCheckedAt: r.last_checked_at, lastSnapshotAt: r.last_snapshot_at, lastListings: r.last_listings,
  ignoreAt: r.ignore_at == null ? null : Number(r.ignore_at), outlierFactor: r.outlier_factor == null ? null : Number(r.outlier_factor),
  items: Number(r.items || 0),
  ...(admin ? {
    url: r.api_url, lastError: r.last_error, createdAt: r.created_at, addedBy: r.added_by || null,
    history: Number(r.history || 0),
  } : {}),
});

const MARKETS_SQL = `
  SELECT m.*, u.display_name AS added_by,
         (SELECT count(DISTINCT full_type) FROM market_listings l WHERE l.marketplace_id = m.id
             AND EXISTS (SELECT 1 FROM catalog_items c WHERE c.full_type = l.full_type)) AS items,
         (SELECT count(*) FROM market_listings l WHERE l.marketplace_id = m.id) AS history
    FROM marketplaces m LEFT JOIN users u ON u.id = m.created_by`;

// The page-1 URL the job will use, so the admin sees the same thing the job does.
export function firstPageUrl(apiUrl) {
  const u = new URL(apiUrl);
  u.searchParams.set("page", "1");
  u.searchParams.set("pageSize", "100");
  if (!u.searchParams.has("sort")) u.searchParams.set("sort", "newest");
  u.hash = "";
  return u.toString();
}

// What an admin sees when the address doesn't answer like a marketplace.
export function checkMarketplaceAnswer(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.listings)) {
    return "The answer has no \"listings\" list. Use the address of the marketplace's listings API.";
  }
  const good = body.listings.filter(x => x && typeof x.listing_id === "string" && typeof x.full_type === "string"
    && FULL_TYPE.test(x.full_type) && typeof x.price === "number" && Number.isFinite(x.price) && x.price >= 0);
  if (body.listings.length && !good.length) {
    return "Its listings don't have listing_id, full_type (like Base.Axe) and price, so they can't be matched to items.";
  }
  return null;
}

export function createMarketRouter({ pool, requireUser, config }) {
  const router = express.Router();
  const admin = (req, res, next) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "forbidden", message: "Admins only" }));
  const bad = (res, status, error, message) => res.status(status).json({ error, message });

  // ---- everyone
  router.get("/markets", async (req, res) => {
    const { rows } = await pool.query(`${MARKETS_SQL} WHERE m.enabled ORDER BY m.name`);
    let choice = null;
    if (req.user) {
      choice = await withUser(pool, req.user.id, async db =>
        (await db.query("SELECT marketplace_id FROM user_marketplaces")).rows[0]?.marketplace_id ?? null);
    }
    res.json({ markets: rows.map(r => marketJson(r, false)), choice });
  });

  router.put("/markets/choice", requireUser, async (req, res) => {
    const id = req.body?.marketplaceId ?? null;
    if (id !== null && (typeof id !== "string" || !UUID.test(id))) return bad(res, 400, "invalid", "marketplaceId must be a marketplace id or null");
    if (id) {
      const { rowCount } = await pool.query("SELECT 1 FROM marketplaces WHERE id = $1 AND enabled", [id]);
      if (!rowCount) return bad(res, 404, "not_found", "No such marketplace");
    }
    await withUser(pool, req.user.id, async db => {
      if (id) {
        await db.query(`INSERT INTO user_marketplaces (user_id, marketplace_id) VALUES ($1, $2)
                        ON CONFLICT (user_id) DO UPDATE SET marketplace_id = EXCLUDED.marketplace_id, chosen_at = now()`,
        [req.user.id, id]);
      } else {
        await db.query("DELETE FROM user_marketplaces");
      }
    });
    res.json({ choice: id });
  });

  router.get("/markets/:id/prices", async (req, res) => {
    if (!UUID.test(req.params.id)) return bad(res, 404, "not_found", "No such marketplace");
    const m = (await pool.query("SELECT id, last_snapshot_at FROM marketplaces WHERE id = $1 AND enabled", [req.params.id])).rows[0];
    if (!m) return bad(res, 404, "not_found", "No such marketplace");
    // Only items in the library: a listing counts when its full_type is exactly a catalog item's.
    // History: every listing price recorded, minus overpriced ones (see OVERPRICED). Current: the cheapest such
    // listing in the last full read (last_seen equals last_crawl_at), with who sells it.
    const { rows } = await pool.query(
      `WITH stats AS (
         SELECT full_type, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS med, count(*) AS cnt
           FROM market_listings WHERE marketplace_id = $1 GROUP BY full_type),
       lst AS (
         SELECT l.full_type, l.price, l.owner_name, l.shop_name, l.last_seen, ${OVERPRICED} AS ignored
           FROM market_listings l JOIN stats s USING (full_type) JOIN marketplaces mk ON mk.id = l.marketplace_id
          WHERE l.marketplace_id = $1 AND EXISTS (SELECT 1 FROM catalog_items c WHERE c.full_type = l.full_type)),
       hist AS (
         SELECT full_type, round(avg(price) FILTER (WHERE NOT ignored), 2) AS avg,
                min(price) FILTER (WHERE NOT ignored) AS low, max(price) FILTER (WHERE NOT ignored) AS high,
                count(*) FILTER (WHERE NOT ignored) AS n, count(*) FILTER (WHERE ignored) AS skipped
           FROM lst GROUP BY full_type HAVING count(*) FILTER (WHERE NOT ignored) > 0),
       cur AS (
         SELECT DISTINCT ON (full_type) full_type, price, owner_name, shop_name
           FROM lst
          -- compared in SQL: the timestamps have microseconds, which a JavaScript Date would round away
          WHERE NOT ignored AND last_seen = (SELECT last_crawl_at FROM marketplaces WHERE id = $1)
          ORDER BY full_type, price, owner_name NULLS LAST)
       SELECT h.*, c.price AS cur_price, c.owner_name, c.shop_name FROM hist h LEFT JOIN cur c USING (full_type)`,
      [m.id]);
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      marketplaceId: m.id, snapshotAt: m.last_snapshot_at,
      // [average, low, high, listings counted, current lowest (null if none now), its owner, its shop, overpriced ignored]
      items: Object.fromEntries(rows.map(r => [r.full_type, [Number(r.avg), Number(r.low), Number(r.high), Number(r.n),
        r.cur_price == null ? null : Number(r.cur_price), r.owner_name ?? null, r.shop_name ?? null, Number(r.skipped)]])),
    });
  });

  // ---- admins
  router.get("/admin/markets", requireUser, admin, async (_req, res) => {
    const { rows } = await pool.query(`${MARKETS_SQL} ORDER BY m.created_at`);
    res.json({ markets: rows.map(r => marketJson(r, true)), checkMinute: config.marketCheckMinute });
  });

  router.post("/admin/markets", requireUser, admin, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!name || name.length > 80) return bad(res, 400, "invalid", "Give the marketplace a name (up to 80 characters)");
    if (!url || url.length > 500) return bad(res, 400, "invalid", "Paste the marketplace's listings API address");
    let page1;
    try { page1 = firstPageUrl(url); } catch { return bad(res, 400, "invalid", "That isn't a web address"); }
    let body;
    try {
      body = await getJsonSafely(page1, { allowPrivate: config.marketAllowPrivate });
    } catch (err) {
      if (err instanceof FetchError) return bad(res, 400, "unreachable", err.message);
      throw err;
    }
    const problem = checkMarketplaceAnswer(body);
    if (problem) return bad(res, 400, "not_a_marketplace", problem);
    try {
      const { rows } = await pool.query(
        "INSERT INTO marketplaces (name, api_url, created_by) VALUES ($1, $2, $3) RETURNING *", [name, url, req.user.id]);
      res.status(201).json({ ...marketJson(rows[0], true), sample: body.listings.slice(0, 3), total: body.total ?? null });
    } catch (err) {
      if (err.code === "23505") return bad(res, 409, "exists", "That marketplace address is already added");
      throw err;
    }
  });

  // { enabled?, ignoreAt?, outlierFactor? }: pause/resume, and the overpriced rules (null turns one off).
  router.patch("/admin/markets/:id", requireUser, admin, async (req, res) => {
    const b = req.body || {}, sets = [], vals = [req.params.id];
    if (!UUID.test(req.params.id)) return bad(res, 404, "not_found", "No such marketplace");
    if ("enabled" in b) {
      if (typeof b.enabled !== "boolean") return bad(res, 400, "invalid", "enabled must be true or false");
      vals.push(b.enabled); sets.push(`enabled = $${vals.length}`);
    }
    if ("ignoreAt" in b) {
      if (b.ignoreAt !== null && !(typeof b.ignoreAt === "number" && b.ignoreAt > 0 && b.ignoreAt < 1e12)) {
        return bad(res, 400, "invalid", "ignoreAt must be a price above 0, or null for no limit");
      }
      vals.push(b.ignoreAt); sets.push(`ignore_at = $${vals.length}`);
    }
    if ("outlierFactor" in b) {
      if (b.outlierFactor !== null && !(typeof b.outlierFactor === "number" && (b.outlierFactor === 0 || (b.outlierFactor >= 2 && b.outlierFactor <= 1000)))) {
        return bad(res, 400, "invalid", "outlierFactor must be 0 (off) or from 2 to 1000, or null");
      }
      vals.push(b.outlierFactor); sets.push(`outlier_factor = $${vals.length}`);
    }
    if (!sets.length) return bad(res, 400, "invalid", "Send enabled, ignoreAt or outlierFactor");
    const { rows } = await pool.query(`UPDATE marketplaces SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return bad(res, 404, "not_found", "No such marketplace");
    res.json(marketJson(rows[0], true));
  });

  router.delete("/admin/markets/:id", requireUser, admin, async (req, res) => {
    if (!UUID.test(req.params.id)) return bad(res, 404, "not_found", "No such marketplace");
    const { rowCount } = await pool.query("DELETE FROM marketplaces WHERE id = $1", [req.params.id]);
    if (!rowCount) return bad(res, 404, "not_found", "No such marketplace");
    res.status(204).end();
  });

  return router;
}
