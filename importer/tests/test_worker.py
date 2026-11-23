"""Importer worker against a real Postgres, a fake Steam API and fake downloads.

Skipped unless TEST_DATABASE_URL is set (CI sets it). The schema comes from the real migrations via Node.
Run: TEST_DATABASE_URL=postgres://bc_app:bc_app@localhost:5432/bceditor_test python3 -m unittest discover -s importer/tests
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
DB = os.environ.get("TEST_DATABASE_URL")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    import psycopg
    from PIL import Image
except ImportError:  # pragma: no cover
    psycopg = None

STEAM = {}  # workshop id -> {"title", "time_updated", "app"}


class FakeSteam(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        form = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        ids = [v[0] for k, v in form.items() if k.startswith("publishedfileids[")]
        details = [{"publishedfileid": i, "result": 1, "consumer_app_id": STEAM[i].get("app", 108600),
                    "title": STEAM[i]["title"], "time_updated": STEAM[i]["time_updated"], "file_size": "1000"}
                   if i in STEAM else {"publishedfileid": i, "result": 9} for i in ids]
        body = json.dumps({"response": {"publishedfiledetails": details}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def png(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    buf = io.BytesIO()
    Image.new("RGBA", (16, 16), (0, 128, 255, 255)).save(buf, "PNG")
    with open(path, "wb") as f:
        f.write(buf.getvalue())


@unittest.skipUnless(DB and psycopg, "set TEST_DATABASE_URL (and install psycopg) to run the worker tests")
class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeSteam)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.downloads = tempfile.mkdtemp()
        # Better Containers itself (its rule files) and two Workshop items.
        bc = os.path.join(cls.downloads, "3586216562", "mods", "BetterContainers", "42.21", "media", "lua",
                          "client", "BetterContainers", "Categorize", "Categories")
        write(os.path.join(bc, "vanilla", "weapons.lua"), 'WepFire = { "Guns.*" }\n')
        write(os.path.join(bc, "_applyMods.lua"), "")
        mod = os.path.join(cls.downloads, "2200148440", "mods", "Guns", "42", "media")
        write(os.path.join(cls.downloads, "2200148440", "mods", "Guns", "42", "mod.info"), "id=GunsMod\nname=Guns\n")
        write(os.path.join(mod, "scripts", "guns.txt"),
              "module Guns {\n item Pistol {\n  ItemType = base:weapon,\n  Icon = Pistol,\n }\n}\n")
        write(os.path.join(mod, "lua", "shared", "Translate", "EN", "ItemName.json"), '{ "ItemName_Guns.Pistol": "Pistol" }')
        png(os.path.join(mod, "textures", "Item_Pistol.png"))
        os.makedirs(os.path.join(cls.downloads, "3000000009", "mods", "OldMod", "media"))  # Build 41 only
        # A mod that ships Stockroom (the editor's Stockroom tool is offered only with it).
        sr = os.path.join(cls.downloads, "3100000001", "mods", "Stockroom", "42", "media")
        write(os.path.join(sr, "lua", "client", "Stockroom", "Storage.lua"), "-- codec\n")
        write(os.path.join(sr, "scripts", "sr.txt"), "module SR {\n item Ledger {\n  ItemType = base:normal,\n }\n}\n")
        os.environ.update({"DATABASE_URL": DB, "FAKE_DOWNLOAD_DIR": cls.downloads,
                           "STEAM_API_BASE": f"http://127.0.0.1:{cls.server.server_port}",
                           "WORK_DIR": tempfile.mkdtemp()})

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        STEAM.clear()
        STEAM.update({"2200148440": {"title": "Guns", "time_updated": 1790000000},
                      "3000000009": {"title": "Old mod", "time_updated": 1790000000},
                      "3100000001": {"title": "Stockroom pack", "time_updated": 1790000000}})
        with psycopg.connect(DB, autocommit=True) as c:
            c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        subprocess.run(["node", "server/migrate.js"], cwd=ROOT, env={**os.environ, "DATABASE_URL": DB},
                       check=True, capture_output=True)
        with psycopg.connect(DB) as c:
            c.execute("INSERT INTO users (discord_id, username) VALUES ('100000000000000001', 'alice')")
            c.execute("INSERT INTO mods (kind, name) VALUES ('base', 'Project Zomboid')")
            c.execute("""INSERT INTO mod_versions (mod_id, label, game_version, icons, base_props)
                         SELECT id, 'Build 42.22', '42.22', '{"sheets":0}', '{"Base.Axe":{"type":"Weapon"}}' FROM mods""")

    def queue(self, ws, reason="request"):
        with psycopg.connect(DB) as c:
            c.execute("""INSERT INTO import_jobs (workshop_id, reason, requested_by)
                         VALUES (%s, %s, CASE WHEN %s = 'request' THEN (SELECT id FROM users) END)""", (ws, reason, reason))

    def one(self, sql, *args):
        with psycopg.connect(DB) as c:
            return c.execute(sql, args).fetchone()

    def test_imports_a_mod_and_credits_who_asked(self):
        import worker
        self.queue("2200148440")
        self.assertEqual(worker.cmd_run(), 1)
        status, err = self.one("SELECT status, error FROM import_jobs")
        self.assertEqual((status, err), ("done", None))
        name, added_by = self.one("SELECT m.name, u.username FROM mods m JOIN users u ON u.id = m.created_by WHERE m.kind = 'workshop'")
        self.assertEqual((name, added_by), ("Guns", "alice"))
        label, count, sheets, req = self.one("""SELECT v.label, v.item_count, (v.icons->>'sheets')::int, u.username
                                                  FROM mod_versions v JOIN users u ON u.id = v.requested_by""")
        self.assertEqual((label, count, sheets, req), ("2026-09-21 14:13 UTC", 1, 1, "alice"))
        item = self.one("SELECT full_type, name, default_category, icon_tile FROM catalog_items WHERE full_type = 'Guns.Pistol'")
        self.assertEqual(item, ("Guns.Pistol", "Pistol", "WepFire", 0))
        self.assertIsNotNone(self.one("SELECT 1 FROM icon_sheets"))

    def test_features_a_mod_provides_are_recorded_on_its_version(self):
        import worker
        self.queue("2200148440")
        self.queue("3100000001")
        self.assertEqual(worker.cmd_run(), 2)
        rows = dict(self.one_all("""SELECT m.workshop_id, v.features FROM mod_versions v
                                      JOIN mods m ON m.id = v.mod_id WHERE m.kind = 'workshop'"""))
        self.assertEqual(rows, {"2200148440": [], "3100000001": ["stockroom"]})
        log = self.one("SELECT log FROM import_jobs WHERE workshop_id = '3100000001'")[0]
        self.assertIn("features: stockroom", log)

    def one_all(self, sql, *args):
        with psycopg.connect(DB) as c:
            return c.execute(sql, args).fetchall()

    def test_the_same_update_twice_writes_one_version(self):
        import worker
        self.queue("2200148440")
        worker.cmd_run()
        self.queue("2200148440")
        worker.cmd_run()
        self.assertEqual(self.one("SELECT count(*) FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE m.kind = 'workshop'")[0], 1)
        self.assertEqual(self.one("SELECT count(*) FROM import_jobs WHERE status = 'done'")[0], 2)

    def test_a_build41_only_item_fails_with_a_reason(self):
        import worker
        self.queue("3000000009")
        worker.cmd_run()
        self.assertEqual(self.one("SELECT status, error FROM import_jobs"), ("failed", "No Build 42 mod in this Workshop item"))
        self.assertIsNone(self.one("SELECT 1 FROM mods WHERE kind = 'workshop'"))

    def test_an_item_gone_from_steam_fails_cleanly(self):
        import worker
        del STEAM["2200148440"]
        self.queue("2200148440")
        worker.cmd_run()
        self.assertEqual(self.one("SELECT status FROM import_jobs")[0], "failed")

    def test_hourly_check_queues_only_mods_that_changed(self):
        import worker
        self.queue("2200148440")
        worker.cmd_run()
        self.assertEqual(worker.cmd_check_updates(), 0, "nothing changed on Steam")
        STEAM["2200148440"]["time_updated"] = 1795000000
        self.assertEqual(worker.cmd_check_updates(), 1)
        self.assertEqual(worker.cmd_check_updates(), 0, "already queued, not queued twice")
        self.assertEqual(self.one("SELECT reason, requested_by FROM import_jobs WHERE status = 'queued'"), ("update", None))
        worker.cmd_run()
        self.assertEqual(self.one("SELECT count(*) FROM mod_versions v JOIN mods m ON m.id = v.mod_id WHERE m.kind = 'workshop'")[0], 2)

    def test_each_run_and_each_jobs_log_are_recorded(self):
        import worker
        self.queue("2200148440")
        self.queue("3000000009")
        worker.cmd_run()
        run = self.one("SELECT kind, status, processed, succeeded, failed, finished_at IS NOT NULL FROM importer_runs")
        self.assertEqual(run, ("import", "succeeded", 2, 1, 1, True))
        ok_log, bad_log = (self.one("SELECT log FROM import_jobs WHERE workshop_id = %s", w)[0] for w in ("2200148440", "3000000009"))
        self.assertIn("Imported 2200148440", ok_log)
        self.assertIn("No Build 42 mod", bad_log)
        self.assertNotIn("2200148440", bad_log, "each job keeps only its own lines")
        self.assertEqual(self.one("SELECT count(*) FROM import_jobs WHERE run_id IS NOT NULL")[0], 2)
        worker.cmd_check_updates()
        self.assertEqual(self.one("SELECT kind, status, processed FROM importer_runs ORDER BY id DESC LIMIT 1"),
                         ("check-updates", "succeeded", 1))

    def test_jobs_left_running_by_a_dead_worker_are_retried(self):
        import worker
        self.queue("2200148440")
        with psycopg.connect(DB) as c:
            c.execute("UPDATE import_jobs SET status = 'running', attempts = 1, started_at = now() - interval '3 hours'")
        worker.cmd_run()
        self.assertEqual(self.one("SELECT status, attempts FROM import_jobs"), ("done", 2))


if __name__ == "__main__":
    unittest.main()
