-- The names an account sells under on the marketplaces (the listings' owner_name), so the editor can mark items
-- the user is selling that someone else now lists cheaper. User data: row-level security like 001_init.sql.
CREATE TABLE user_seller_names (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  names    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(names) <= 10),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_seller_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_seller_names FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_user_seller_names ON user_seller_names
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
