-- The marketplace's current lowest price per item and who sells at it: listings seen in the last full read.
ALTER TABLE market_listings ADD COLUMN owner_name text;          -- the listing's "owner_display_name"
ALTER TABLE marketplaces    ADD COLUMN last_crawl_at timestamptz; -- when the last full read was saved (= its rows' last_seen)
CREATE INDEX market_listings_current ON market_listings (marketplace_id, last_seen);
