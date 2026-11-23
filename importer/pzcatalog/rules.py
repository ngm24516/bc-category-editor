"""Better Containers' default category for each item.

A reconstruction of the mod's Categorize.lua: explicit item lists beat wildcard patterns, longer
patterns beat shorter ones, and items no rule mentions fall back to rules based on the item's type.
"""
import os
import re

from .scripts import read

VANILLA_RULE_FILES = ["food", "literature", "weapons", "clothing", "household", "containers", "crafting",
                      "medical", "electronics_media", "survival", "world_objects", "vehicle", "farming"]
_LUA_CAT = re.compile(r"(?s)\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{(.*?)\}")


def _load_rule_file(path, rules):
    t = re.sub(r"--\[\[.*?\]\]", "", read(path), flags=re.S)
    t = re.sub(r"--[^\n]*", "", t)
    for cat, body in _LUA_CAT.findall(t):
        for s in re.findall(r'"([^"]+)"', body):
            rules.setdefault(cat, []).append(s)


def bc_lua_root(bc_mod_dir):
    """Newest Build 42 folder of the Better Containers mod (…/mods/BetterContainers)."""
    from .scripts import ver_tuple
    vers = [(vt, d) for d in os.listdir(bc_mod_dir) if (vt := ver_tuple(d)) and vt[0] == 42]
    return os.path.join(bc_mod_dir, max(vers)[1], "media", "lua")


def load_rules(bc_lua, mod_ids=(), workshop_ids=()):
    """Vanilla rule tables plus the mod packs whose mod or Workshop id is in the given sets."""
    rules = {}
    root = os.path.join(bc_lua, "client", "BetterContainers", "Categorize", "Categories")
    for f in VANILLA_RULE_FILES:
        p = os.path.join(root, "vanilla", f + ".lua")
        if os.path.exists(p):
            _load_rule_file(p, rules)
    applym = os.path.join(root, "_applyMods.lua")
    keys = set(mod_ids) | set(workshop_ids)
    if keys and os.path.exists(applym):
        for mods, path in re.findall(r'mods\s*=\s*\{([^}]*)\}\s*,\s*path\s*=\s*"([^"]+)"', read(applym)):
            if keys & set(re.findall(r'"([^"]+)"', mods)):
                p = os.path.join(root, "mods", path + ".lua")
                if os.path.exists(p):
                    _load_rule_file(p, rules)
    return rules


def _ptype(props):
    it = props.get("itemtype", "")
    if ":" in it:
        it = it.split(":", 1)[1]
    return (it or props.get("type", "")).lower()


def _tags(props):
    return {x.split(":", 1)[-1].strip().lower() for x in re.split(r"[;,]", props.get("tags", "")) if x.strip()}


def _perishable(props):
    if _ptype(props) != "food":
        return False
    try:
        d = float(props.get("daystotallyrotten", "-1"))
    except ValueError:
        return False
    return 0 < d < 1e9


def _num(props, k):
    try:
        return float(props.get(k, "0"))
    except ValueError:
        return 0.0


def _auto(props):
    dc, t, tg = props.get("displaycategory", ""), _ptype(props), _tags(props)
    if dc == "Water":
        return "FoodB"
    if t == "food":
        return "FoodP" if _perishable(props) else "FoodN"
    if t == "literature":
        if props.get("skilltrained"):
            return "LitS"
        if props.get("learnedrecipes") or props.get("teachedrecipes"):
            return "LitR"
        if _num(props, "stresschange") or _num(props, "boredomchange") or _num(props, "unhappychange"):
            return "LitE"
        return "LitW"
    if t == "ammo":
        return "Ammo"
    if t == "key":
        return "Key"
    if t == "medical":
        return "Med"
    if t == "container":
        return "Cont"
    if t == "weapon":
        if "fakeweapon" in tg or "fake_weapon" in tg:
            return dc or None
        if dc in ("Explosives", "Devices"):
            return "WepBomb"
        if "firearm" in tg:
            return "WepFire"
        if props.get("ranged", "").lower() == "true":
            return "WepRange"
        if dc in ("Gun", "Guns", "Firearm", "Firearms"):
            return "WepFire"
        return "WepMelee"
    return None


def item_type(props):
    return _ptype(props)


def default_categories(items, rules, only=None):
    """{fullType: category} for the items in `only` (default: all), using every item's merged props."""
    targets = sorted(only if only is not None else items)
    best = {}

    def set_best(ft, cat, spec, score):
        prev = best.get(ft)
        if prev is None or spec > prev[1] or (spec == prev[1] == 1 and score > prev[2]):
            best[ft] = (cat, spec, score)

    target_set = set(targets)
    for cat in sorted(rules):
        for e in rules[cat]:
            if "*" in e:
                rx = re.compile("^" + re.escape(e).replace(r"\*", ".*") + "$")
                score = len(e) - e.count("*")
                for ft in targets:
                    if rx.match(ft):
                        set_best(ft, cat, 1, score)
            elif e in target_set:
                set_best(e, cat, 2, 0)
    out = {}
    for ft in targets:
        props = items[ft]
        if ft in best:
            cat = best[ft][0]
            out[ft] = "FoodP" if cat == "FoodN" and _perishable(props) else cat
        else:
            out[ft] = _auto(props) or props.get("displaycategory", "")
    return out
