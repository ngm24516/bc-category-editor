"""Market job against a real Postgres and a fake marketplace API.

Skipped unless TEST_DATABASE_URL is set. Run as in test_worker.py.
"""
import json
import os
import subprocess
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
DB = os.environ.get("TEST_DATABASE_URL")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None

MARKET = {"snapshot": 1795460182, "listings": [], "requests": [], "status": 200}


class FakeMarket(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
        MARKET["requests"].append(q)
        page, size = int(q.get("page", 1)), min(int(q.get("pageSize", 30)), 100)
        rows = MARKET["listings"][(page - 1) * size: page * size]
        body = json.dumps({"page": page, "pageSize": size, "total": len(MARKET["listings"]), "listings": rows,
                           "meta": {"snapshot_updated_at": MARKET["snapshot"]}}).encode()
        self.send_response(MARKET["status"])
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def listing(i, ft, price, qty=1):
    return {"listing_id": f"listing_{i}", "full_type": ft, "price": price, "quantity": qty, "shop_name": "Shop"}


class ParsingTests(unittest.TestCase):
    def test_page_urls_keep_filters_and_set_paging(self):
        import market
        u = market.page_url("https://api.example.com/portal/marketplace?search=&shop=abc&sort=newest&page=7&pageSize=30", 3)
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query, keep_blank_values=True))
        self.assertEqual(q, {"search": "", "shop": "abc", "sort": "newest", "page": "3", "pageSize": "100"})

    def test_malformed_listings_are_dropped(self):
        import market
        self.assertEqual(market.clean_listing(listing(1, "Base.Axe", 12.5, 3)), ("listing_1", 12.5, "Base.Axe", 3, "Shop"))
        for bad in [listing(1, "Axe", 1), listing(1, "Base.Axe", -1), listing(1, "Base.Axe", "12"),
                    listing(1, "Base.Axe", float("inf")), listing(1, "Base.Axe; DROP", 1), {"price": 1}, "x"]:
            self.assertIsNone(market.clean_listing(bad), bad)

    def test_only_public_https_addresses(self):
        import market
        os.environ.pop("MARKET_ALLOW_PRIVATE", None)
        for url in ["http://api.example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://10.1.2.3/x",
                    "https://169.254.169.254/metadata", "https://[::1]/x"]:
            with self.assertRaises(market.MarketError, msg=url):
                market.get_json(url)


@unittest.skipUnless(DB and psycopg, "set TEST_DATABASE_URL to run the market job tests")
class MarketJobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeMarket)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/portal/marketplace?search=&shop=&sort=newest&page=1&pageSize=30"
        os.environ.update({"DATABASE_URL": DB, "MARKET_ALLOW_PRIVATE": "1"})

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        os.environ.pop("MARKET_ALLOW_PRIVATE", None)

    def setUp(self):
        MARKET.update({"snapshot": 1795460182, "status": 200, "requests": [],
                       "listings": [listing(i, "Base.Axe" if i % 2 else "Base.Hammer", 10 + i) for i in range(250)]})
        with psycopg.connect(DB, autocommit=True) as c:
            c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        subprocess.run(["node", "server/migrate.js"], cwd=ROOT, env={**os.environ, "DATABASE_URL": DB},
                       check=True, capture_output=True)
        with psycopg.connect(DB) as c:
            c.execute("INSERT INTO marketplaces (name, api_url) VALUES ('OneLife', %s)", (self.url,))
            c.execute("INSERT INTO marketplaces (name, api_url, enabled) VALUES ('Off', 'https://off.example.com/', false)")

    def one(self, sql, *args):
        with psycopg.connect(DB) as c:
            return c.execute(sql, args).fetchone()

    def test_reads_every_page_and_records_each_listing_once(self):
        import market
        self.assertEqual(market.cmd_market(), 1)
        self.assertEqual([r["page"] for r in MARKET["requests"]], ["1", "2", "3"])
        self.assertTrue(all(r["pageSize"] == "100" for r in MARKET["requests"]))
        self.assertEqual(self.one("SELECT count(*) FROM market_listings")[0], 250)
        n, snap, err = self.one("SELECT last_listings, last_snapshot_at, last_error FROM marketplaces WHERE name = 'OneLife'")
        self.assertEqual((n, snap.timestamp(), err), (250, 1795460182, None))
        kind, status, processed = self.one("SELECT kind, status, processed FROM importer_runs")
        self.assertEqual((kind, status, processed), ("market", "succeeded", 1))

    def test_an_unchanged_snapshot_is_skipped_and_a_reprice_adds_a_price(self):
        import market
        market.cmd_market()
        MARKET["requests"].clear()
        market.cmd_market()
        self.assertEqual(len(MARKET["requests"]), 1, "only the first page is read when nothing changed")
        # A new snapshot: one listing repriced, one new; old ones seen again aren't counted twice.
        MARKET["snapshot"] += 3600
        MARKET["listings"][0]["price"] = 99
        MARKET["listings"].append(listing(999, "Base.Axe", 500))
        market.cmd_market()
        self.assertEqual(self.one("SELECT count(*) FROM market_listings")[0], 252)
        self.assertEqual(self.one("SELECT array_agg(price ORDER BY price) FROM market_listings WHERE listing_id = 'listing_0'")[0],
                         [10, 99])

    def test_a_failing_marketplace_is_recorded_not_fatal(self):
        import market
        MARKET["status"] = 503
        self.assertEqual(market.cmd_market(), 0)
        err = self.one("SELECT last_error FROM marketplaces WHERE name = 'OneLife'")[0]
        self.assertIn("HTTP 503", err)
        self.assertEqual(self.one("SELECT status FROM importer_runs")[0], "failed")


if __name__ == "__main__":
    unittest.main()
