// Server Economy's prices with the game server's own sandbox settings (editor and Stockroom page): the ATM payout,
// the server store's price and the Black Market trader's payout.
// Must match atm_value in importer/pzcatalog/economy.py, which mirrors HZEconomyShared.getAtmSellRawValue:
//   value  = listed value, or for a gun-shop buyback
//            floor(shop price × GlobalPricePercent × <Category>PricePercent) × <Category>SellbackPercent × scale
//   payout = value × SellValuePercent × <SellCategory>SellValuePercent, rounded down (as the ATM shows it)
(function () {
  const PRICE = { weapons_melee: "Melee", weapons_firearms: "Firearms", ammunition: "Ammunition",
    magazines: "Magazines", weapon_attachments: "WeaponAttachments" };
  const SELLBACK = { weapons_firearms: "Firearms", ammunition: "Ammunition", magazines: "Magazines",
    weapon_attachments: "WeaponAttachments" };
  const SELL = { general: "General", junk_collectibles: "JunkCollectibles", valuables: "Valuables",
    farm_produce: "FarmProduce", herbs_medical: "HerbsMedical", hemp_products: "HempProducts",
    onelife_currency: "OneLifeCurrency", precious_metals: "PreciousMetals", lab_ingots: "LabIngots",
    weapons_firearms: "Firearms", ammunition: "AmmunitionCategory", magazines: "MagazinesCategory",
    weapon_attachments: "WeaponAttachmentsCategory" };
  // The server store's other categories (HZEconomyShared.getSandbox): category -> "<Name>PricePercent".
  const STORE = { ...PRICE, seeds: "Seeds", food_drink: "FoodDrink", animal_certificates: "AnimalCertificates",
    clothing: "Clothing", special_rewards: "SpecialRewards", tools: "Tools", building_materials: "BuildingMaterials",
    medical: "Medical", vehicle_pink_slips: "VehiclePinkSlips" };
  // The settings kept: Server Economy's percents, contraband prices and bands, family switches, the pricing preset.
  // Same as is_setting in importer/pzcatalog/economy.py and SETTING in server/market.js.
  const SETTING = /^(?:[A-Za-z]+Percent|Price[A-Za-z0-9]+|Band(?:Min|Max)[A-Za-z0-9]+|Enable[A-Za-z]+|[A-Za-z]+DemandWeight|PricingPreset|MigrateLegacyMethBand)$/;
  const isSetting = k => SETTING.test(k);
  // Used when neither the server's settings nor the mod's defaults (stored with the version) say otherwise.
  const FALLBACK = { SellValuePercent: 25, OneLifeCurrencySellValuePercent: 50 };
  const KEY = "bcedit.atmserver.v1", OLD_KEY = "bcedit.atmpct.v1";

  // The server's settings the user pasted (only the options above).
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && typeof v === "object") return clean(v);
      // The single "ATM sell %" from before was usually the mod's default (25) left as it was: carrying it over
      // would hide the marketplace's server settings, so only a value someone changed is kept.
      const old = localStorage.getItem(OLD_KEY);
      if (old !== null && old !== "25" && Number(old) >= 0 && Number(old) <= 10000) return { SellValuePercent: Number(old) };
    } catch { /* storage unavailable */ }
    return {};
  }
  function save(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(clean(settings))); } catch { /* storage unavailable */ }
  }
  function clean(v) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (isSetting(k) && typeof x === "number" && x >= 0 && x <= 1e7) out[k] = x;
    return out;
  }
  // Reads the settings from text the user pastes: the server console's sandbox dump ("... SellValuePercent 200"),
  // SandboxVars.lua ("SellValuePercent = 200,") or servertest_SandboxVars ("ServerEconomy.SellValuePercent=200").
  function parse(text) {
    const out = {};
    for (const m of String(text).matchAll(/(?:^|[\s.>{,])([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(true|false|-?[0-9]+(?:\.[0-9]+)?)\b/gm)) {
      if (isSetting(m[1])) out[m[1]] = m[2] === "true" ? 1 : m[2] === "false" ? 0 : Number(m[2]);
    }
    return clean(out);
  }

  // settings: the server's (load()); defaults: the mod's sandbox defaults stored with the version.
  function value(raw, settings, defaults, withSellPercent) {
    const pct = (opt, d = 100) => settings[opt] ?? defaults?.[opt] ?? FALLBACK[opt] ?? d;
    let v = raw[0];
    if (raw.length > 2) {
      const [, , cat, scale] = raw;
      const vend = Math.max(1, Math.floor(Math.max(1, v) * pct("GlobalPricePercent") / 100
        * (PRICE[cat] ? pct(PRICE[cat] + "PricePercent") : 100) / 100));
      v = vend * Math.max(0, SELLBACK[cat] ? pct(SELLBACK[cat] + "SellbackPercent", 10) : 10) / 100 * Math.max(0, scale);
    }
    v *= (SELL[raw[1]] ? pct(SELL[raw[1]] + "SellValuePercent") : 100) / 100;
    if (withSellPercent) v *= pct("SellValuePercent") / 100;
    return v;
  }
  // What the ATM shows for one at full condition (it rounds down).
  const payout = (raw, settings, defaults) => Math.floor(value(raw, settings, defaults, true) + 1e-9);
  const sellPercent = (settings, defaults) => settings.SellValuePercent ?? defaults?.SellValuePercent ?? FALLBACK.SellValuePercent;

  // The server store's price for one: floor(basePrice × GlobalPricePercent × <Category>PricePercent)
  // (HZEconomyShared.getVendingPrice; the mod keeps percents at 10 or more). shop: [basePrice, category].
  // The store then moves it with stock, up to MaxFluctuationPercent either way (fluctuation()).
  function storePrice(shop, settings, defaults) {
    const pct = (opt, d = 100) => Math.max(10, Math.floor(settings[opt] ?? defaults?.[opt] ?? d));
    const [base, cat] = shop;
    return Math.max(1, Math.floor(Math.max(1, base) * pct("GlobalPricePercent") / 100 * (STORE[cat] ? pct(STORE[cat] + "PricePercent") : 100) / 100));
  }
  const fluctuation = (settings, defaults) => settings.MaxFluctuationPercent ?? defaults?.MaxFluctuationPercent ?? 0;

  // The Black Market trader's payout for one full item of a Narcotics & Crime product, as an estimate: the mod's
  // Java code works it out from a reference price (the middle of the item's band, or its custom price), the payout
  // percents and, at DMZ sites, the DMZ percent. bm: [family, priceKey, bandId]. null when the trader won't buy it.
  function blackMarket(bm, settings, defaults) {
    const get = (opt, d) => settings[opt] ?? defaults?.[opt] ?? d;
    const [family, priceKey, id] = bm;
    if (!get("EnableBlackMarket", 1) || !get("EnableBlackMarketSales", 1) || !get("Enable" + family, 1)
      || get(family + "DemandWeight", 1) <= 0) return null;
    let ref;
    if (get("PricingPreset", 1) === 1) {
      let lo = get("BandMin" + id, null), hi = get("BandMax" + id, null);
      if (lo == null || hi == null) return null;
      // The mod moves the old meth default (350-650) to 200-350 unless MigrateLegacyMethBand is off.
      if (id === "CrystalMeth" && lo === 350 && hi === 650 && get("MigrateLegacyMethBand", 1)) { lo = 200; hi = 350; }
      ref = Math.floor((lo + hi) / 2);
    } else ref = get(priceKey, 0);
    const each = Math.floor(ref * get("PayoutPercent", 100) * get(family + "PayoutPercent", 100) / 10000);
    if (each <= 0) return null;
    const dmzPct = family === "Meth" ? get("MethDMZPayoutPercent", 200) : get("DMZPayoutPercent", 250);
    return { each, dmz: Math.floor(each * dmzPct / 100), dmzPct, banded: get("PricingPreset", 1) === 1 };
  }

  window.ATMCalc = { isSetting, load, save, parse, value, payout, sellPercent, storePrice, fluctuation, blackMarket };
})();
