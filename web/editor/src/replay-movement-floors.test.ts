import test from "node:test";
import assert from "node:assert/strict";
import {
  movementFloorCandidates,
  MovementFloorCache,
} from "./replay-movement-floors";

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
test("floor precision differences cannot consume both alternative slots with one storey", () => {
  const noisy = {
    heightCandidates: (x: number) =>
      x === 0 ? [293.00001, 304, 317] : [297.99999, 317],
  };
  assert.deepEqual(
    movementFloorCandidates(noisy, from, to, 293, 298, true, true),
    [
      { from: 304, to: 298 },
      { from: 317, to: 317 },
    ],
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

test("one exact movement query per actor reuses immutable candidates", () => {
  let calls = 0;
  const source = {
    heightCandidates: (x: number) => {
      calls++;
      return geometry.heightCandidates(x);
    },
  };
  const cache = new MovementFloorCache(),
    actor = {};
  const first = cache.candidates(actor, source, from, to, 293, 298, true, true);
  assert.deepEqual(
    first,
    movementFloorCandidates(geometry, from, to, 293, 298, true, true),
  );
  assert.equal(calls, 2);
  for (let i = 0; i < 60; i++)
    assert.equal(
      cache.candidates(actor, source, [...from], [...to], 293, 298, true, true),
      first,
    );
  assert.equal(calls, 2);
  assert.ok(Object.isFrozen(first));
  assert.ok(first.every(Object.isFrozen));
  cache.candidates({}, source, from, to, 293, 298, true, true);
  assert.equal(calls, 4);
});

test("movement candidates invalidate every exact input and replaced geometry", () => {
  const cache = new MovementFloorCache(),
    actor = {};
  const query = (
    g: typeof geometry,
    a: number[],
    b: number[],
    ah: number,
    bh: number,
    ai: boolean,
    bi: boolean,
  ) => cache.candidates(actor, g, a, b, ah, bh, ai, bi);
  const cases: [
    typeof geometry,
    number[],
    number[],
    number,
    number,
    boolean,
    boolean,
  ][] = [
    [geometry, [...from], [...to], 293, 298, true, true],
    [geometry, [0.01, 0], [...to], 293, 298, true, true],
    [geometry, [0.01, 0.01], [...to], 293, 298, true, true],
    [geometry, [0.01, 0.01], [8.01, 0], 293, 298, true, true],
    [geometry, [0.01, 0.01], [8.01, 0.01], 293, 298, true, true],
    [geometry, [0.01, 0.01], [8.01, 0.01], 294, 298, true, true],
    [geometry, [0.01, 0.01], [8.01, 0.01], 294, 299, true, true],
    [geometry, [0.01, 0.01], [8.01, 0.01], 294, 299, false, true],
    [geometry, [0.01, 0.01], [8.01, 0.01], 294, 299, false, false],
    [
      { heightCandidates: () => [299, 310] },
      [0.01, 0.01],
      [8.01, 0.01],
      294,
      299,
      true,
      true,
    ],
  ];
  let previous: readonly unknown[] | undefined;
  for (const args of cases) {
    const result = query(...args);
    assert.notEqual(result, previous);
    assert.deepEqual(result, movementFloorCandidates(...args));
    previous = result;
  }
  const a = [...from],
    b = [...to];
  const before = query(geometry, a, b, 293, 298, true, true);
  a[0] = 1;
  const after = query(geometry, a, b, 293, 298, true, true);
  assert.notEqual(after, before);
  assert.deepEqual(
    after,
    movementFloorCandidates(geometry, a, b, 293, 298, true, true),
  );
});
