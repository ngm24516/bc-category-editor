#!/usr/bin/env python3
"""Build the base-game seed (seed/vanilla/) from files collected on a PC that owns the game.

The game itself can't be downloaded anonymously, so the base layer is built once from the collector's
output and committed. The server loads it into the catalog on start-up if that game version is missing.

  python3 importer/seed_vanilla.py <collected PZItems folder> <collected PZIcons folder> <out dir>
"""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pzcatalog import COLS, FORMAT, GAME_VERSION, PER_SHEET, TILE  # noqa: E402
from pzcatalog.build import build_layer  # noqa: E402
from pzcatalog.rules import bc_lua_root  # noqa: E402


def main(items_root, icons_root, out):
    bc_lua = bc_lua_root(os.path.join(items_root, "bettercontainers", "mods", "BetterContainers"))
    layer = build_layer(
        [os.path.join(items_root, "vanilla", "media"), os.path.join(icons_root, "vanilla", "media")],
        bc_lua,
        # Better Containers' own category names
        extra_translation_dirs=[os.path.join(bc_lua, "shared", "Translate", "EN")],
    )
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    for i, sheet in enumerate(layer["sheets"]):
        with open(os.path.join(out, f"icons{i}.webp"), "wb") as f:
            f.write(sheet)
    game = ".".join(map(str, GAME_VERSION))
    with gzip.open(os.path.join(out, "catalog.json.gz"), "wt", encoding="utf-8") as f:
        json.dump({
            "game": game,
            "label": f"Build {game}",
            "format": FORMAT,
            "icons": {"tile": TILE, "cols": COLS, "perSheet": PER_SHEET, "sheets": len(layer["sheets"])},
            "items": layer["items"],
            "catNames": layer["catNames"],
            "props": layer["props"],
        }, f, ensure_ascii=False, separators=(",", ":"))
    with_icon = sum(1 for r in layer["items"] if r[5] >= 0)
    print(f"base game {game}: {len(layer['items'])} items, {with_icon} with icons, "
          f"{len(layer['sheets'])} icon sheets, {len(layer['catNames'])} category names")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
