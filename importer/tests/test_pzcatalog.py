"""Unit tests for the file readers. Run: python3 -m unittest discover -s importer/tests"""
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image  # noqa: E402

from pzcatalog.build import build_layer  # noqa: E402
from pzcatalog.features import detect_features  # noqa: E402
from pzcatalog.rules import default_categories  # noqa: E402
from pzcatalog.scripts import parse_scripts, workshop_mods  # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class ScriptTests(unittest.TestCase):
    def test_items_inside_modules_with_nested_blocks_and_comments(self):
        text = """
        module Base {
            /* item Commented { } */
            item Axe {
                DisplayCategory = Tool,  // trailing comment
                ItemType = base:weapon,
                component Durability { MaxCondition = 10, }
                Icon = Axe,
            }
            item 97BushCar { Type = Normal, }
        }"""
        got = {f"{m}.{n}": p for m, n, p in parse_scripts(text)}
        self.assertEqual(set(got), {"Base.Axe", "Base.97BushCar"})
        self.assertEqual(got["Base.Axe"]["displaycategory"], "Tool")
        self.assertNotIn("maxcondition", got["Base.Axe"], "nested block properties are ignored")

    def test_b42_folder_choice(self):
        with tempfile.TemporaryDirectory() as d:
            for v in ("common", "42", "42.20.0", "42.99"):
                os.makedirs(os.path.join(d, "mods", "M", v, "media"))
            os.makedirs(os.path.join(d, "mods", "OldB41", "media"))
            write(os.path.join(d, "mods", "M", "42.20.0", "mod.info"), "id=MyMod\nname=My Mod\n")
            mods = workshop_mods(d, (42, 22))
            self.assertEqual([m["id"] for m in mods], ["MyMod"], "B41-only mods are skipped")
            self.assertEqual([os.path.basename(os.path.dirname(p)) for p in mods[0]["media"]], ["common", "42.20.0"])


class RuleTests(unittest.TestCase):
    def test_explicit_beats_wildcard_and_fallbacks(self):
        items = {
            "Base.Apple": {"type": "Food", "daystotallyrotten": "10"},
            "Base.Beans": {"type": "Food"},
            "Base.Gun": {"itemtype": "base:weapon", "tags": "base:firearm"},
            "Base.Book": {"type": "Literature", "skilltrained": "Carpentry"},
            "Base.Rock": {"displaycategory": "Junk"},
        }
        rules = {"Fruit": ["Base.Apple"], "Stuff": ["Base.*"]}
        got = default_categories(items, rules)
        self.assertEqual(got["Base.Apple"], "Fruit")
        self.assertEqual(got["Base.Rock"], "Stuff")
        self.assertEqual(default_categories(items, {})["Base.Beans"], "FoodN")
        self.assertEqual(default_categories(items, {})["Base.Apple"], "FoodP")
        self.assertEqual(default_categories(items, {})["Base.Gun"], "WepFire")
        self.assertEqual(default_categories(items, {})["Base.Book"], "LitS")


class LayerTests(unittest.TestCase):
    def test_mod_layer_merges_with_base_and_finds_loose_icons(self):
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            write(os.path.join(media, "scripts", "items.txt"),
                  "module Base {\n item Axe {\n DisplayCategory = Weapon,\n }\n}\nmodule MyMod {\n item Gun {\n Type = Weapon,\n Icon = MyGun,\n }\n}")
            write(os.path.join(media, "lua", "shared", "Translate", "EN", "ItemName.json"), '{ "ItemName_MyMod.Gun": "My Gun" }')
            buf = io.BytesIO()
            Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(buf, "PNG")
            os.makedirs(os.path.join(media, "textures"))
            with open(os.path.join(media, "textures", "Item_MyGun.png"), "wb") as f:
                f.write(buf.getvalue())
            bc = os.path.join(d, "bc")
            os.makedirs(bc)
            base = {"Base.Axe": {"type": "Weapon", "icon": "Axe", "displaycategory": "Tool"}}
            layer = build_layer([media], bc, base_props=base)
            rows = {r[0]: r for r in layer["items"]}
            self.assertEqual(rows["MyMod.Gun"][1], "My Gun")
            self.assertGreaterEqual(rows["MyMod.Gun"][5], 0, "icon tile found")
            self.assertEqual(rows["Base.Axe"][2], "Weapon", "the mod's DisplayCategory wins")
            self.assertEqual(rows["Base.Axe"][5], -1, "no icon of its own: the editor reuses the base game's")
            self.assertEqual(rows["Base.Axe"][6], "Axe")
            self.assertEqual(len(layer["sheets"]), 1)


class FeatureTests(unittest.TestCase):
    def test_stockroom_is_found_by_its_storage_file_in_any_lua_side(self):
        with tempfile.TemporaryDirectory() as d:
            plain, sr = os.path.join(d, "a", "media"), os.path.join(d, "b", "media")
            write(os.path.join(plain, "lua", "client", "Stockroom", "README.lua"), "")   # folder name alone isn't enough
            write(os.path.join(plain, "lua", "client", "Other", "Storage.lua"), "")      # nor the file elsewhere
            self.assertEqual(detect_features([plain]), [])
            write(os.path.join(sr, "lua", "shared", "StockRoom", "storage.lua"), "")
            self.assertEqual(detect_features([plain, sr]), ["stockroom"])
            self.assertEqual(detect_features([os.path.join(d, "missing")]), [])


if __name__ == "__main__":
    unittest.main()
