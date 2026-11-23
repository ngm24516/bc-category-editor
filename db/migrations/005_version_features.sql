-- Features the editor offers only when a chosen mod provides them, detected by the importer from the mod's
-- files (for example 'stockroom' when the mod ships Stockroom's Lua). Versions written before this have none
-- until their next update is imported.
ALTER TABLE mod_versions ADD COLUMN features text[] NOT NULL DEFAULT '{}';
