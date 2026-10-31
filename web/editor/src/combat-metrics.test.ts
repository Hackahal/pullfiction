import test from "node:test";
import assert from "node:assert/strict";
import {
  perSecond,
  formatRate,
  matchesCombatSide,
  defaultCombatSide,
} from "./combat-metrics";
test("Rates use exact positive seconds and never invent a zero-duration denominator", () => {
  assert.equal(perSecond(100, 0.25), 400);
  assert.equal(perSecond(100, 0), null);
  assert.equal(perSecond(100, -1), null);
  assert.equal(perSecond(100, NaN), null);
  assert.equal(perSecond(0, 0.25), 0);
  assert.equal(formatRate(perSecond(100, 0)), "—");
});
test("Enemy damage excludes raid members, owned pets and unknown affiliation", () => {
  const players = new Set([1]);
  assert.equal(matchesCombatSide({ id: 1 }, players, "enemies"), false);
  assert.equal(
    matchesCombatSide({ id: 3, owner: 1 }, players, "enemies"),
    false,
  );
  assert.equal(matchesCombatSide({ id: 10 }, players, "enemies"), true);
  assert.equal(matchesCombatSide(undefined, players, "enemies"), false);
  assert.equal(matchesCombatSide(undefined, players, "all"), true);
  assert.equal(defaultCombatSide("damage"), "enemies");
  assert.equal(defaultCombatSide("heal"), "all");
  assert.equal(defaultCombatSide("taken"), "all");
});
