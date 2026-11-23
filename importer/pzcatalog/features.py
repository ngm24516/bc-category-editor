"""Editor features a mod provides, found by looking at file names only (nothing is opened or run).

stockroom: the mod ships Stockroom, whose saves the editor's "Stockroom books" tool reads. Recognised by
           its save codec, media/lua/<side>/Stockroom/Storage.lua.
"""
import os

SIGNS = {
    "stockroom": ("stockroom", "storage.lua"),
}


def detect_features(media_roots):
    """Sorted list of feature names found under these media folders."""
    found = set()
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
