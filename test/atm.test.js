// web/atm.js: the ATM payout with the server's sandbox settings. Same cases as importer/tests (atm_value).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL("../web/atm.js", import.meta.url), "utf8"), ctx);
const { parse, payout, value, sellPercent } = ctx.window.ATMCalc;

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
