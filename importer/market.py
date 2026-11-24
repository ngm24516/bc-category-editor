"""The market job: records every listing of every enabled marketplace, so the editor can show each item's
average, lowest and highest price over the whole history.

  python3 worker.py market     (an Azure Container Apps Job runs this every hour)

A marketplace's API answers pages of its current listings, for example
  GET https://api.onelifepz.com/portal/marketplace?search=&shop=&sort=newest&page=1&pageSize=100
  -> {"total": 3829, "meta": {"snapshot_updated_at": 1795460182}, "listings": [
        {"listing_id": "...", "full_type": "Base.Axe", "price": 120, "quantity": 1, "shop_name": "..."}, ...]}
The job reads every page (100 a time), skips a marketplace whose snapshot hasn't changed since the last crawl,
and stores each listing once per price it was seen at (market_listings). Prices are per item.

Only marketplaces an admin added are called, and only over https to public internet addresses: the address is
resolved first, every answer must be a public IP, and the connection goes to that checked IP (so a DNS answer
can't be swapped for an internal one between the check and the request). Redirects aren't followed.

Environment: DATABASE_URL, MARKET_MAX_PAGES (default 300), MARKET_ALLOW_PRIVATE=1 (tests only: allows http and
local addresses for a fake marketplace).
"""
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import ssl
import time
import urllib.parse
from datetime import datetime, timezone

import worker
from worker import log

PAGE_SIZE = 100
MAX_BYTES = 8 * 1024 * 1024
FULL_TYPE = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_.\-]+$")


class MarketError(Exception):
    pass


# ------------------------------------------------------------------ safe HTTP
def _allow_private():
    return os.environ.get("MARKET_ALLOW_PRIVATE") == "1"


