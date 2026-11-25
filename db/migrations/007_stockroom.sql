-- Stockroom inventories (user data): what each of a user's characters has in their safehouse, imported from
-- the Stockroom mod's save files. The editor decodes the save in the browser and sends only the totals.
CREATE TABLE stockroom_characters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stockroom's own "server|world|character" identity, so a re-import replaces the same character.
  identity     text NOT NULL CHECK (length(identity) BETWEEN 1 AND 300),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  sequence     bigint NOT NULL DEFAULT 0,          -- the save's own counter: which save this was
  houses       jsonb NOT NULL DEFAULT '[]',         -- [{ name, containers }]
  items        jsonb NOT NULL DEFAULT '{}',         -- { "Base.Axe": 3, ... } summed over every container
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, identity)
);
ALTER TABLE stockroom_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE stockroom_characters FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_stockroom ON stockroom_characters
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
