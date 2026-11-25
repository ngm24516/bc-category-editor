"""ATM sell values from Server Economy (Workshop 3728629828, mod id ServerEconomy).

Only reads text: nothing from the mod is run. The mod builds its ATM table (HZ.Sellables) in Lua; this module
reads the same data files and applies the same small rules, mirroring:

  media/lua/shared/HZEconomySellables.lua
      ["Base.GoldBar"] = { baseValue = 325, restockCategory = "special_rewards", ... },   (one item per line)
      sell category: "valuables" for clothing, else "junk_collectibles", then the lists in sellCategoryItems
      then every shop product in buybackCategories (firearms, ammunition boxes/cartons/crates, magazines,
      weapon attachments) becomes sellable:
          value = floor(basePrice x GlobalPricePercent x <Category>PricePercent) x 10% x (product buybackPercent / 10)
      firearms also scale with condition (x 0.25 .. 1)
  media/lua/shared/HZEconomyProducts.lua         the shop: category = { { itemType = "...", basePrice = N }, ... }
  media/lua/shared/HZEconomyGunsOfMarzProducts.lua
      when SWMG and GunsOfMarz are both active: removes the vanilla guns it replaces and adds Guns of Marz guns,
      ammunition, magazines and attachments from its price tables (buyback 5% for "low buyback" items)
  media/sandbox-options.txt                      defaults: SellValuePercent 25, <Category>SellValuePercent ...

HZEconomyShared.getAtmSellRawValue pays value x SellValuePercent x the item's sell-category percent. We store
value x the category percent's default (e.g. OneLife coins 50%), and the editor applies SellValuePercent (the
"ATM sell %" the user sets, 25 by default). Sandbox price percents are taken at their defaults.

read_economy() returns None for other mods, else:
  { "atm": {fullType: value}, "condition": [fullTypes that pay less when worn],
    "variants": [{ "requires": ["SWMG", "GunsOfMarz"], "atm": {...}, "condition": [...] }] }
"""
import math
import os
import re

SHARED = os.path.join("lua", "shared")
FILES = {"sellables": "HZEconomySellables.lua", "products": "HZEconomyProducts.lua", "gom": "HZEconomyGunsOfMarzProducts.lua"}
GOM_MODS = ["SWMG", "GunsOfMarz"]
MAX_FILE = 4 * 1024 * 1024
FULL_TYPE = r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_.\-]+"

SELLABLE = re.compile(r'^\s*\[\s*"(' + FULL_TYPE + r')"\s*\]\s*=\s*\{([^}]*)\}')
FIELD_NUM = r"\b{}\s*=\s*([0-9]+(?:\.[0-9]+)?)"
FIELD_STR = r'\b{}\s*=\s*"([^"]*)"'
PRODUCT = re.compile(r'^\s*\{[^}]*\bitemType\s*=\s*"(' + FULL_TYPE + r')"[^}]*\}')
CATEGORY = re.compile(r"^\s{4}([a-z_]+)\s*=\s*\{\s*$")

# The shop's category -> its "<Name>PricePercent" sandbox option (HZEconomyShared.getSandbox).
PRICE_OPTIONS = {"weapons_melee": "Melee", "weapons_firearms": "Firearms", "ammunition": "Ammunition",
                 "magazines": "Magazines", "weapon_attachments": "WeaponAttachments"}
# Sell category -> its "<Name>SellValuePercent" sandbox option.
SELL_OPTIONS = {"general": "General", "junk_collectibles": "JunkCollectibles", "valuables": "Valuables",
                "farm_produce": "FarmProduce", "herbs_medical": "HerbsMedical", "hemp_products": "HempProducts",
                "onelife_currency": "OneLifeCurrency", "precious_metals": "PreciousMetals", "lab_ingots": "LabIngots",
                "weapons_firearms": "Firearms", "ammunition": "AmmunitionCategory"}
DEFAULT_BUYBACK = ["weapons_firearms", "ammunition", "magazines", "weapon_attachments"]


def _read(path):
    if not os.path.isfile(path) or os.path.getsize(path) > MAX_FILE:
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _num(text, name):
    m = re.search(FIELD_NUM.format(name), text)
    return float(m.group(1)) if m else None


def _block(text, start_pattern):
    """The text of the first `<start_pattern> { ... }` block, matching braces (comments and strings skipped)."""
    m = re.search(start_pattern, text)
    if not m:
        return None
    i, depth, out = text.index("{", m.start()), 0, []
    while i < len(text):
        c = text[i]
        if c == "-" and text.startswith("--", i):
            i = text.find("\n", i)
            if i < 0:
                break
            continue
        if c == '"':
            j = text.find('"', i + 1)
            out.append(text[i:j + 1])
            i = j + 1
            continue
        out.append(c)
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return "".join(out)
        i += 1
    return None


