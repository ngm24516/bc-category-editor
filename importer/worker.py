#!/usr/bin/env python3
"""The importer: turns queued Workshop items into catalog versions.

  python3 worker.py run             drain the queue (an Azure Container Apps Job starts this when jobs are queued)
  python3 worker.py check-updates   hourly: ask Steam which catalog mods changed and queue their new versions
  python3 worker.py smoke           download Better Containers with SteamCMD and check its rule files (CI smoke test)
  python3 worker.py market          hourly: record every listing of every marketplace (see market.py)

For each job: claim it, download the Workshop item anonymously with SteamCMD, read its scripts, translations
and icons with pzcatalog (which only reads files; nothing from a mod is ever run), write a new mod version in
one transaction, delete the download. A version is never changed once written.

Environment: DATABASE_URL, STEAMCMD (path to steamcmd.sh), WORK_DIR, STEAM_API_BASE, MAX_JOBS (per run),
FAKE_DOWNLOAD_DIR (tests only: <dir>/<workshop id> stands in for a download).
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pzcatalog import ATM_FORMAT, COLS, FORMAT, GAME_VERSION, PER_SHEET, TILE  # noqa: E402
from pzcatalog.economy import read_economy  # noqa: E402
from pzcatalog.build import build_layer  # noqa: E402
from pzcatalog.features import detect_features  # noqa: E402
from pzcatalog.rules import bc_lua_root  # noqa: E402
from pzcatalog.scripts import workshop_mods  # noqa: E402

PZ_APP_ID = 108600
BC_WORKSHOP_ID = "3586216562"         # Better Containers: its rule files give each item's default category
MAX_BYTES = 4 * 1024 ** 3              # same limit the API checks before queueing
DOWNLOAD_TIMEOUT = 30 * 60
STALE_AFTER = "2 hours"                # a 'running' job this old belongs to a worker that died
MAX_ATTEMPTS = 3


JOB_LOG = []   # lines logged while a job is being processed; saved on the job for the admin dashboard


def log(msg):
    line = f"{datetime.now(timezone.utc):%H:%M:%S} {msg}"
    print(line, flush=True)
    JOB_LOG.append(line)


# ------------------------------------------------------------------ Steam
def steam_details(ids, page_limit=200):
    """{id: {title, updated (datetime), size, app, ok, removed}} from Steam's public Workshop API, 100 at a time.

    Steam's API answers "no such item" for some public mods; those (up to page_limit) are read from their
    public change-notes page instead (see item_from_page)."""
    base = os.environ.get("STEAM_API_BASE", "https://api.steampowered.com").rstrip("/")
    out = {}
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        form = {"itemcount": str(len(chunk))}
        form.update({f"publishedfileids[{k}]": v for k, v in enumerate(chunk)})
        req = urllib.request.Request(f"{base}/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
                                     data=urllib.parse.urlencode(form).encode(), method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.load(r)
        for d in body.get("response", {}).get("publishedfiledetails", []):
            out[str(d.get("publishedfileid"))] = {
                "ok": d.get("result") == 1 and not d.get("banned"),
                "title": (d.get("title") or "")[:200] or None,
                "updated": datetime.fromtimestamp(int(d["time_updated"]), timezone.utc) if d.get("time_updated") else None,
                "size": int(d.get("file_size") or 0),
                "app": int(d.get("consumer_app_id") or d.get("creator_app_id") or 0),
                "removed": bool(d.get("banned")),
            }
    hidden = [i for i in ids if not out.get(i, {}).get("ok") and not out.get(i, {}).get("removed")][:page_limit]
    for ws in hidden:
        try:
            found = item_from_page(ws)
        except (OSError, ValueError) as e:
            log(f"Couldn't read Steam's page for {ws}: {e}")
            continue
        if found:
            out[ws] = found
    return out


def item_from_page(workshop_id):
    """Details of a public item Steam's API won't describe, read from its change-notes page; None when the
    page shows no item. updated is the newest change note's time (each note is <p id="<unix time>">)."""
    base = os.environ.get("STEAM_COMMUNITY_BASE", "https://steamcommunity.com").rstrip("/")
    req = urllib.request.Request(f"{base}/sharedfiles/filedetails/changelog/{workshop_id}",
                                 headers={"Accept": "text/html", "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=20) as r:
        page = r.read(4 * 1024 * 1024).decode("utf-8", "replace")
    return parse_item_page(page)


def parse_item_page(page):
    title = re.search(r'class="workshopItemTitle"[^>]*>([^<]{1,300})<', page)
    app = re.search(r"steamcommunity\.com/app/(\d{1,10})", page)
    if not title or not app or not html.unescape(title.group(1)).strip():
        return None
    note = re.search(r'class="[^"]*\bchangeLogCtn\b[^"]*"[\s\S]*?<p id="(\d{9,11})"', page)
    return {
        "ok": True, "removed": False, "from_page": True,
        "title": html.unescape(title.group(1)).strip()[:200],
        "updated": datetime.fromtimestamp(int(note.group(1)), timezone.utc) if note else None,
        "size": 0, "app": int(app.group(1)),
    }


def download(workshop_id, work_dir):
    """Folder holding the downloaded Workshop item (mods/<mod>/<version>/media/…)."""
    fake = os.environ.get("FAKE_DOWNLOAD_DIR")
    if fake:
        path = os.path.join(fake, workshop_id)
        if not os.path.isdir(path):
            raise RuntimeError("Steam didn't deliver this Workshop item")
        return path
    steam_dir = os.path.join(work_dir, "steam")
    cmd = [os.environ.get("STEAMCMD", "/opt/steamcmd/steamcmd.sh"), "+force_install_dir", steam_dir,
           "+login", "anonymous", "+workshop_download_item", str(PZ_APP_ID), workshop_id, "validate", "+quit"]
    path = os.path.join(steam_dir, "steamapps", "workshop", "content", str(PZ_APP_ID), workshop_id)
    # SteamCMD sometimes times out on a large first download and succeeds when asked again.
    for attempt in range(2):
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT)
        if os.path.isdir(path):
            break
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-3:]
        log(f"SteamCMD attempt {attempt + 1} for {workshop_id} failed: {' | '.join(tail)}")
    else:
        raise RuntimeError("Steam didn't deliver this Workshop item (SteamCMD download failed)")
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(path) for f in fs)
    if size > MAX_BYTES:
        raise RuntimeError("Larger than 4 GB")
    return path


