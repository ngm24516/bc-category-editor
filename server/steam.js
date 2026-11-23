// Steam's public Workshop API: item details and collection contents. Neither call needs an API key.
// When Steam removes a collection for breaking its rules, the API stops listing its items but the public
// collection page still shows them, so collectionFromPage() reads the item ids from that page.
// The base URLs are configurable only so tests can point at a fake Steam.
export const PZ_APP_ID = 108600;

// "https://steamcommunity.com/sharedfiles/filedetails/?id=123", "…/workshop/filedetails/?id=123", or "123".
export function parseWorkshopId(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (/^\d{4,20}$/.test(t)) return t;
  let url;
  try { url = new URL(t); } catch { return null; }
  if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname)) return null;
  const id = url.searchParams.get("id");
  return id && /^\d{4,20}$/.test(id) ? id : null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decodeEntities = t => t.replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,5});/gi, (all, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
  return ENTITIES[e.toLowerCase()] ?? all;
});

const PAGE_LIMIT = 4 * 1024 * 1024; // a 500-item collection page is well under 1 MB

export function createSteam({ apiBase = "https://api.steampowered.com", communityBase = "https://steamcommunity.com",
  fetchImpl = fetch } = {}) {
  const base = apiBase.replace(/\/+$/, "");
  const community = communityBase.replace(/\/+$/, "");

  async function post(path, params) {
    const res = await fetchImpl(`${base}/ISteamRemoteStorage/${path}/v1/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Steam ${path} answered ${res.status}`);
    return (await res.json())?.response ?? {};
  }

  // Map of id -> { id, ok, removed, title, appId, updatedAt (Date), size (bytes) } for every id Steam knows.
  // removed = Steam took it down for breaking its rules; ok = public and not removed.
  async function details(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const params = { itemcount: String(chunk.length) };
      chunk.forEach((id, k) => { params[`publishedfileids[${k}]`] = id; });
      const r = await post("GetPublishedFileDetails", params);
      for (const d of r.publishedfiledetails || []) {
        out.set(String(d.publishedfileid), {
          id: String(d.publishedfileid),
          ok: d.result === 1 && !d.banned,
          removed: !!d.banned,
          title: typeof d.title === "string" ? d.title.slice(0, 200) : null,
          appId: Number(d.consumer_app_id || d.creator_app_id || 0),
          updatedAt: d.time_updated ? new Date(Number(d.time_updated) * 1000) : null,
          size: Number(d.file_size || 0),
        });
      }
    }
    return out;
  }

  // The Workshop ids inside a collection, or null when the id isn't a collection.
  async function collectionChildren(id) {
    const r = await post("GetCollectionDetails", { collectioncount: "1", "publishedfileids[0]": id });
    const c = (r.collectiondetails || [])[0];
    if (!c || c.result !== 1 || !Array.isArray(c.children) || !c.children.length) return null;
    // filetype 0 = a Workshop item; nested collections (filetype 2) aren't followed.
    return c.children.filter(ch => !ch.filetype || ch.filetype === 0)
      .map(ch => String(ch.publishedfileid)).filter(x => /^\d{1,20}$/.test(x));
  }

  // { ids, title } from a collection's public page, or null when the page lists no items (not a
  // collection, or Steam hid the page too). Only reads the page's text: each listed item is marked
  // id="sharedfile_<id>". Every id found is still checked with details() before anything is queued.
  async function collectionFromPage(id) {
    if (!/^\d{1,20}$/.test(id)) return null;
    const res = await fetchImpl(`${community}/sharedfiles/filedetails/?id=${id}`, {
      headers: { Accept: "text/html", "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, PAGE_LIMIT);
    const ids = [];
    for (const m of html.matchAll(/\bid=["']sharedfile_(\d{1,20})["']/g)) {
      if (m[1] !== id && !ids.includes(m[1])) ids.push(m[1]);
    }
    if (!ids.length) return null;
    const t = html.match(/<title>([^<]{1,300})<\/title>/i)?.[1] || "";
    const title = decodeEntities(t.replace(/^\s*Steam (?:Workshop|Community)\s*::\s*/i, "")).trim().slice(0, 200) || null;
    return { ids, title };
  }

  return { details, collectionChildren, collectionFromPage };
}
