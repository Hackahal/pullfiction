import test from "node:test";
import assert from "node:assert/strict";
import { gearRunes } from "./rune-model";
import type { Gear, Replay } from "./types";
const gear = (
  slot: number,
  enchant = 6875,
  name: string | undefined = "Water Shield",
): Gear => ({
  id: 233608,
  slot,
  temporaryEnchant: enchant,
  temporaryEnchantName: name,
});
const replay = (artifact: any[] = [], abilities: any[] = []) =>
  ({
    raw: {
      playerDetails: {
        data: {
          playerDetails: { dps: [{ id: 1, combatantInfo: { artifact } }] },
        },
      },
    },
    abilities: new Map(abilities),
  }) as unknown as Replay;
test("SoD engravings include shoulders and rings but exclude weapon oils and weapon buffs", () => {
  const result = gearRunes(
    [
      gear(0),
      gear(2),
      gear(9),
      gear(10),
      gear(11),
      gear(15, 2629, "Brilliant Mana Oil"),
      gear(16, 7141, "Wild Strikes"),
    ],
    "sod",
    1,
    null,
  );
  assert.deepEqual(
    result.map((r) => r.slot),
    [0, 2, 9, 10, 11],
  );
  assert.deepEqual(gearRunes([gear(9)], "vanilla", 1, null), []);
});
test("Rune spell references come from this player's logged metadata, not the enchant number", () => {
  const r = replay(
    [
      {
        guid: 408510,
        name: "Water Shield",
        abilityIcon: "spell_shaman_watershield",
      },
    ],
    [[99, { name: "Water Shield", icon: "other" }]],
  );
  assert.deepEqual(gearRunes([gear(9)], "sod", 1, r), [
    {
      slot: 9,
      enchant: 6875,
      name: "Water Shield",
      spellId: 408510,
      icon: "spell_shaman_watershield",
    },
  ]);
});
test("unambiguous report ability resolves a rune without guessing from casts", () => {
  const r = replay(
    [],
    [[425858, { name: "Ancestral Awakening", icon: "awakening" }]],
  );
  assert.equal(
    gearRunes([gear(7, 7048, "Ancestral Awakening")], "sod", 1, r)[0].spellId,
    425858,
  );
});
test("ambiguous spell names retain the rune and shared icon without a false spell link", () => {
  const r = replay(
    [],
    [
      [1, { name: "Water Shield", icon: "water" }],
      [2, { name: "Water Shield", icon: "water" }],
    ],
  );
  const rune = gearRunes([gear(9)], "sod", 1, r)[0];
  assert.equal(rune.spellId, undefined);
  assert.equal(rune.icon, "water");
});
test("missing names and invalid enchantments remain honest", () => {
  const r = gearRunes(
    [gear(4, 6878, undefined), gear(9, 0), gear(8, -1), gear(7, 1.5)],
    "sod",
    1,
    null,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].spellId, undefined);
  // Force genuinely absent enrichment rather than a default function argument.
  assert.equal(
    gearRunes([{ id: 1, slot: 4, temporaryEnchant: 6878 }], "sod", 1, null)[0]
      .name,
    "Rune 6878",
  );
});
