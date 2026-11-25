"""Turn Project Zomboid game or Workshop files into catalog data for the category editor.

Only reads text and image files. Never runs anything from a mod.
"""
GAME_VERSION = (42, 22)
# Catalog data format: 2 adds item weights and ATM values. Mods with older versions are re-imported once.
FORMAT = 2
# 3: ATM values include what Server Economy buys back from its gun shop (weapons, ammo boxes, magazines,
# attachments) and the Guns of Marz prices. Only mods with an ATM are re-imported for it.
ATM_FORMAT = 3
TILE, COLS = 32, 64
PER_SHEET = COLS * COLS
