-- More ATM data from Server Economy (format 3): it also buys back what its gun shop sells (firearms, ammunition
-- boxes, magazines, attachments), at 10% (5% for some) of the shop price. Those values go in `atm` like the rest;
-- atm_extra holds what depends on the item or the server's other mods:
--   { "condition": ["Base.Pistol", ...],                      firearms: pay less when worn (down to 25%)
--     "variants": [{ "requires": ["SWMG", "GunsOfMarz"],      with both these mods active, Server Economy's
--                    "atm": {...}, "condition": [...] }] }    whole ATM table becomes this one instead
ALTER TABLE mod_versions ADD COLUMN atm_extra jsonb;
