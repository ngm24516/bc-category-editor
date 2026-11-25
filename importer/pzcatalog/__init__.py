"""Turn Project Zomboid game or Workshop files into catalog data for the category editor.

Only reads text and image files. Never runs anything from a mod.
"""
GAME_VERSION = (42, 22)
# Catalog data format: 2 adds item weights and ATM values. Mods with older versions are re-imported once.
FORMAT = 2
TILE, COLS = 32, 64
PER_SHEET = COLS * COLS