# ------------------------------------------------------------------ database
def connect():
    import psycopg
    return psycopg.connect(os.environ["DATABASE_URL"])


def Jsonb(value):  # noqa: N802 - imported lazily so the file-reading tests don't need psycopg
    from psycopg.types.json import Jsonb as _Jsonb
    return _Jsonb(value)


def claim(conn, run_id=None):
    """Take the oldest queued job. SKIP LOCKED lets several workers run without taking the same job."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE import_jobs SET status = 'running', started_at = now(), attempts = attempts + 1, run_id = %s
             WHERE id = (SELECT id FROM import_jobs WHERE status = 'queued'
                          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING id, workshop_id, reason, requested_by, source_updated_at, title, attempts""", (run_id,))
        row = cur.fetchone()
    conn.commit()
    if not row:
        return None
    return dict(zip(["id", "workshop_id", "reason", "requested_by", "source_updated_at", "title", "attempts"], row))


def recover_stale(conn):
    with conn.cursor() as cur:
        cur.execute(f"""
            UPDATE import_jobs
               SET status = CASE WHEN attempts >= {MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
                   error = CASE WHEN attempts >= {MAX_ATTEMPTS} THEN 'The importer stopped part-way through, {MAX_ATTEMPTS} times' END,
                   finished_at = CASE WHEN attempts >= {MAX_ATTEMPTS} THEN now() END
             WHERE status = 'running' AND started_at < now() - interval '{STALE_AFTER}'""")
        n = cur.rowcount
    conn.commit()
    if n:
        log(f"Recovered {n} job(s) left running by a stopped worker")


def base_props(conn):
    with conn.cursor() as cur:
        cur.execute("""SELECT v.base_props FROM mod_versions v JOIN mods m ON m.id = v.mod_id
                        WHERE m.kind = 'base' ORDER BY v.created_at DESC LIMIT 1""")
        row = cur.fetchone()
    if not row or not row[0]:
        raise RuntimeError("The base game isn't in the catalog yet (start the web app once to load it)")
    return row[0]


