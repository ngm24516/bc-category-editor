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
                  "module Base {\n item Axe {\n DisplayCategory = Weapon,\n }\n}\nmodule MyMod {\n item Gun {\n Type = Weapon,\n Icon = MyGun,\n Weight = 1.25,\n }\n"
                  " item Note {\n Type = Normal,\n }\n}")
            write(os.path.join(media, "lua", "shared", "Translate", "EN", "ItemName.json"), '{ "ItemName_MyMod.Gun": "My Gun" }')
            buf = io.BytesIO()
            Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(buf, "PNG")
            os.makedirs(os.path.join(media, "textures"))
            with open(os.path.join(media, "textures", "Item_MyGun.png"), "wb") as f:
                f.write(buf.getvalue())
            bc = os.path.join(d, "bc")
            os.makedirs(bc)
            base = {"Base.Axe": {"type": "Weapon", "icon": "Axe", "displaycategory": "Tool", "weight": "3"}}
            layer = build_layer([media], bc, base_props=base)
            rows = {r[0]: r for r in layer["items"]}
            self.assertEqual(rows["MyMod.Gun"][1], "My Gun")
            self.assertGreaterEqual(rows["MyMod.Gun"][5], 0, "icon tile found")
            self.assertEqual(rows["Base.Axe"][2], "Weapon", "the mod's DisplayCategory wins")
            self.assertEqual(rows["Base.Axe"][5], -1, "no icon of its own: the editor reuses the base game's")
            self.assertEqual(rows["Base.Axe"][6], "Axe")
            self.assertEqual(len(layer["sheets"]), 1)
            self.assertEqual(rows["MyMod.Gun"][7], 1.25, "the script's Weight")
            self.assertEqual(rows["Base.Axe"][7], 3.0, "a partial redefinition keeps the base game's weight")
            self.assertEqual(rows["MyMod.Note"][7], 1.0, "no Weight: the game's default")
            self.assertIn("weight", layer["props"]["MyMod.Gun"], "kept for later layers")


