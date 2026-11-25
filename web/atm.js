// Server Economy's ATM payout with the server's own sandbox settings (editor and Stockroom page).
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
  const OPTIONS = ["SellValuePercent", "GlobalPricePercent", ...Object.values(PRICE).map(n => n + "PricePercent"),
    ...Object.values(SELLBACK).map(n => n + "SellbackPercent"), ...Object.values(SELL).map(n => n + "SellValuePercent")];
  // Used when neither the server's settings nor the mod's defaults (stored with the version) say otherwise.
  const FALLBACK = { SellValuePercent: 25, OneLifeCurrencySellValuePercent: 50 };
  const KEY = "bcedit.atmserver.v1", OLD_KEY = "bcedit.atmpct.v1";

  // The server's settings the user pasted (only the options above).
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && typeof v === "object") return clean(v);
      const old = localStorage.getItem(OLD_KEY);   // the single "ATM sell %" from before
      if (old !== null && Number(old) >= 0 && Number(old) <= 10000) return { SellValuePercent: Number(old) };
    } catch { /* storage unavailable */ }
    return {};
  }
  function save(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(clean(settings))); } catch { /* storage unavailable */ }
  }
  function clean(v) {
    const out = {};
    for (const k of OPTIONS) if (typeof v[k] === "number" && v[k] >= 0 && v[k] <= 100000) out[k] = v[k];
    return out;
  }
  // Reads the settings from text the user pastes: the server console's sandbox dump ("... SellValuePercent 200"),
  // SandboxVars.lua ("SellValuePercent = 200,") or servertest_SandboxVars ("ServerEconomy.SellValuePercent=200").
  function parse(text) {
    const out = {};
    for (const m of String(text).matchAll(/(?:^|[\s.>{,])([A-Za-z]+)\s*(?:=\s*|\s+)(-?[0-9]+(?:\.[0-9]+)?)\b/gm)) {
      if (OPTIONS.includes(m[1])) out[m[1]] = Number(m[2]);
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

  window.ATMCalc = { OPTIONS, load, save, parse, value, payout, sellPercent };
})();