def write_version(conn, job, title, mod_ids, updated, layer, features=(), economy=None):
    """One transaction: the mod (created on first import, crediting who asked), the version, items, names, icons.

    economy is read_economy()'s result: the ATM values go in `atm`, the rest (condition-scaled items, values that
    apply with other mods) in `atm_extra`. The same update in an older data format (e.g. without weights) doesn't
    count: a new version is written."""
    fmt = ATM_FORMAT if economy or "atm" in features else FORMAT   # see _check_updates
    atm = economy["atm"] if economy else None
    extra = {k: economy[k] for k in ("raw", "condition", "defaults", "variants") if economy.get(k)} if economy else None
    label = updated.strftime("%Y-%m-%d %H:%M UTC") if updated else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO mods (kind, workshop_id, name, created_by) VALUES ('workshop', %s, %s, %s)
                       ON CONFLICT (workshop_id) DO UPDATE SET name = EXCLUDED.name RETURNING id""",
                    (job["workshop_id"], title, job["requested_by"]))
        mod_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM mod_versions WHERE mod_id = %s AND label = %s AND format >= %s", (mod_id, label, fmt))
        existing = cur.fetchone()
        if existing:   # this exact update is already in the catalog (e.g. two jobs raced): nothing to write
            return mod_id, existing[0]
        icons = {"tile": TILE, "cols": COLS, "perSheet": PER_SHEET, "sheets": len(layer["sheets"])}
        cur.execute("""INSERT INTO mod_versions (mod_id, label, source_updated_at, game_version, mod_ids, icons,
                                                 item_count, requested_by, source_title, features, format, atm, atm_extra)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (mod_id, label, updated, ".".join(map(str, GAME_VERSION)), mod_ids, Jsonb(icons),
                     len(layer["items"]), job["requested_by"], title, list(features), fmt,
                     Jsonb(atm) if atm else None, Jsonb(extra) if extra else None))
        version_id = cur.fetchone()[0]
        with cur.copy("COPY catalog_items (version_id, full_type, name, display_category, default_category, "
                      "item_type, icon_tile, icon_name, weight) FROM STDIN") as cp:
            for r in layer["items"]:
                cp.write_row((version_id, *r))
        for k, v in layer["catNames"].items():
            cur.execute("""INSERT INTO catalog_category_names (version_id, category_id, display_name)
                           VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""", (version_id, k[:200], v[:200]))
        for i, webp in enumerate(layer["sheets"]):
            cur.execute("INSERT INTO icon_sheets (version_id, sheet, webp) VALUES (%s, %s, %s)", (version_id, i, webp))
    return mod_id, version_id


def finish(conn, job_id, status, mod_id=None, version_id=None, error=None):
    text = "\n".join(JOB_LOG)[-6000:]
    with conn.cursor() as cur:
        cur.execute("""UPDATE import_jobs SET status = %s, mod_id = %s, version_id = %s, error = %s, finished_at = now(),
                              log = %s
                        WHERE id = %s""", (status, mod_id, version_id, error[:500] if error else None, text, job_id))
    conn.commit()


def start_run(conn, kind):
    with conn.cursor() as cur:
        cur.execute("INSERT INTO importer_runs (kind) VALUES (%s) RETURNING id", (kind,))
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def end_run(conn, run_id, processed, succeeded, failed, error=None):
    conn.rollback()  # whatever was in flight when it failed
    with conn.cursor() as cur:
        cur.execute("""UPDATE importer_runs SET status = %s, finished_at = now(), processed = %s, succeeded = %s,
                              failed = %s, error = %s WHERE id = %s""",
                    ("failed" if error else "succeeded", processed, succeeded, failed, error[:500] if error else None, run_id))
    conn.commit()


# ------------------------------------------------------------------ commands
class Rules:
    """Better Containers' rule files, downloaded once per run."""
    def __init__(self, work_dir):
        self.work_dir, self.lua = work_dir, None

    def get(self):
        if not self.lua:
            path = download(BC_WORKSHOP_ID, os.path.join(self.work_dir, "bc"))
            self.lua = bc_lua_root(os.path.join(path, "mods", "BetterContainers"))
        return self.lua


def process(conn, job, rules, props, work_dir):
    ws = job["workshop_id"]
    item_dir = tempfile.mkdtemp(prefix=f"ws{ws}-", dir=work_dir)
    try:
        info = steam_details([ws]).get(ws) or {}
        if not info.get("ok") or info.get("app") != PZ_APP_ID:
            raise RuntimeError("No longer available on Steam as a Project Zomboid mod")
        path = download(ws, item_dir)
        mods = workshop_mods(path)
        if not mods:
            raise RuntimeError("No Build 42 mod in this Workshop item")
        media = [m for mod in mods for m in mod["media"]]
        layer = build_layer(media, rules.get(), base_props=props,
                            mod_ids=[m["id"] for m in mods], workshop_ids=[ws])
        features = detect_features(media, [m["id"] for m in mods])
        economy = read_economy(media)
        title = info.get("title") or job["title"] or mods[0]["name"]
        mod_id, version_id = write_version(conn, job, title, [m["id"] for m in mods], info.get("updated"), layer,
                                           features, economy)
        conn.commit()
        log(f"Imported {ws} '{title}': {len(layer['items'])} items, {len(layer['sheets'])} icon sheet(s)"
            + (f", features: {', '.join(features)}" if features else "")
            + (f", ATM values for {len(economy['atm'])} items" if economy else "")
            + "".join(f" (+{len(v['atm'])} with {' + '.join(v['requires'])})" for v in (economy or {}).get("variants", [])))
        finish(conn, job["id"], "done", mod_id, version_id)
        return True
    except Exception as err:  # noqa: BLE001 - every failure is recorded on the job, never lost
        conn.rollback()
        msg = str(err) if isinstance(err, RuntimeError) else "The importer couldn't read this mod's files"
        log(f"Failed {ws}: {err}")
        if not isinstance(err, RuntimeError):
            for line in traceback.format_exc().strip().splitlines()[-6:]:
                log(line)
        finish(conn, job["id"], "failed", error=msg)
        return False
    finally:
        shutil.rmtree(item_dir, ignore_errors=True)


