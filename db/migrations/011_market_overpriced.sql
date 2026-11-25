-- Overpriced listings are left out of a marketplace's prices (kept in the history; applied when prices are read):
--   ignore_at       a listing at or above this price is a "not for sale" placeholder (NULL = no limit)
--   outlier_factor  a listing above this many times its item's median price is ignored, when the item has at least
--                   3 listings and the price is at least 100 (NULL or 0 = off)
ALTER TABLE marketplaces ADD COLUMN ignore_at      numeric(14, 2) DEFAULT 99999 CHECK (ignore_at IS NULL OR ignore_at > 0);
ALTER TABLE marketplaces ADD COLUMN outlier_factor numeric(8, 2)  DEFAULT 10    CHECK (outlier_factor IS NULL OR outlier_factor >= 0);
