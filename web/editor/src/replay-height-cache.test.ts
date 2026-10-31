import test from "node:test";
import assert from "node:assert/strict";
import { ReplayHeightCache } from "./replay-height-cache";
import { ReplayFloorGeometry } from "./replay-floor-geometry";

test("last height caches exact inputs and undefined without sharing actor identities", () => {
  const cache = new ReplayHeightCache(),
    actor = {},
    other = {};
  let calls = 0;
  const geometry = {
    height(x: number) {
      calls++;
      return x === 1 ? undefined : x;
    },
  };
  for (const x of [1, 1, 2, 2]) cache.height(actor, geometry, x, 4, 8, false);
  assert.equal(calls, 2);
  assert.equal(cache.height(actor, geometry, 2, 4, 8, false), 2);
  cache.height(other, geometry, 2, 4, 8, false);
  assert.equal(calls, 3);
  assert.equal(cache.height(actor, geometry, 1, 4, 8, false), undefined);
  assert.equal(
    calls,
    4,
    "returning to an earlier input recomputes the last query",
  );
});

test("geometry, coordinates, floor seed and interior preference all invalidate", () => {
  const cache = new ReplayHeightCache(),
    actor = {};
  let calls = 0;
  const height = (x: number, y: number, z: number, inside: boolean) => {
    calls++;
    return x + y + z + Number(inside);
  };
  const a = { height },
    b = { height };
  const inputs = [
    [a, 0, 1, 2, false],
    [a, -0, 1, 2, false],
    [a, 0, 1, 2, false],
    [a, Number.MIN_VALUE, 1, 2, false],
    [a, Number.MIN_VALUE, 1 + Number.EPSILON, 2, false],
    [a, Number.MIN_VALUE, 1 + Number.EPSILON, 3, false],
    [a, Number.MIN_VALUE, 1 + Number.EPSILON, 3, true],
    [b, Number.MIN_VALUE, 1 + Number.EPSILON, 3, true],
    [b, NaN, 1, 3, true],
  ] as const;
  for (const [geometry, x, y, hint, interior] of inputs) {
    const before = calls;
    const value = cache.height(actor, geometry, x, y, hint, interior);
    assert.equal(calls, before + 1);
    assert.ok(
      Object.is(cache.height(actor, geometry, x, y, hint, interior), value),
    );
    assert.equal(calls, before + 1);
  }
});

test("actual indexed floor results survive holds, reverse seeks, teleports and seeds", () => {
  const cache = new ReplayHeightCache(),
    actor = {};
  const geometry = new ReplayFloorGeometry(
    [74, 173, 186].map((z, i) => ({
      area: i ? "room" : "terrain",
      interior: i > 0,
      vertices: [
        [0, 0, z],
        [2000, 0, z],
        [0, 2000, z],
      ],
      indices: [0, 1, 2],
    })),
  );
  const points = [
    [10, 10, 74, false],
    [10, 10, 74, false],
    [1000, 10, 186, true],
    [1000, 10, 173, false],
    [2100, 10, 74, true],
    [2100, 10, 74, true],
    [NaN, 10, 186, false],
  ] as const;
  for (const [x, y, hint, interior] of [...points, ...[...points].reverse()])
    assert.ok(
      Object.is(
        cache.height(actor, geometry, x, y, hint, interior),
        geometry.height(x, y, hint, interior),
      ),
    );
});
