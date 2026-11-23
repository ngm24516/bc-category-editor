-- 001_init: users, sessions, and each user's category setups.
--
-- Identity: a user is one Discord account (discord_id). Nothing else about them is stored
-- beyond the display name and avatar Discord returns for the "identify" scope.
--
-- Authorization: the three user-data tables have row-level security that is FORCED, so even
-- the table owner (the account the app connects as) only sees rows whose user_id matches the
-- per-transaction setting app.user_id. The API sets that from the session, never from the request.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id    text NOT NULL UNIQUE,
  username      text NOT NULL,
  display_name  text,
  avatar        text,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of the session token is stored, so a database leak can't be replayed as a login.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- A named setup, e.g. one per server ("OneLife", "ReginsPub").
CREATE TABLE category_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  blacklist  text NOT NULL DEFAULT 'Lore',
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  UNIQUE (id, user_id)  -- lets child rows prove their set belongs to the same user
);

-- CategoryOverrides.ini: [Module.Type] Category=<id>
CREATE TABLE overrides (
  set_id   uuid NOT NULL,
  user_id  uuid NOT NULL,
  item     text NOT NULL CHECK (length(item) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 200),
  PRIMARY KEY (set_id, item),
  FOREIGN KEY (set_id, user_id) REFERENCES category_sets(id, user_id) ON DELETE CASCADE
);

-- CustomCategories.ini: [<id>] DisplayName=<name>
CREATE TABLE custom_categories (
  set_id       uuid NOT NULL,
  user_id      uuid NOT NULL,
  category_id  text NOT NULL CHECK (length(category_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  PRIMARY KEY (set_id, category_id),
  FOREIGN KEY (set_id, user_id) REFERENCES category_sets(id, user_id) ON DELETE CASCADE
);

-- Row-level security. app.user_id is set with set_config(..., true), i.e. for the current transaction only.
CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

ALTER TABLE category_sets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_sets     FORCE  ROW LEVEL SECURITY;
ALTER TABLE overrides         ENABLE ROW LEVEL SECURITY;
ALTER TABLE overrides         FORCE  ROW LEVEL SECURITY;
ALTER TABLE custom_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_categories FORCE  ROW LEVEL SECURITY;

CREATE POLICY own_sets ON category_sets
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own_overrides ON overrides
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own_custom_categories ON custom_categories
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
