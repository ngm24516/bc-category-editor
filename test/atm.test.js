// web/atm.js: the ATM payout with the server's sandbox settings. Same cases as importer/tests (atm_value).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL("../web/atm.js", import.meta.url), "utf8"), ctx);
const { parse, payout, value, sellPercent, storePrice, blackMarket } = ctx.window.ATMCalc;

// OneLife's server, as its console log prints the sandbox settings.
const LOG = `LOG  : General      f:0 st:0> FirearmsPricePercent 125
LOG  : General      f:0 st:0> AmmunitionPricePercent 225
LOG  : General      f:0 st:0> SellValuePercent 200
LOG  : General      f:0 st:0> PreciousMetalsSellValuePercent 35
LOG  : General      f:0 st:0> FirearmsSellbackPercent 2
LOG  : General      f:0 st:0> AmmunitionSellbackPercent 1
LOG  : General      f:0 st:0> MaxStock 22`;

test("reads the server's ATM settings from a console log, SandboxVars.lua or servertest_SandboxVars", () => {
  const s = parse(LOG);
  assert.deepEqual({ ...s }, { FirearmsPricePercent: 125, AmmunitionPricePercent: 225, SellValuePercent: 200,
    PreciousMetalsSellValuePercent: 35, FirearmsSellbackPercent: 2, AmmunitionSellbackPercent: 1 }, "only ATM settings");
  assert.deepEqual({ ...parse("ServerEconomy = {\n    SellValuePercent = 200,\n    HubX = 3,\n}") }, { SellValuePercent: 200 });
  assert.deepEqual({ ...parse("ServerEconomy.SellValuePercent=150") }, { SellValuePercent: 150 });
  assert.deepEqual({ ...parse("nothing here") }, {});
});

test("pays like the mod: a silver bar sells for 115 on OneLife", () => {
  const s = parse(LOG), def = { SellValuePercent: 25, OneLifeCurrencySellValuePercent: 50 };
  assert.equal(payout([165, "precious_metals"], s, def), 115);
  assert.equal(payout([3000, "weapons_firearms", "weapons_firearms", 1], s, def), 150, "floor(3000 × 125%) × 2% × 200%");
  assert.equal(payout([200, "ammunition", "ammunition", 1], s, def), 9, "floor(200 × 225%) × 1% × 200%");
  assert.equal(payout([40, "onelife_currency"], s, def), 40, "the mod's default category percent still applies");
  assert.equal(payout([165, "precious_metals"], {}, def), 41, "the mod's defaults: 165 × 25%, rounded down");
  assert.equal(value([3000, "weapons_firearms", "weapons_firearms", 1], {}, def), 300, "before the sell %: 10% buyback");
  assert.equal(payout([300, ""], { SellValuePercent: 50 }, {}), 150, "a value from before format 4: only the sell %");
  assert.equal(sellPercent({}, {}), 25);
});

test("reads contraband settings too: bands, prices, family switches (true/false as 1/0)", () => {
  const s = parse(`LOG  : General      f:0 st:0> EnableMeth true
LOG  : General      f:0 st:0> MigrateLegacyMethBand false
LOG  : General      f:0 st:0> BandMinCrystalMeth 350
LOG  : General      f:0 st:0> PriceMeth 300
LOG  : General      f:0 st:0> HubX 10615`);
  assert.deepEqual({ ...s }, { EnableMeth: 1, MigrateLegacyMethBand: 0, BandMinCrystalMeth: 350, PriceMeth: 300 });
});

test("the server store's price: base × GlobalPricePercent × category percent, rounded down", () => {
  const s = parse(LOG);
  assert.equal(storePrice([3000, "weapons_firearms"], s, {}), 3750, "FirearmsPricePercent 125");
  assert.equal(storePrice([10, "food_drink"], { FoodDrinkPricePercent: 250 }, {}), 25);
  assert.equal(storePrice([10, "something_new"], {}, {}), 10, "unknown category: 100%");
  assert.equal(storePrice([100, "tools"], { GlobalPricePercent: 1 }, {}), 10, "the mod keeps percents at 10 or more");
});

test("the Black Market's estimate: middle of the band × payout percents, more at DMZ sites", () => {
  const def = { BandMinCrystalMeth: 350, BandMaxCrystalMeth: 650, BandMinLSD: 160, BandMaxLSD: 350, PriceLSD: 100 };
  assert.deepEqual({ ...blackMarket(["Meth", "PriceMeth", "CrystalMeth"], {}, def) }, { each: 275, dmz: 550, dmzPct: 200, banded: true },
    "the old meth band moves to 200-350; meth DMZ 200%");
  assert.equal(blackMarket(["Meth", "PriceMeth", "CrystalMeth"], { MigrateLegacyMethBand: 0 }, def).each, 500);
  assert.deepEqual({ ...blackMarket(["Psychedelics", "PriceLSD", "LSD"], { DMZPayoutPercent: 200, PayoutPercent: 150 }, def) },
    { each: 382, dmz: 764, dmzPct: 200, banded: true }, "floor(255 × 150%)");
  assert.equal(blackMarket(["Psychedelics", "PriceLSD", "LSD"], { PricingPreset: 2 }, def).each, 100, "custom preset: its price");
  assert.equal(blackMarket(["Psychedelics", "PriceLSD", "LSD"], { EnablePsychedelics: 0 }, def), null, "family switched off");
  assert.equal(blackMarket(["Psychedelics", "PriceLSD", "LSD"], { EnableBlackMarketSales: 0 }, def), null);
});
