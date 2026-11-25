-- Item weights, and ATM sell values from economy mods (Server Economy's HZEconomySellables.lua).
-- Versions written before this have no weights; "format" tells them apart so the hourly check re-imports those
-- mods once (a new version: versions are never changed), and the base game seed is loaded again.
ALTER TABLE catalog_items ADD COLUMN weight real;                           -- the script's Weight; NULL when unknown
ALTER TABLE mod_versions  ADD COLUMN format integer NOT NULL DEFAULT 1;     -- 2 = has weights and ATM values
ALTER TABLE mod_versions  ADD COLUMN atm jsonb;                             -- { "Base.GoldBar": 325, ... } baseValue per item
ALTER TABLE mod_versions  DROP CONSTRAINT mod_versions_mod_id_label_key;
ALTER TABLE mod_versions  ADD CONSTRAINT mod_versions_mod_id_label_format_key UNIQUE (mod_id, label, format);
