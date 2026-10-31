import test from "node:test";
import assert from "node:assert/strict";
import { movementFloorCandidates } from "./replay-movement-floors";

const from = [0, 0],
  to = [8, 0];
const geometry = {
  heightCandidates: (x: number) =>
    x === 0 ? [126, 293, 304, 317, 327] : [132, 298, 317],
};
test("short inferred segments offer bounded continuous floor pairs instead of unrelated underfloors", () => {
  assert.deepEqual(
    movementFloorCandidates(geometry, from, to, 293, 298, true, true),
    [
      { from: 304, to: 298 },
      { from: 317, to: 317 },
    ],
  );
  assert.deepEqual(
    movementFloorCandidates(geometry, from, to, 317, 298, true, true)[0],
    { from: 317, to: 317 },
  );
});
test("fixed and observed endpoint heights cannot be replaced", () => {
  assert.deepEqual(
    movementFloorCandidates(geometry, from, to, 293, 298, false, false),
    [],
  );
  assert.ok(
    movementFloorCandidates(geometry, from, to, 293, 298, false, true).every(
      (pair) => pair.from === 293,
    ),
  );
  assert.ok(
    movementFloorCandidates(geometry, from, to, 293, 298, true, false).every(
      (pair) => pair.to === 298,
    ),
  );
});
test("long spans and invalid inputs do not create additional floor hypotheses", () => {
  assert.deepEqual(
    movementFloorCandidates(geometry, from, [41, 0], 293, 298, true, true),
    [],
  );
  assert.deepEqual(
    movementFloorCandidates(geometry, [NaN, 0], to, 293, 298, true, true),
    [],
  );
});
test("candidate order depends on endpoint inputs and remains unchanged by unrelated queries", () => {
  const first = movementFloorCandidates(
    geometry,
    from,
    to,
    293,
    298,
    true,
    true,
  );
  movementFloorCandidates(geometry, from, to, 317, 317, true, true);
  assert.deepEqual(
    movementFloorCandidates(geometry, from, to, 293, 298, true, true),
    first,
  );
});