class EconomyTests(unittest.TestCase):
    def test_atm_values_are_read_from_the_sellables_table_without_running_it(self):
        from pzcatalog.economy import atm_values
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            write(os.path.join(media, "lua", "shared", "HZEconomySellables.lua"), "\n".join([
                "local Sellables = {",
                '    ["Base.GoldBar"] = { baseValue = 325, restockCategory = "special_rewards", restockOnSell = false }, -- 8 small ingots',
                '    ["Base.Necklace_Gold"] = { baseValue = 3, restockCategory = "clothing", restockOnSell = false },',
                '    ["LabItems.FrnSilverIngot"]={baseValue=2.5,restockCategory="x"},',
                '    -- ["Base.Commented"] = { baseValue = 9 },',
                '    ["Base.NoValue"] = { restockCategory = "clothing" },',
                '    ["not an item"] = { baseValue = 4 },',
                "}", "for _, x in pairs(Sellables) do x.sellCategory = 'junk' end", "return Sellables"]))
            self.assertEqual(atm_values([media]), {"Base.GoldBar": 325, "Base.Necklace_Gold": 3, "LabItems.FrnSilverIngot": 2.5})
            self.assertEqual(atm_values([os.path.join(d, "nothing")]), {})

    def write_economy(self, media, gom=True):
        """A small Server Economy laid out like the real one (Sellables, Products, Guns of Marz, sandbox options)."""
        shared = os.path.join(media, "lua", "shared")
        write(os.path.join(shared, "HZEconomySellables.lua"), "\n".join([
            "local Sellables = {",
            '    ["Base.GoldBar"] = { baseValue = 325, restockCategory = "special_rewards", restockOnSell = false },',
            '    ["OneLifeClothing.Coin"] = { baseValue = 40, restockCategory = "special_rewards" },',
            '    ["Base.Pistol"] = { baseValue = 7, restockCategory = "special_rewards" },',
            "}",
            "local sellCategoryItems = {",
            "    onelife_currency = {",
            '        "OneLifeClothing.Coin", -- a coin',
            "    },",
            "}",
            "local Products = require(\"HZEconomyProducts\")",
            "local buybackCategories = {",
            '    "weapons_firearms",',
            '    "ammunition",',
            '    "magazines",',
            '    "weapon_attachments",',
            "}",
            "for i = 1, #buybackCategories do Sellables[x] = { baseValue = basePrice, buybackPercent = 10 } end",
            "return Sellables"]))
        write(os.path.join(shared, "HZEconomyProducts.lua"), "\n".join([
            "local Products = {",
            "    weapons_melee = {",
            '    { id = "weapons_melee_axe", itemType = "Base.Axe", basePrice = 2800 }, -- Axe',
            "    },",
            "    weapons_firearms = {",
            '    { id = "weapons_firearms_pistol", itemType = "Base.Pistol", basePrice = 3000 }, -- Pistol',
            '    { id = "weapons_firearms_rifle", itemType = "Base.HuntingRifle", basePrice = 5005, buybackPercent = 5 },',
            "    },",
            "    ammunition = {",
            '    { id = "ammunition_9mm", itemType = "Base.Bullets9mm", basePrice = 10 },',
            '    { id = "ammunition_9mm_box", itemType = "Base.Bullets9mmBox", basePrice = 200 },',
            "    },",
            "    magazines = {",
            '    { id = "magazines_9mm", itemType = "Base.9mmClip", basePrice = 500 },',
            "    },",
            "}",
            'local GunsOfMarzProducts = require("HZEconomyGunsOfMarzProducts")',
            "GunsOfMarzProducts.apply(Products)",
            "return Products"]))
        if gom:
            write(os.path.join(shared, "HZEconomyGunsOfMarzProducts.lua"), "\n".join([
                'local REQUIRED_MODS = { "SWMG", "GunsOfMarz" }',
                "local GROUPS = {",
                '    pistols = list("DEAGLE GLOCK17"),',
                '    shotguns = list("AA12"),',
                '    melee = list("M9_BAYONET"),',
                '    ammunition = list("9x19_Box 9x19_Carton 12Gauge_Box_Slug"),',
                '    magazines = list("9x19Magazine17_GLOCK17 12GMagazine20_AA12 9x19Magazine10_P226 556x45Magazine50_STANAG"),',
                '    attachments = list("Bipod_Folded M&P_Suppressor"),',
                '    supplies = list("RepairPack"),',
                "}",
                "local VANILLA_REPLACED = {}",
                'for _, itemType in ipairs(list("Base.Pistol Base.Bullets9mmBox Base.9mmClip")) do',
                "    VANILLA_REPLACED[itemType] = true",
                "end",
                "local LOW_BUYBACK = { AA12=true }",
                'local WEAPON_PRICES = { DEAGLE=11000, GLOCK17=3600, AA12=24000, M9_BAYONET=1800 }',
                'local MAGAZINE_PRICES = { ["12GMagazine20_AA12"]=12000 }',
                'local MAGAZINE_CAPACITIES = { ["556x45Magazine50_STANAG"] = 60 }',
                'local AMMO_PRICES = { ["12Gauge"]=300, ["9x19"]=200 }',
                "local SPECIAL_AMMO = {",
                '    Slug={600, "Single projectile."},',
                "}",
                'local ATTACHMENT_PRICES = { Bipod_Folded=2500, ["M&P_Suppressor"]=7500 }',
                "return Catalog"]))
        write(os.path.join(media, "sandbox-options.txt"), "\n".join([
            "option ServerEconomy.SellValuePercent", "{", "    type = integer,", "    default = 25,", "}",
            "option ServerEconomy.OneLifeCurrencySellValuePercent", "{", "    type = integer,", "    default = 50,", "}",
            "option ServerEconomy.HubX", "{", "    type = integer,", "    default = 10615,", "}",
            "option ServerEconomyContraband.EnableMeth", "{", "    type = boolean,", "    default = true,", "}",
            "option ServerEconomyContraband.BandMinCrystalMeth", "{", "    type = integer,", "    default = 200,", "}"]))
        write(os.path.join(shared, "HZContrabandShared.lua"), "\n".join([
            'local function product(id, name, family, key, price, uses)', '    local p = {}', 'end',
            'product("CrystalMeth", "Crystal meth bag", "Meth", "Meth", 300, 10)',
            'product("LSD", "LSD", "Psychedelics", "LSD", 100, 5)']))

    def test_the_atm_buys_back_what_the_gun_shop_sells(self):
        from pzcatalog.economy import read_economy
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            self.write_economy(media, gom=False)
            e = read_economy([media])
            self.assertEqual(e["atm"], {
                "Base.GoldBar": 325,
                "OneLifeClothing.Coin": 20,          # onelife_currency sells at 50% by default
                "Base.Pistol": 300,                  # the gun shop's 3000 x 10% replaces the listed 7
                "Base.HuntingRifle": 250.25,         # 5005 x 10% x (5 / 10)
                "Base.Bullets9mmBox": 20,            # boxes only: loose bullets aren't bought
                "Base.9mmClip": 50,
            })
            self.assertEqual(e["condition"], ["Base.HuntingRifle", "Base.Pistol"])
            self.assertEqual(e["variants"], [])
            self.assertIsNone(read_economy([os.path.join(d, "nothing")]))

    def test_the_server_settings_change_the_atm_price_like_the_mod(self):
        from pzcatalog.economy import atm_value, read_economy
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            self.write_economy(media, gom=False)
            e = read_economy([media])
            self.assertEqual(e["defaults"], {"SellValuePercent": 25, "OneLifeCurrencySellValuePercent": 50,
                                             "EnableMeth": 1, "BandMinCrystalMeth": 200}, "economy settings only")
            self.assertEqual(e["shop"], {"Base.Axe": [2800, "weapons_melee"], "Base.Pistol": [3000, "weapons_firearms"],
                                         "Base.HuntingRifle": [5005, "weapons_firearms"], "Base.Bullets9mm": [10, "ammunition"],
                                         "Base.Bullets9mmBox": [200, "ammunition"], "Base.9mmClip": [500, "magazines"]},
                             "everything the server store sells")
            self.assertEqual(e["blackMarket"], {"NnC.CrystalMeth": ["Meth", "PriceMeth", "CrystalMeth"],
                                                "NnC.LSD": ["Psychedelics", "PriceLSD", "LSD"]})
            self.assertEqual(e["raw"]["Base.Pistol"], [3000, "weapons_firearms", "weapons_firearms", 1])
            self.assertEqual(e["raw"]["Base.HuntingRifle"], [5005, "weapons_firearms", "weapons_firearms", 0.5])
            # OneLife's settings (from its console log): a silver bar (165, precious metals) sells for 115.
            server = {"SellValuePercent": 200, "PreciousMetalsSellValuePercent": 35, "FirearmsPricePercent": 125,
                      "FirearmsSellbackPercent": 2, "AmmunitionPricePercent": 225, "AmmunitionSellbackPercent": 1}
            self.assertEqual(atm_value([165, "precious_metals"], server, with_sell_percent=True), 115.5)
            # pistol: floor(3000 x 125%) = 3750, x 2% sellback = 75, x 200% = 150
            self.assertEqual(atm_value(e["raw"]["Base.Pistol"], server, with_sell_percent=True), 150)
            # 9mm box: floor(200 x 225%) = 450, x 1% = 4.5, x 200% = 9
            self.assertEqual(atm_value(e["raw"]["Base.Bullets9mmBox"], server, with_sell_percent=True), 9)
            self.assertEqual(atm_value(e["raw"]["OneLifeClothing.Coin"], {**e["defaults"], **server}, with_sell_percent=True), 40)

    def test_guns_of_marz_prices_are_a_variant_for_setups_with_it(self):
        from pzcatalog.economy import read_economy
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            self.write_economy(media)
            e = read_economy([media])
            self.assertEqual(e["atm"]["Base.Pistol"], 300, "without Guns of Marz the vanilla pistol stays")
            v = e["variants"][0]
            self.assertEqual(v["requires"], ["SWMG", "GunsOfMarz"])
            atm = v["atm"]
            self.assertEqual(atm["Base.Pistol"], 7, "Guns of Marz removes it from the gun shop: only its listed value is left")
            self.assertNotIn("Base.9mmClip", atm)
            self.assertEqual(atm["Base.HuntingRifle"], 250.25, "not replaced")
            self.assertEqual(atm["MarzGuns.DEAGLE"], 1100)
            self.assertEqual(atm["MarzGuns.AA12"], 1200, "low buyback: 5%")
            self.assertNotIn("MarzGuns.M9_BAYONET", atm, "melee isn't bought back")
            self.assertEqual(atm["MarzGuns.9x19_Box"], 20)
            self.assertEqual(atm["MarzGuns.9x19_Carton"], 240, "a carton is 12 boxes")
            self.assertEqual(atm["MarzGuns.12Gauge_Box_Slug"], 60, "special ammunition price")
            self.assertEqual(atm["MarzGuns.9x19Magazine17_GLOCK"], 60, "the mod's fixed item type; 17 rounds: 600")
            self.assertEqual(atm["MarzGuns.12GMagazine20_AA12"], 600, "listed price, low buyback")
            self.assertEqual(atm["MarzGuns.9x19Magazine10_P226"], 50, "10 rounds: 500")
            self.assertEqual(atm["MarzGuns.556x45Magazine50_STANAG"], 175, "tier 50: 3500, low buyback (60 rounds)")
            self.assertEqual(atm["MarzGuns.M&P_Suppressor"], 375, "suppressors: low buyback")
            self.assertEqual(atm["MarzGuns.RepairPack"], 200)
            self.assertEqual(atm["MarzGuns.Bipod_Deployed"], atm["MarzGuns.Bipod_Folded"], "deployed sells as folded")
            self.assertIn("MarzGuns.DEAGLE", v["condition"])
            self.assertEqual(v["shop"]["MarzGuns.DEAGLE"], [11000, "weapons_firearms"])
            self.assertNotIn("Base.Pistol", v["shop"], "Guns of Marz takes it out of the store")
            self.assertNotIn("MarzGuns.9x19_Box", v["condition"])

    def test_a_guns_of_marz_file_it_cannot_read_is_skipped(self):
        from pzcatalog.economy import read_economy
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            self.write_economy(media, gom=False)
            write(os.path.join(media, "lua", "shared", "HZEconomyGunsOfMarzProducts.lua"), "return {}")
            e = read_economy([media])
            self.assertEqual(e["variants"], [])
            self.assertEqual(e["atm"]["Base.Pistol"], 300)

    def test_server_economy_is_known_by_its_mod_id_and_its_file(self):
        with tempfile.TemporaryDirectory() as d:
            media = os.path.join(d, "media")
            write(os.path.join(media, "lua", "shared", "HZEconomySellables.lua"), "local Sellables = {}")
            self.assertEqual(detect_features([media]), ["atm"])
        self.assertEqual(detect_features([], ["ServerEconomy"]), ["atm"])


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

    def test_stockroom_is_also_known_by_its_mod_id(self):
        self.assertEqual(detect_features([], ["Stockroom"]), ["stockroom"])
        self.assertEqual(detect_features([], ["stockroom", "Other"]), ["stockroom"])
        self.assertEqual(detect_features([], ["StockroomAddon"]), [])


if __name__ == "__main__":
    unittest.main()
