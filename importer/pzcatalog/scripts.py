"""Item scripts, translations and mod folders (same rules as the original extract.py)."""
import json
import os
import re

from . import GAME_VERSION


def read(path):
    with open(path, "rb") as f:
        b = f.read()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("utf-8", "replace")


def ver_tuple(name):
    m = re.fullmatch(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", name)
    return tuple(int(x) for x in m.groups() if x is not None) if m else None


def _strip_comments(t):
    t = re.sub(r"/\*.*?\*/", "", t, flags=re.S)
    return re.sub(r"(?m)//.*$", "", t)


ITEM_HEAD = re.compile(r"(?i)\b(item|module)\s+([A-Za-z0-9_][A-Za-z0-9_\-\.]*)\s*\{")


def parse_scripts(text):
    """Yield (module, name, props) for each item block directly inside a module."""
    t = _strip_comments(text)
    i, n, module = 0, len(t), None
    while True:
        m = ITEM_HEAD.search(t, i)
        if not m:
            return
        kind, name = m.group(1).lower(), m.group(2)
        start = m.end()
        if kind == "module":
            module, i = name, start
            continue
        depth, j = 1, start
        while j < n and depth:
            c = t[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            j += 1
        body = t[start:j - 1]
        top, d = [], 0
        for line in body.splitlines():
            if d == 0:
                top.append(line)
            d = max(0, d + line.count("{") - line.count("}"))
        props = {}
        for line in top:
            line = line.strip().rstrip(",")
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                    props[k.lower()] = v.strip().rstrip(",").strip()
        if module:
            yield module, name, props
        i = j


_KV = re.compile(r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _json_pairs(path):
    out = {}
    for k, v in _KV.findall(read(path)):
        try:
            v = json.loads('"' + v + '"')
        except ValueError:
            pass
        out[k] = v
    return out


def load_translations(folder, names, catnames):
    """English item names and Better Containers category names (IGUI_ItemCat_*)."""
    for fn in ("ItemName.json", "IG_UI.json"):
        p = os.path.join(folder, fn)
        if os.path.exists(p):
            for k, v in _json_pairs(p).items():
                if k.startswith("IGUI_ItemCat_"):
                    catnames[k[13:]] = v
                elif fn == "ItemName.json":
                    names[k[9:] if k.startswith("ItemName_") else k] = v
    for fn in ("ItemName_EN.txt", "IG_UI_EN.txt"):
        p = os.path.join(folder, fn)
        if os.path.exists(p):
            for k, v in re.findall(r'(\w[\w\.\-]*)\s*=\s*"((?:[^"\\]|\\.)*)"', read(p)):
                if k.startswith("IGUI_ItemCat_"):
                    catnames[k[13:]] = v
                elif k.startswith("ItemName_"):
                    names[k[9:]] = v


def scan_media(media_root, items, names, catnames):
    """Read item scripts and English translations under one media/ folder. Later calls win per field."""
    scripts = os.path.join(media_root, "scripts")
    if os.path.isdir(scripts):
        for dp, _, fs in sorted(os.walk(scripts)):
            for f in sorted(fs):
                if f.lower().endswith(".txt"):
                    for module, name, props in parse_scripts(read(os.path.join(dp, f))):
                        ft = f"{module}.{name}"
                        items[ft] = {**items.get(ft, {}), **props}
    tr = os.path.join(media_root, "lua", "shared", "Translate", "EN")
    if os.path.isdir(tr):
        load_translations(tr, names, catnames)


def _mod_info(folder):
    info = {}
    p = os.path.join(folder, "mod.info")
    if os.path.exists(p):
        for line in read(p).splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                info.setdefault(k.strip().lower(), v.strip())
    return info


def workshop_mods(workshop_dir, game_version=GAME_VERSION):
    """The mods inside one downloaded Workshop item that Build 42 would load.

    Returns [{id, name, media: [media folders, load order]}]. B42 loads common/ plus the highest
    numeric version folder <= the game version; B41-only mods are skipped.
    """
    mods_dir = os.path.join(workshop_dir, "mods")
    out = []
    if not os.path.isdir(mods_dir):
        return out
    for mod in sorted(os.listdir(mods_dir)):
        md = os.path.join(mods_dir, mod)
        if not os.path.isdir(md):
            continue
        vers = [(vt, sub) for sub in os.listdir(md)
                if (vt := ver_tuple(sub)) and vt[0] == 42 and vt <= game_version]
        has_common = os.path.isdir(os.path.join(md, "common"))
        if not vers and not has_common:
            continue
        best = max(vers)[1] if vers else None
        info = {**_mod_info(md), **_mod_info(os.path.join(md, best))} if best else _mod_info(md)
        media = [os.path.join(md, f, "media") for f in (["common"] + ([best] if best else []))
                 if os.path.isdir(os.path.join(md, f, "media"))]
        out.append({"id": info.get("id", mod), "name": info.get("name", mod), "media": media})
    return out
