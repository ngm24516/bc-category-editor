// Stockroom inventories: signed-in only, each user sees and changes only their own characters (RLS).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { startHarness } from "./helpers.js";

let h, pool, api, login;
before(async () => { h = await startHarness(); ({ pool, api, login } = h); });
after(() => h.stop());

const character = (over = {}) => ({
  identity: "onelifepz.com:16261|world1|Nate", label: "Nate on onelifepz.com", sequence: 42,
  houses: [{ name: "Riverside", containers: 12 }], items: { "Base.Axe": 2, "Base.Nails": 150 }, ...over,
});

describe("stockroom", () => {
  let alice, bob;
  beforeEach(async () => { await h.resetDb(); alice = await login("code-alice"); bob = await login("code-bob"); });

  test("signed out can't read or write", async () => {
    assert.equal((await api(null, "GET", "/api/stockroom")).status, 401);
    assert.equal((await api(null, "PUT", "/api/stockroom", { characters: [character()] })).status, 401);
  });

  test("starts empty; an import is kept; importing the same character again replaces it", async () => {
    assert.deepEqual(await (await api(alice, "GET", "/api/stockroom")).json(), { characters: [] });
    const r = await api(alice, "PUT", "/api/stockroom", { characters: [character()] });
    assert.equal(r.status, 200);
    await api(alice, "PUT", "/api/stockroom", { characters: [character({ sequence: 43, items: { "Base.Axe": 3 } })] });
    const { characters } = await (await api(alice, "GET", "/api/stockroom")).json();
    assert.equal(characters.length, 1);
    assert.deepEqual([characters[0].sequence, characters[0].items, characters[0].houses], [43, { "Base.Axe": 3 }, [{ name: "Riverside", containers: 12 }]]);
  });

  test("another user can't see, replace or delete it", async () => {
    const { characters: [mine] } = await (await api(alice, "PUT", "/api/stockroom", { characters: [character()] })).json();
    assert.deepEqual((await (await api(bob, "GET", "/api/stockroom")).json()).characters, []);
    assert.equal((await api(bob, "DELETE", `/api/stockroom/${mine.id}`)).status, 404);
    // Bob importing the same identity makes his own copy; Alice's is untouched.
    await api(bob, "PUT", "/api/stockroom", { characters: [character({ items: { "Base.Plank": 1 } })] });
    assert.deepEqual((await (await api(alice, "GET", "/api/stockroom")).json()).characters[0].items, { "Base.Axe": 2, "Base.Nails": 150 });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM stockroom_characters");
    assert.equal(rows[0].n, 0, "without app.user_id set, row-level security shows nothing");
    assert.equal((await api(alice, "DELETE", `/api/stockroom/${mine.id}`)).status, 204);
    assert.deepEqual((await (await api(alice, "GET", "/api/stockroom")).json()).characters, []);
  });

  test("bad input is refused with a message", async () => {
    for (const bad of [
      { characters: [] }, { characters: "x" },
      { characters: [character({ identity: "" })] },
      { characters: [character({ items: { "not an item": 1 } })] },
      { characters: [character({ items: { "Base.Axe": 0 } })] },
      { characters: [character({ items: { "Base.Axe": 1.5 } })] },
      { characters: [character({ items: [] })] },
    ]) {
      const r = await api(alice, "PUT", "/api/stockroom", bad);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
      assert.ok((await r.json()).message);
    }
    assert.equal((await api(alice, "DELETE", "/api/stockroom/nope")).status, 404);
  });

  test("the /stockroom page is served", async () => {
    const r = await api(null, "GET", "/stockroom");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<h1>Stockroom<\/h1>/);
  });

  test("at most 20 characters per user", async () => {
    const many = Array.from({ length: 21 }, (_, i) => character({ identity: `s|w|c${i}`, label: `c${i}` }));
    assert.equal((await api(alice, "PUT", "/api/stockroom", { characters: many })).status, 400);
    assert.equal((await api(alice, "PUT", "/api/stockroom", { characters: many.slice(0, 20) })).status, 200);
    assert.equal((await api(alice, "PUT", "/api/stockroom", { characters: [character({ identity: "s|w|new" })] })).status, 400);
  });
});
