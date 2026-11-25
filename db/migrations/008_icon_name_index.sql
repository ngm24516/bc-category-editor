-- Finding an item's icon by icon name (items whose script reuses another item's icon), for the catalog lookup
-- the Stockroom page uses.
CREATE INDEX catalog_items_icon_name ON catalog_items (icon_name) WHERE icon_tile >= 0;
