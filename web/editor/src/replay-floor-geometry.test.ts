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