def _strings(block):
    return re.findall(r'"([^"]*)"', block or "")


def _number_table(block):
    """{ KEY=1, ["KEY"]=2, KEY={3, "..."} } -> {"KEY": number} (first number of a nested table)."""
    out = {}
    for m in re.finditer(r'(?:\[\s*"([^"]+)"\s*\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(\{\s*)?([0-9]+(?:\.[0-9]+)?|true)', block or ""):
        key = m.group(1) or m.group(2)
        out[key] = True if m.group(4) == "true" else float(m.group(4))
    return out


def _sandbox_defaults(text):
    out = {}
    for m in re.finditer(r"option\s+ServerEconomy\.([A-Za-z]+)\s*\{([^}]*)\}", text or ""):
        d = re.search(r"\bdefault\s*=\s*([0-9.]+)", m.group(2))
        if d:
            out[m.group(1)] = float(d.group(1))
    return out


def _products(text):
    """{category: [(itemType, basePrice, buybackPercent or None)]} from HZEconomyProducts.lua's literal table."""
    out, cat = {}, None
    for line in (text or "").splitlines():
        c = CATEGORY.match(line)
        if c:
            cat = c.group(1)
            out.setdefault(cat, [])
            continue
        p = PRODUCT.match(line)
        if p and cat:
            price = _num(line, "basePrice")
            if price is not None:
                out[cat].append((p.group(1), price, _num(line, "buybackPercent")))
    return out


# ---- Guns of Marz (HZEconomyGunsOfMarzProducts.lua), the same rules as its Lua
def _gom_products(text):
    groups = {m.group(1): m.group(2).split() for m in re.finditer(r'(\w+)\s*=\s*list\("([^"]*)"\)', _block(text, r"local GROUPS\s*=") or "")}
    replaced = re.search(r'ipairs\(list\("([^"]*)"\)\)\s*do\s*VANILLA_REPLACED', text)
    tables = {name: _number_table(_block(text, rf"local {name}\s*=")) for name in
              ("WEAPON_PRICES", "LOW_BUYBACK", "MAGAZINE_PRICES", "MAGAZINE_CAPACITIES", "AMMO_PRICES", "SPECIAL_AMMO", "ATTACHMENT_PRICES")}
    if not groups or not replaced or not tables["WEAPON_PRICES"]:
        raise ValueError("Guns of Marz price tables not found")
    t = tables

    def tier(item):
        for pat in (r"Magazine(\d+)", r"Clip(\d+)", r"Box(\d+)"):
            m = re.search(pat, item)
            if m:
                return int(m.group(1))
        return 6

    def capacity(item):
        return int(t["MAGAZINE_CAPACITIES"].get(item) or tier(item))

    def magazine_price(item):
        if item in t["MAGAZINE_PRICES"]:
            return t["MAGAZINE_PRICES"][item]
        c = tier(item)
        high = {40: 1800, 50: 3500, 60: 5000, 75: 7500, 100: 12000, 150: 18000}
        if c in high:
            return high[c]
        if c <= 18:
            return 400 if c <= 8 else 500 if c <= 10 else 550 if c <= 13 else 600
        if item[:4] == "9x19" or item[:2] == "45":
            return 600 if c <= 20 else 1000
        return 800 if c <= 20 else 1200

    def ammo_price(item):
        prefix = item.split("_", 1)[0]
        special = t["SPECIAL_AMMO"].get(item.rsplit("_", 1)[-1]) if "_" in item else None
        price = special or t["AMMO_PRICES"].get(prefix)
        if not price:
            raise ValueError(f"Missing GoM ammo price: {item}")
        return price * (12 if "Carton" in item else 1)

    products = {}

    def add(category, item, price):
        if not price or price <= 0:
            raise ValueError(f"Missing GoM price: {item}")
        full = "MarzGuns." + item
        if item == "9x19Magazine17_GLOCK17":
            full = "MarzGuns.9x19Magazine17_GLOCK"
        if item == "2Bore_Bullet":
            full = "SWMG.2Bore_Bullet"
        low = (t["LOW_BUYBACK"].get(item) or "Suppressor" in item
               or (category == "magazines" and (capacity(item) >= 40 or item == "12GMagazine20_AA12")))
        products.setdefault(category, []).append((full, math.floor(price), 5 if low else 10))

    for group in "pistols revolvers shotguns leverRifles boltRifles semiRifles battleRifles assaultRifles smgs lmgs launchers explosives melee".split():
        for item in groups.get(group, []):
            add("weapons_melee" if group == "melee" else "weapons_firearms", item, t["WEAPON_PRICES"].get(item))
    for item in groups.get("ammunition", []):
        add("ammunition", item, ammo_price(item))
    add("ammunition", "2Bore_Bullet", 250)
    for item in groups.get("magazines", []):
        add("magazines", item, magazine_price(item))
    for item in groups.get("attachments", []):
        add("weapon_attachments", item, t["ATTACHMENT_PRICES"].get(item))
    for item in groups.get("supplies", []):
        add("weapon_attachments", item, 2000)
    return products, set(replaced.group(1).split())


