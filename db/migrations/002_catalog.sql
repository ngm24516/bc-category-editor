-- 002_catalog: the shared item catalog, and which mods each setup uses.
--
-- The catalog is the same for everyone and read-only for users: the base game plus every Workshop mod
-- anyone has imported. A mod has versions (one per Workshop update); each version holds the items and
-- icons that update defines. Setups pick mods; the editor always shows each mod's newest ready version.

CREATE TABLE mods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('base', 'workshop')),
  workshop_id  text UNIQUE CHECK (workshop_id ~ '^[0-9]{1,20}$'),
  name         text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'base') = (workshop_id IS NULL))
);
-- Only one base game row.
CREATE UNIQUE INDEX mods_one_base ON mods ((kind)) WHERE kind = 'base';
CREATE INDEX mods_name_idx ON mods (lower(name));

CREATE TABLE mod_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mod_id            uuid NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  label             text NOT NULL,             -- "Build 42.22", or the Workshop update time
  source_updated_at timestamptz,               -- Workshop "last updated"; NULL for the base game
  game_version      text NOT NULL,             -- game build the files were read for
  mod_ids           text[] NOT NULL DEFAULT '{}', -- mod.info ids inside the Workshop item
  icons             jsonb NOT NULL,            -- { tile, cols, perSheet, sheets }
  base_props        jsonb,                     -- base game only: script props later imports merge onto
  item_count        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mod_id, label)
);
CREATE INDEX mod_versions_latest_idx ON mod_versions (mod_id, created_at DESC);

CREATE TABLE icon_sheets (
  version_id uuid NOT NULL REFERENCES mod_versions(id) ON DELETE CASCADE,
  sheet      integer NOT NULL CHECK (sheet >= 0),
  webp       bytea NOT NULL,
  PRIMARY KEY (version_id, sheet)
);

CREATE TABLE catalog_items (
  version_id        uuid NOT NULL REFERENCES mod_versions(id) ON DELETE CASCADE,
  full_type         text NOT NULL,
  name              text NOT NULL,
  display_category  text NOT NULL DEFAULT '',
  default_category  text NOT NULL DEFAULT '',
  item_type         text NOT NULL DEFAULT '',
  icon_tile         integer NOT NULL DEFAULT -1,
  icon_name         text NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, full_type)
);

CREATE TABLE catalog_category_names (
  version_id   uuid NOT NULL REFERENCES mod_versions(id) ON DELETE CASCADE,
  category_id  text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY (version_id, category_id)
);

-- Which mods a setup uses, in load order (later mods win when two define the same item).
-- User data, so row-level security like the other setup tables.
CREATE TABLE set_mods (
  set_id   uuid NOT NULL,
  user_id  uuid NOT NULL,
  mod_id   uuid NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  position integer NOT NULL,
  PRIMARY KEY (set_id, mod_id),
  FOREIGN KEY (set_id, user_id) REFERENCES category_sets(id, user_id) ON DELETE CASCADE
);
ALTER TABLE set_mods ENABLE ROW LEVEL SECURITY;
ALTER TABLE set_mods FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_set_mods ON set_mods
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
