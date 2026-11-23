"""Item icons: from .pack texture atlases (the game's UI.pack, or a mod's own packs) or loose Item_*.png files.

Every icon is trimmed and fitted into a 32 px tile; tiles are laid out 64 across in WebP sheets.
"""
import io
import os
import struct

from PIL import Image

from . import COLS, PER_SHEET, TILE

MAX_PACK_BYTES = 256 * 1024 * 1024


def parse_pack(path):
    """{texture name: (atlas image, x, y, w, h, ox, oy, frame w, frame h)} from a .pack file."""
    if os.path.getsize(path) > MAX_PACK_BYTES:
        return {}
    b = open(path, "rb").read()
    o, ver = 0, 0
    if b[:4] == b"PZPK":
        ver = struct.unpack_from("<i", b, 4)[0]
        o = 8

    def i32():
        nonlocal o
        v = struct.unpack_from("<i", b, o)[0]
        o += 4
        return v

    def s():
        nonlocal o
        n = i32()
        v = b[o:o + n].decode("utf-8", "replace")
        o += n
        return v

    out = {}
    try:
        for _ in range(i32()):
            s()
            n = i32()
            i32()
            ents = [(s(),) + tuple(i32() for _ in range(8)) for _ in range(n)]
            if ver >= 1:
                sz = i32()
                png = b[o:o + sz]
                o += sz
            else:
                e = b.index(b"\xef\xbe\xad\xde", o)
                png = b[o:e]
                o = e + 4
            # Only atlases that hold item icons are worth decoding.
            if not any(nm.startswith("Item_") for nm, *_ in ents):
                continue
            img = Image.open(io.BytesIO(png)).convert("RGBA")
            for nm, x, y, w, h, ox, oy, fw, fh in ents:
                out[nm] = (img, x, y, w, h, ox, oy, fw, fh)
    except (struct.error, ValueError, OSError):
        pass  # a damaged or unknown pack format: keep what was read
    return out


def pack_image(entry):
    img, x, y, w, h, ox, oy, fw, fh = entry
    frame = Image.new("RGBA", (max(fw, w + ox, 1), max(fh, h + oy, 1)))
    frame.paste(img.crop((x, y, x + w, y + h)), (ox, oy))
    return frame


def fit(img):
    bb = img.getbbox()
    if bb:
        img = img.crop(bb)
    w, h = img.size
    sc = min(TILE / w, TILE / h, 2.0)
    nw, nh = max(1, round(w * sc)), max(1, round(h * sc))
    img = img.resize((nw, nh), Image.LANCZOS if sc < 1 else Image.NEAREST)
    out = Image.new("RGBA", (TILE, TILE))
    out.paste(img, ((TILE - nw) // 2, (TILE - nh) // 2))
    return out


class IconSource:
    """Looks up icon names in the given media folders (later folders win) and texture packs."""

    def __init__(self, media_roots):
        self.loose = {}   # lower-case name -> path
        self.pack = {}
        for media in media_roots:
            tex = os.path.join(media, "textures")
            if os.path.isdir(tex):
                for dp, _, fs in os.walk(tex):
                    for f in fs:
                        if f.lower().endswith(".png"):
                            full = os.path.join(dp, f)
                            rel = os.path.relpath(full, tex).replace("\\", "/")[:-4]
                            self.loose[rel.lower()] = full
                            base = os.path.basename(rel)
                            if base.lower().startswith("item_"):
                                self.loose[base[5:].lower()] = full
            packs = os.path.join(media, "texturepacks")
            if os.path.isdir(packs):
                for f in sorted(os.listdir(packs)):
                    if f.lower().endswith(".pack"):
                        self.pack.update(parse_pack(os.path.join(packs, f)))

    def image(self, icon):
        if not icon:
            return None
        p = self.loose.get(icon.lower())
        try:
            if p:
                return fit(Image.open(p).convert("RGBA"))
            for name in ("Item_" + icon, icon):
                if name in self.pack:
                    return fit(pack_image(self.pack[name]))
        except (OSError, ValueError):
            return None
        return None


class SheetBuilder:
    def __init__(self):
        self.tiles, self.index = [], {}

    def add(self, key, loader):
        if key in self.index:
            return self.index[key]
        img = loader()
        if img is None:
            self.index[key] = -1
            return -1
        self.index[key] = len(self.tiles)
        self.tiles.append(img)
        return self.index[key]

    def sheets(self):
        """WebP bytes for each sheet."""
        out = []
        for s in range(0, len(self.tiles), PER_SHEET):
            chunk = self.tiles[s:s + PER_SHEET]
            rows = (len(chunk) + COLS - 1) // COLS
            sheet = Image.new("RGBA", (COLS * TILE, rows * TILE))
            for i, im in enumerate(chunk):
                sheet.paste(im, ((i % COLS) * TILE, (i // COLS) * TILE))
            buf = io.BytesIO()
            sheet.save(buf, "WEBP", lossless=True, quality=100, method=6)
            out.append(buf.getvalue())
        return out