def _resolve(host, port):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise MarketError(f"Can't find {host}: {e}") from None
    addrs = list(dict.fromkeys(i[4][0] for i in infos))
    if not addrs:
        raise MarketError(f"Can't find {host}")
    if not _allow_private():
        for a in addrs:
            if not ipaddress.ip_address(a).is_global:
                raise MarketError(f"{host} points to a private or local address ({a}); only public sites are allowed")
    return addrs[0]


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to an address we already checked, still verifying the certificate for the real host name."""
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


def get_json(url, timeout=20):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" and not (u.scheme == "http" and _allow_private()):
        raise MarketError("Marketplace addresses must start with https://")
    if not u.hostname:
        raise MarketError("That address has no host name")
    port = u.port or (443 if u.scheme == "https" else 80)
    ip = _resolve(u.hostname, port)
    conn = (_PinnedHTTPS if u.scheme == "https" else _PinnedHTTP)(u.hostname, port, ip, timeout)
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    try:
        conn.request("GET", path, headers={"Accept": "application/json", "User-Agent": "bc-category-editor market job"})
        r = conn.getresponse()
        if r.status != 200:
            raise MarketError(f"The marketplace answered HTTP {r.status}")
        body = r.read(MAX_BYTES + 1)
    except (OSError, http.client.HTTPException) as e:
        raise MarketError(f"Couldn't reach the marketplace: {e}") from None
    finally:
        conn.close()
    if len(body) > MAX_BYTES:
        raise MarketError("The marketplace's answer was too large")
    try:
        return json.loads(body)
    except ValueError:
        raise MarketError("The marketplace didn't answer with JSON") from None


# ------------------------------------------------------------------ reading a marketplace
def page_url(api_url, page):
    u = urllib.parse.urlsplit(api_url)
    q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
    q.update({"page": str(page), "pageSize": str(PAGE_SIZE)})
    q.setdefault("sort", "newest")
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), ""))


def clean_listing(x):
    """(listing_id, price, full_type, quantity, shop_name) or None for anything malformed."""
    if not isinstance(x, dict):
        return None
    lid, ft, price = x.get("listing_id"), x.get("full_type"), x.get("price")
    if not isinstance(lid, str) or not lid or len(lid) > 200:
        return None
    if not isinstance(ft, str) or len(ft) > 200 or not FULL_TYPE.match(ft):
        return None
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price < 0 or price >= 1e12:
        return None
    qty = x.get("quantity")
    qty = qty if isinstance(qty, int) and not isinstance(qty, bool) and 0 <= qty < 2**31 else None
    shop = x.get("shop_name") if isinstance(x.get("shop_name"), str) else None
    return (lid, round(float(price), 2), ft, qty, shop[:120] if shop else None)


def snapshot_time(body):
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
    t = meta.get("snapshot_updated_at")
    if not isinstance(t, (int, float)):
        times = [x.get("snapshot_updated_at") for x in body.get("listings") or [] if isinstance(x, dict)]
        times = [t for t in times if isinstance(t, (int, float))]
        t = max(times) if times else None
    return datetime.fromtimestamp(int(t), timezone.utc) if t else None


def read_marketplace(api_url, known_snapshot=None):
    """(snapshot time, [listings]) or (snapshot time, None) when the snapshot is the one we already have."""
    first = get_json(page_url(api_url, 1))
    if not isinstance(first, dict) or not isinstance(first.get("listings"), list):
        raise MarketError("The answer has no \"listings\" list")
    snap = snapshot_time(first)
    if snap and known_snapshot and snap == known_snapshot:
        return snap, None
    total = first.get("total") if isinstance(first.get("total"), int) else len(first["listings"])
    pages = min(max(1, math.ceil(total / PAGE_SIZE)), int(os.environ.get("MARKET_MAX_PAGES", "300")))
    seen, raw = set(), list(first["listings"])
    for p in range(2, pages + 1):
        time.sleep(0.2)  # be gentle with someone else's server
        body = get_json(page_url(api_url, p))
        batch = body.get("listings") if isinstance(body, dict) else None
        if not isinstance(batch, list) or not batch:
            break
        raw.extend(batch)
    rows = []
    for x in raw:
        row = clean_listing(x)
        if row and (row[0], row[1]) not in seen:
            seen.add((row[0], row[1]))
            rows.append(row)
    return snap, rows


# ------------------------------------------------------------------ the job
def save(conn, market_id, snap, rows):
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO market_listings (marketplace_id, listing_id, price, full_type, quantity, shop_name)
                           VALUES (%s, %s, %s, %s, %s, %s)
                           ON CONFLICT (marketplace_id, listing_id, price) DO UPDATE
                              SET last_seen = now(), quantity = EXCLUDED.quantity, shop_name = EXCLUDED.shop_name,
                                  full_type = EXCLUDED.full_type""",
                        [(market_id, *r) for r in rows])
        cur.execute("""UPDATE marketplaces SET last_checked_at = now(), last_snapshot_at = %s, last_listings = %s,
                              last_error = NULL WHERE id = %s""", (snap, len(rows), market_id))
    conn.commit()


def cmd_market():
    with worker.connect() as conn:
        run_id = worker.start_run(conn, "market")
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, api_url, last_snapshot_at FROM marketplaces WHERE enabled ORDER BY created_at")
            markets = cur.fetchall()
        ok = failed = 0
        for market_id, name, api_url, known in markets:
            started = time.time()
            try:
                snap, rows = read_marketplace(api_url, known)
                if rows is None:
                    with conn.cursor() as cur:
                        cur.execute("UPDATE marketplaces SET last_checked_at = now(), last_error = NULL WHERE id = %s",
                                    (market_id,))
                    conn.commit()
                    log(f"{name}: no new snapshot since {known:%Y-%m-%d %H:%M} UTC")
                else:
                    save(conn, market_id, snap, rows)
                    log(f"{name}: recorded {len(rows)} listings in {time.time() - started:.0f}s")
                ok += 1
            except Exception as e:  # noqa: BLE001 - one marketplace failing mustn't stop the others
                conn.rollback()
                msg = str(e) if isinstance(e, MarketError) else f"{type(e).__name__}: {e}"
                with conn.cursor() as cur:
                    cur.execute("UPDATE marketplaces SET last_checked_at = now(), last_error = %s WHERE id = %s",
                                (msg[:500], market_id))
                conn.commit()
                log(f"{name}: failed: {msg}")
                failed += 1
        worker.end_run(conn, run_id, len(markets), ok, failed,
                       None if not failed else f"{failed} of {len(markets)} marketplace(s) failed")
        log(f"Checked {len(markets)} marketplace(s): {ok} ok, {failed} failed")
        return ok