def _sell_table(sellables, products, buyback, sandbox):
    """{fullType: value with the sell category's default percent} and the condition-scaled types."""
    pct = lambda opt, default=100: sandbox.get(opt, default)  # noqa: E731
    global_pct = pct("GlobalPricePercent")
    out, condition = {}, []
    for ft, (base, sell_cat) in sellables.items():
        out[ft] = base * pct(SELL_OPTIONS.get(sell_cat, "General") + "SellValuePercent") / 100
    for cat in buyback:
        cat_pct = pct(PRICE_OPTIONS.get(cat, "") + "PricePercent") if cat in PRICE_OPTIONS else 100
        sell_pct = pct(SELL_OPTIONS[cat] + "SellValuePercent") if cat in SELL_OPTIONS else 100
        for ft, price, bp in products.get(cat, []):
            if price <= 0 or (cat == "ammunition" and not any(w in ft for w in ("Box", "Carton", "Crate"))):
                continue
            vend = max(1, math.floor(price * global_pct / 100 * cat_pct / 100))
            out[ft] = vend * 10 / 100 * ((bp / 10) if bp else 1) * sell_pct / 100
            if cat == "weapons_firearms":
                condition.append(ft)
            elif ft in condition:
                condition.remove(ft)
    return {k: (int(v) if float(v).is_integer() else round(v, 4)) for k, v in out.items()}, sorted(set(condition) & set(out))


def read_economy(media_roots):
    for media in media_roots:
        shared = os.path.join(media, SHARED)
        sell_text = _read(os.path.join(shared, FILES["sellables"]))
        if sell_text is None:
            continue
        sandbox = _sandbox_defaults(_read(os.path.join(media, "sandbox-options.txt")))
        sellables = {}
        for line in sell_text.splitlines():
            m = SELLABLE.match(line)
            if m:
                base = _num(m.group(2), "baseValue")
                if base is not None and 0 <= base < 1e9:
                    restock = re.search(FIELD_STR.format("restockCategory"), m.group(2))
                    sellables[m.group(1)] = [base, "valuables" if restock and restock.group(1) == "clothing" else "junk_collectibles"]
        for m in re.finditer(r"(\w+)\s*=\s*\{([^{}]*)\}", _block(sell_text, r"local sellCategoryItems\s*=") or ""):
            for ft in _strings(m.group(2)):
                if ft in sellables:
                    sellables[ft][1] = m.group(1)
        sellables = {ft: tuple(v) for ft, v in sellables.items()}
        buyback = _strings(_block(sell_text, r"local buybackCategories\s*=")) or DEFAULT_BUYBACK
        products = _products(_read(os.path.join(shared, FILES["products"])))
        atm, condition = _sell_table(sellables, products, buyback, sandbox)
        result = {"atm": atm, "condition": condition, "variants": []}

        gom_text = _read(os.path.join(shared, FILES["gom"]))
        if gom_text:
            try:
                gom, replaced = _gom_products(gom_text)
            except ValueError:
                gom = None
            if gom:
                merged = {c: [p for p in items if p[0] not in replaced] for c, items in products.items()}
                for c, items in gom.items():
                    merged.setdefault(c, []).extend(items)
                v_atm, v_cond = _sell_table(sellables, merged, buyback, sandbox)
                for alias, canonical in (("MarzGuns.Bipod_Deployed", "MarzGuns.Bipod_Folded"),
                                         ("MarzGuns.Beretta_Stock_Deployed", "MarzGuns.Beretta_Stock_Folded")):
                    if canonical in v_atm:
                        v_atm[alias] = v_atm[canonical]
                result["variants"].append({"requires": GOM_MODS, "atm": v_atm, "condition": v_cond})
        return result
    return None


def atm_values(media_roots):
    """{fullType: value} without optional add-ons (kept for callers that only need the plain table)."""
    r = read_economy(media_roots)
    return r["atm"] if r else {}
