"""ATM sell values from economy mods. Only reads text; nothing from the mod is run.

Server Economy (Workshop 3728629828, mod id ServerEconomy) lists what its ATMs buy in
media/lua/shared/HZEconomySellables.lua, one item per line:

    ["Base.GoldBar"] = { baseValue = 325, restockCategory = "special_rewards", restockOnSell = false },

The ATM pays baseValue x SellValuePercent / 100 (a sandbox option, 25 by default) x the item's sell-category
percent / 100 (100 by default); see HZEconomyShared.getAtmSellRawValue in the mod. We keep baseValue; the editor
applies the percent, which each server sets.
"""
import os
import re

SELLABLES = os.path.join("lua", "shared", "HZEconomySellables.lua")
LINE = re.compile(r'^\s*\[\s*"([A-Za-z0-9_\-]+\.[A-Za-z0-9_.\-]+)"\s*\]\s*=\s*\{[^}]*?\bbaseValue\s*=\s*([0-9]+(?:\.[0-9]+)?)')


def atm_values(media_roots):
    """{fullType: baseValue} from every HZEconomySellables.lua under these media folders, or {}."""
    out = {}
    for media in media_roots:
        path = os.path.join(media, SELLABLES)
        if not os.path.isfile(path) or os.path.getsize(path) > 4 * 1024 * 1024:
            continue
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = LINE.match(line)
                if m:
                    v = float(m.group(2))
                    if 0 <= v < 1e9:
                        out[m.group(1)] = int(v) if v.is_integer() else v
    return out