def cmd_run():
    work_dir = os.environ.get("WORK_DIR") or tempfile.mkdtemp(prefix="importer-")
    os.makedirs(work_dir, exist_ok=True)
    max_jobs = int(os.environ.get("MAX_JOBS", "20"))
    with connect() as conn:
        run_id = start_run(conn, "import")
        done = ok = 0
        try:
            recover_stale(conn)
            rules, props = Rules(work_dir), None
            while done < max_jobs:
                job = claim(conn, run_id)
                if not job:
                    break
                JOB_LOG.clear()
                log(f"Job {job['id']}: {job['reason']} {job['workshop_id']} ({job['title'] or 'untitled'}), attempt {job['attempts']}")
                if props is None:
                    props = base_props(conn)
                ok += process(conn, job, rules, props, work_dir)
                done += 1
        except Exception as err:
            end_run(conn, run_id, done, ok, done - ok, error=str(err) or type(err).__name__)
            raise
        end_run(conn, run_id, done, ok, done - ok)
    JOB_LOG.clear()
    log(f"Processed {done} job(s), {ok} imported, {done - ok} failed")
    return done


def cmd_check_updates():
    """Queue a new import for every catalog mod Steam says has changed since its newest version."""
    with connect() as conn:
        run_id = start_run(conn, "check-updates")
        try:
            return _check_updates(conn, run_id)
        except Exception as err:
            end_run(conn, run_id, 0, 0, 0, error=str(err) or type(err).__name__)
            raise


def _check_updates(conn, run_id):
    with conn.cursor() as cur:
        cur.execute("""SELECT m.workshop_id, max(v.source_updated_at), max(v.format),
                              bool_or('atm' = ANY(v.features)
                                      OR 'servereconomy' = ANY(string_to_array(lower(array_to_string(v.mod_ids, ',')), ',')))
                         FROM mods m JOIN mod_versions v ON v.mod_id = m.id
                        WHERE m.kind = 'workshop' GROUP BY m.workshop_id""")
        rows = cur.fetchall()
        have = {ws: latest for ws, latest, _, _ in rows}
        # Mods whose newest data is in an older format (e.g. no weights; an ATM without gun buybacks) are imported
        # again, once.
        stale = {ws for ws, _, fmt, atm in rows if (fmt or 1) < (ATM_FORMAT if atm else FORMAT)}
    if not have:
        log("No Workshop mods in the catalog yet")
        end_run(conn, run_id, 0, 0, 0)
        return 0
    info = steam_details(list(have))
    queued = 0
    with conn.cursor() as cur:
        for ws, latest in have.items():
            d = info.get(ws)
            if d and d["ok"] and d["updated"] and (latest is None or d["updated"] > latest or ws in stale):
                cur.execute("""INSERT INTO import_jobs (workshop_id, reason, source_updated_at, title)
                               VALUES (%s, 'update', %s, %s)
                               ON CONFLICT (workshop_id) WHERE status IN ('queued', 'running') DO NOTHING""",
                            (ws, d["updated"], d["title"]))
                queued += cur.rowcount
    conn.commit()
    end_run(conn, run_id, len(have), queued, 0)
    log(f"Checked {len(have)} mod(s); queued {queued} update(s)"
        + (f" ({len(stale)} in an older data format)" if stale else ""))
    return queued


def cmd_smoke():
    """Download Better Containers for real and check its rule files: proves SteamCMD works in this image."""
    work_dir = tempfile.mkdtemp(prefix="smoke-")
    started = time.time()
    lua = Rules(work_dir).get()
    rules_dir = os.path.join(lua, "client", "BetterContainers", "Categorize", "Categories", "vanilla")
    n = len([f for f in os.listdir(rules_dir) if f.endswith(".lua")])
    log(f"Downloaded Better Containers in {time.time() - started:.0f}s; {n} rule files in {lua}")
    if n < 5:
        raise SystemExit("Expected Better Containers' rule files")
    shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command == "market":
        import market
        market.cmd_market()
    else:
        {"run": cmd_run, "check-updates": cmd_check_updates, "smoke": cmd_smoke}.get(command, lambda: sys.exit(__doc__))()
