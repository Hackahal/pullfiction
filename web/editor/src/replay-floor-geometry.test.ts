import test from "node:test";
import assert from "node:assert/strict";
import { ReplayFloorGeometry } from "./replay-floor-geometry";
const floor = (z: number, interior = false, offset = 0) => ({
  area: interior ? "room" : "terrain",
  interior,
  vertices: [
    [offset, 0, z],
    [offset + 64, 0, z],
    [offset, 64, z],
  ] as [number, number, number][],
  indices: [0, 1, 2],
});
test("cold indoor seeks choose the client's room floor rather than terrain near the entrance height", () => {
  const geometry = new ReplayFloorGeometry([
    floor(104.41),
    floor(185.72, true),
  ]);
  assert.equal(geometry.height(10, 10, 125, true), 185.72);
  assert.equal(geometry.height(10, 10, 104, false), 104.41);
  assert.equal(geometry.height(10, 10, 186, false), 185.72);
});
test("teleport destinations and outdoor locations resolve independently of previously loaded rooms", () => {
  const geometry = new ReplayFloorGeometry([floor(74), floor(186, true, 1000)]);
  for (const x of [1010, 10, 1010])
    assert.equal(geometry.height(x, 10, 125, true), x > 1000 ? 186 : 74);
  assert.equal(geometry.height(-1000, 10, 125, true), undefined);
});
test("open cloisters and ship decks use their placed WMO floor even when authored exterior", () => {
  const cloister = { ...floor(185.72), area: "61687674:13" };
  const geometry = new ReplayFloorGeometry([floor(104.41), cloister]);
  assert.equal(geometry.height(10, 10, 125, true), 185.72);
});
test("stacked floor seeds remain authoritative; ceilings and invalid inputs cannot become walkable floors", () => {
  const ceiling = { ...floor(190, true), indices: [2, 1, 0] };
  const geometry = new ReplayFloorGeometry([
    floor(173, true),
    floor(186, true),
    ceiling,
  ]);
  assert.equal(geometry.height(10, 10, 186, false), 186);
  assert.equal(geometry.height(10, 10, 173, false), 173);
  assert.equal(geometry.height(NaN, 10, 186, true), undefined);
});

test("unseeded interior stages cast down from the client room level instead of entrance altitude", () => {
  const geometry = new ReplayFloorGeometry(
    [floor(10, true), floor(30, true), floor(60, true), floor(0)],
    [{ id: "room", name: "interior", height: 45 }],
  );
  for (const x of [10, 20, 10])
    assert.equal(geometry.height(x, 10, 12, true), 30);
  // Explicit lower-storey observations/seeds must still win, including zero.
  assert.equal(geometry.height(10, 10, 10, false), 10);
  assert.equal(geometry.height(10, 10, 0, false), 0);
});
test("room metadata is optional and invalid or unrelated levels cannot affect a floor", () => {
  for (const areas of [
    [],
    [{ id: "room", name: "bad", height: NaN }],
    [{ id: "other", name: "other", height: 45 }],
  ]) {
    const geometry = new ReplayFloorGeometry(
      [floor(10, true), floor(30, true)],
      areas,
    );
    assert.equal(geometry.height(10, 10, 12, true), 10);
  }
});

test("approximate room pins use a nearby walkable edge only outside exact structure and within tolerance", () => {
  const geometry = new ReplayFloorGeometry(
    [
      floor(330),
      floor(173, true, 10),
      floor(185, true, 10),
      floor(200, true, 10),
    ],
    [{ id: "room", name: "chapel", height: 186 }],
  );
  assert.equal(geometry.height(9, 1, 125, true), 330);
  assert.equal(geometry.nearbyStructureHeight(9, 1, 125, 3), 185);
  assert.equal(geometry.nearbyStructureHeight(6, 1, 125, 3), undefined);
  assert.equal(geometry.nearbyStructureHeight(11, 1, 125, 3), undefined);
  assert.equal(geometry.height(11, 1, 125, true), 185);
  assert.equal(geometry.nearbyStructureHeight(NaN, 1, 125, 3), undefined);
  assert.equal(geometry.nearbyStructureHeight(9, 1, 125, 0), undefined);
  assert.equal(
    new ReplayFloorGeometry([floor(330)]).nearbyStructureHeight(9, 1, 125, 3),
    undefined,
  );
});
