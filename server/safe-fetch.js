// Fetching JSON from an address an admin typed in (a marketplace API) without letting it reach anything
// private: https only, every DNS answer must be a public address, and the connection goes to the address we
// checked (pinned through `lookup`, so DNS can't switch to an internal one between check and connect).
// No redirects, a time limit and a size limit. `allowPrivate` exists for tests with a local fake server.
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) {
  BLOCKED.addSubnet(a, p, "ipv4");
}
// (IPv4-mapped IPv6, ::ffff:a.b.c.d, is checked as the IPv4 address it carries; a BlockList rule for it would
// match every IPv4 address.)
for (const [a, p] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  BLOCKED.addSubnet(a, p, "ipv6");
}
export function isPublicAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  return net.isIP(ip) !== 0 && !BLOCKED.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

export class FetchError extends Error {}

export async function getJsonSafely(url, { allowPrivate = false, timeoutMs = 15_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new FetchError("That isn't a web address"); }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) throw new FetchError("The address must start with https://");
  if (u.username || u.password) throw new FetchError("Addresses with a user name or password aren't allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await dns.lookup(host, { all: true });
  } catch { throw new FetchError(`Can't find ${host}`); }
  if (!addrs.length) throw new FetchError(`Can't find ${host}`);
  if (!allowPrivate) {
    const bad = addrs.find(a => !isPublicAddress(a.address));
    if (bad) throw new FetchError(`${host} points to a private or local address (${bad.address}); only public sites are allowed`);
  }
  const pick = addrs[0];
  const lib = u.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "bc-category-editor" },
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [pick]) : cb(null, pick.address, pick.family)),
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new FetchError(`The site answered HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on("data", c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new FetchError("The answer was too large")); } else chunks.push(c);
      });
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new FetchError("The site didn't answer with JSON")); }
      });
      res.on("error", e => reject(new FetchError(`Couldn't read the answer: ${e.message}`)));
    });
    req.on("timeout", () => { req.destroy(); reject(new FetchError("The site took too long to answer")); });
    req.on("error", e => reject(e instanceof FetchError ? e : new FetchError(`Couldn't reach the site: ${e.message}`)));
    req.end();
  });
}
