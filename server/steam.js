// Steam's public Workshop API: item details and collection contents. Neither call needs an API key.
// The base URL is configurable only so tests can point at a fake Steam.
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

export function createSteam({ apiBase = "https://api.steampowered.com", fetchImpl = fetch } = {}) {
  const base = apiBase.replace(/\/+$/, "");

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

  // Map of id -> { id, ok, title, appId, updatedAt (Date), size (bytes) } for every id Steam knows.
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

  return { details, collectionChildren };
}
