-- In-game marketplaces (shared, added by admins) and the price history the market job collects from them.
-- Each account chooses one marketplace whose prices the editor shows (user_marketplaces, RLS).

CREATE TABLE marketplaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- The listings endpoint as the admin entered it; the job sets page and pageSize itself.
  api_url           text NOT NULL UNIQUE CHECK (api_url LIKE 'https://%' OR api_url LIKE 'http://%'),
  enabled           boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Filled in by the market job.
  last_checked_at   timestamptz,
  last_snapshot_at  timestamptz,   -- the marketplace's own "snapshot_updated_at" for the last crawl that finished
  last_listings     integer,
  last_error        text
);

-- One row per listing and price: a listing that stays up for weeks counts once, and a repriced listing
-- counts once per price. Prices are per item.
CREATE TABLE market_listings (
  marketplace_id  uuid NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  listing_id      text NOT NULL CHECK (length(listing_id) <= 200),
  price           numeric(14, 2) NOT NULL CHECK (price >= 0),
  full_type       text NOT NULL CHECK (length(full_type) <= 200),
  quantity        integer,
  shop_name       text,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace_id, listing_id, price)
);
CREATE INDEX market_listings_item ON market_listings (marketplace_id, full_type);

-- The marketplace an account shows prices from (at most one).
CREATE TABLE user_marketplaces (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  marketplace_id  uuid NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  chosen_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_marketplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_marketplaces FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_user_marketplaces ON user_marketplaces
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

ALTER TABLE importer_runs DROP CONSTRAINT importer_runs_kind_check;
ALTER TABLE importer_runs ADD CONSTRAINT importer_runs_kind_check CHECK (kind IN ('import', 'check-updates', 'market'));
