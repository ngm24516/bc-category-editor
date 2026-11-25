"""Editor features a mod provides, found by looking at file names only (nothing is opened or run).

atm:       the mod has an ATM that buys items (Server Economy: HZEconomySellables.lua, mod id ServerEconomy).
stockroom: the mod ships Stockroom, whose saves the editor's "Stockroom books" tool reads. Recognised by
           its save codec, media/lua/<side>/Stockroom/Storage.lua, or by its mod.info id "Stockroom".
"""
import os

SIGNS = {
    "stockroom": ("stockroom", "storage.lua"),
    "atm": ("shared", "hzeconomysellables.lua"),
}
# mod.info ids that mean a feature (lower case); keep in step with FEATURE_MOD_IDS in server/catalog.js.
MOD_IDS = {"stockroom": "stockroom", "servereconomy": "atm"}


def detect_features(media_roots, mod_ids=()):
    """Sorted list of feature names found under these media folders or known from the mod.info ids."""
    found = {MOD_IDS[i.lower()] for i in mod_ids if i.lower() in MOD_IDS}
    for media in media_roots:
        lua = os.path.join(media, "lua")
        if not os.path.isdir(lua):
            continue
        for root, _dirs, files in os.walk(lua):
            folder = os.path.basename(root).lower()
            names = {f.lower() for f in files}
            for feature, (want_dir, want_file) in SIGNS.items():
                if folder == want_dir and want_file in names:
                    found.add(feature)
    return sorted(found)
