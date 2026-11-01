import test from "node:test";
import assert from "node:assert/strict";
import { characterClass, factionName } from "./identity-model";
test("identity normalization uses explicit WCL identity and leaves unknown values unset", () => {
  assert.equal(characterClass(8), "Mage");
  assert.equal(characterClass("Warrior"), "Warrior");
  assert.equal(characterClass(11), "Druid");
  assert.equal(characterClass("Unknown"), null);
  assert.equal(characterClass(99), null);
  assert.equal(factionName({ id: 1, name: "Horde" }), "Horde");
  assert.equal(factionName(0), "Alliance");
  assert.equal(factionName(1), "Horde");
  assert.equal(factionName({ id: 0 }), null);
  assert.equal(factionName(2), null);
});
