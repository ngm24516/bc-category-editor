-- The game server's Server Economy sandbox settings, kept with its marketplace (one marketplace = one server).
-- An admin pastes them once; everyone who picks that marketplace gets its ATM, store and Black Market prices.
-- { "SellValuePercent": 200, "PreciousMetalsSellValuePercent": 35, ... } (numbers; true/false as 1/0)
ALTER TABLE marketplaces ADD COLUMN economy_settings jsonb;
