// Reading the Stockroom mod's save files (%USERPROFILE%\\Zomboid\\Lua\\Stockroom, "<...>-a.txt" / "-b.txt").
// Shared by the editor (Stockroom books tool) and the Stockroom page. Only decodes data; nothing is run.
"use strict";
// Stockroom's own codec (Storage.lua): s<len>:<text>  n<number>;  t  f  { key value ... }
// <len> is the game's string length (Java characters, not bytes), so decode the file to text first.
function decodeStockroom(bytes) {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let pos = 0;
  const fail = why => { throw new Error(why + " at character " + pos + " of " + text.length); };
  function readUntil(ch) {
    const end = text.indexOf(ch, pos);
    if (end < 0 || end - pos >= 32) fail("bad length or number");
    const v = Number(text.slice(pos, end)); if (!isFinite(v)) fail("bad number");
    pos = end + 1; return v;
  }
  function parse(depth) {
    if (depth > 24 || pos >= text.length) fail("data ends early");
    const tag = text[pos++];
    if (tag === "t") return true;
    if (tag === "f") return false;
    if (tag === "n") return readUntil(";");
    if (tag === "s") { const n = readUntil(":"); const v = text.slice(pos, pos + n); pos += n; return v; }
    if (tag !== "{") { pos--; fail("unexpected '" + tag + "'"); }
    const out = {};
    while (text[pos] !== "}") { if (pos >= text.length) fail("table not closed"); const k = parse(depth + 1); out[k] = parse(depth + 1); }
    pos++; return out;
  }
  return parse(0);
}

function stockItems(state, houseKeys) {
  const found = new Map();
  for (const [hk, house] of Object.entries(state.houses || {})) {
    if (houseKeys && !houseKeys.has(hk)) continue;
    const snap = house.snapshot; if (!snap || !snap.containers) continue;
    for (const rec of Object.values(snap.containers)) {
      for (const it of Object.values(rec.items || {})) if (it && typeof it.type === "string") found.set(it.type, (found.get(it.type) || 0) + (+it.count || 1));
    }
  }
  return found;
}

// "server|world|character" -> "character on server · world world"
function stockLabel(state) {
  const parts = String(state.identity || "").split("|");
  return (parts[2] || "?") + " on " + (parts[0] === "singleplayer" ? "single player" : (parts[0] || "?").replace(/:+$/, "")) + (parts[1] ? " · world " + parts[1] : "");
}
