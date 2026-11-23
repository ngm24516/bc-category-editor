"""Build the catalog data for one layer: the base game, or one Workshop item on top of it."""
from .icons import IconSource, SheetBuilder
from .rules import default_categories, item_type, load_rules
from .scripts import load_translations, scan_media

# The script properties the default-category rules and the editor need. Kept for the base game so a
# mod's partial redefinition of a vanilla item can be merged with the original.
RULE_PROPS = ("displaycategory", "type", "itemtype", "tags", "daystotallyrotten", "skilltrained",
              "learnedrecipes", "teachedrecipes", "stresschange", "boredomchange", "unhappychange",
              "ranged", "obsolete", "icon", "iconsfortexture", "displayname")


def _icon_name(props):
    icon = props.get("icon", "") or props.get("iconsfortexture", "").split(";")[0].strip()
    return icon[5:] if icon.lower().startswith("item_") else icon


def build_layer(media_roots, bc_lua, base_props=None, mod_ids=(), workshop_ids=(), extra_translation_dirs=()):
    """Returns {items, catNames, sheets, props}.

    items:   [fullType, name, displayCategory, defaultCategory, type, iconTile, iconName] for every item
             this layer defines (iconTile -1 = no icon of its own; the editor then reuses an earlier
             layer's icon with the same name).
    props:   merged rule-relevant props of this layer's items (kept for the base game).
    """
    own, names, catnames = {}, {}, {}
    for media in media_roots:
        scan_media(media, own, names, catnames)
    for d in extra_translation_dirs:
        load_translations(d, names, catnames)

    merged = {ft: {**(base_props or {}).get(ft, {}), **p} for ft, p in own.items()}
    if base_props:
        context = {**base_props, **merged}
    else:
        context = merged
    rules = load_rules(bc_lua, mod_ids, workshop_ids)
    defaults = default_categories(context, rules, only=merged.keys())

    icons, sheets = IconSource(media_roots), SheetBuilder()
    rows = []
    for ft in sorted(merged):
        p = merged[ft]
        if p.get("obsolete", "").lower() == "true":
            continue
        name = names.get(ft) or p.get("displayname", "") or ft.split(".", 1)[1]
        icon = _icon_name(p)
        tile = -1
        if icon and ("icon" in own[ft] or "iconsfortexture" in own[ft]):
            tile = sheets.add(icon.lower(), lambda i=icon: icons.image(i))
        rows.append([ft, name[:200], p.get("displaycategory", "")[:200], (defaults.get(ft) or "")[:200],
                     item_type(p)[:60], tile, icon[:200]])
    keep = {ft: {k: v for k, v in p.items() if k in RULE_PROPS} for ft, p in merged.items()}
    return {"items": rows, "catNames": catnames, "sheets": sheets.sheets(), "props": keep}
