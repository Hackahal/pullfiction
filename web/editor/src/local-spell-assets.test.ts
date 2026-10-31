import test from "node:test";
import assert from "node:assert/strict";
import { localSpellReplay } from "./local-spell-assets";
import { normalizeReplay, enrichCombat } from "./domain";
import type { Aura, RawReplay } from "./types";

const source = (): RawReplay =>
  ({
    report: { code: "fixture", title: "Local data" },
    fight: {
      id: 1,
      name: "Lucifron",
      startTime: 0,
      endTime: 10000,
      gameZone: { id: 409, name: "Molten Core" },
    },
    actors: [{ id: 1, name: "Mage", type: "Player", subType: "Mage" }],
    abilities: [
      { gameID: 116, name: "Recorded Frostbolt", icon: "question.jpg" },
    ],
    events: [
      {
        timestamp: 0,
        type: "combatantinfo",
        sourceID: 1,
        auras: [{ ability: 1459 }],
      },
      {
        timestamp: 0,
        type: "applybuff",
        sourceID: 1,
        targetID: 1,
        abilityGameID: 1459,
      },
      { timestamp: 1000, type: "begincast", sourceID: 1, abilityGameID: 116 },
      { timestamp: 2500, type: "cast", sourceID: 1, abilityGameID: 116 },
    ],
  }) as unknown as RawReplay;
const catalog = {
  116: { name: "Frostbolt", iconFile: 100, castMs: 1500 },
  1459: { name: "Arcane Intellect", iconFile: 200 },
};

test("Local spell assets preserve the raw log and resolve observed cast and initial aura icons by ID", () => {
  const raw = source(),
    before = JSON.stringify(raw);
  const prepared = localSpellReplay(raw, catalog);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(prepared.events, raw.events);
  assert.deepEqual(prepared.abilities, [
    { gameID: 116, name: "Recorded Frostbolt", icon: "pf_100.blp" },
    { gameID: 1459, name: "Arcane Intellect", icon: "pf_200.blp" },
  ]);
  const replay = enrichCombat(normalizeReplay(prepared, {}), {}, catalog);
  const mage = replay.actors.find((a) => a.type === "Player")!;
  assert.equal(mage.casts[0].icon, "pf_100.blp");
  const aura = mage.auras
    .map(([, value]) => value)
    .find((value): value is Aura => "spell" in value && value.spell === 1459);
  assert.equal(aura?.icon, "pf_200.blp");
});

test("Missing or invalid local icon IDs retain recorded icons and never invent file references", () => {
  const raw = source();
  for (const iconFile of [0, -1, 2 ** 32, "100", NaN]) {
    const result = localSpellReplay(raw, { 116: { iconFile } });
    assert.equal(result.abilities?.[0].icon, "question.jpg");
    assert.equal(result.abilities?.length, 1);
  }
});
