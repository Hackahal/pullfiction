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

test("validated floor anchors select stages independently of entrance or room-average altitude", () => {
  const geometry = new ReplayFloorGeometry(
    [floor(10, true), floor(30, true), floor(60, true), floor(0)],
    [{ id: "room", name: "interior", height: 5 }],
    [{ entry: 1, point: [1, 1, 30] }],
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
  assert.equal(geometry.referenceFloors.height(11, 1, 125, true), 185);
  assert.equal(geometry.nearbyStructureHeight(NaN, 1, 125, 3), undefined);
  assert.equal(geometry.nearbyStructureHeight(9, 1, 125, 0), undefined);
  assert.equal(
    new ReplayFloorGeometry([floor(330)]).nearbyStructureHeight(9, 1, 125, 3),
    undefined,
  );
});

test("surface calibration follows a ramp without switching to overlapping lower floors or roofs", () => {
  const geometry = new ReplayFloorGeometry(
    [
      floor(0, true),
      floor(40, true),
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 10],
          [20, 0, 30],
          [0, 20, 10],
        ],
        indices: [0, 1, 2],
      },
    ],
    [{ id: "room", name: "not a usable ray origin", height: -100 }],
    [{ entry: 1, point: [1, 1, 11] }],
  );
  for (const x of [1, 7, 12, 7])
    assert.equal(geometry.height(x, 1, 0, true), 10 + x);
  assert.equal(geometry.height(7, 1, 0, false), 0);
});
test("a real drop keeps nearby calibrated altitude context instead of picking an underfloor", () => {
  const geometry = new ReplayFloorGeometry(
    [
      {
        ...floor(0, true),
        vertices: [
          [0, 0, 0],
          [60, 0, 0],
          [0, 60, 0],
        ],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 20],
          [10, 0, 20],
          [0, 10, 20],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [15, 0, 10],
          [30, 0, 10],
          [15, 15, 10],
        ],
        indices: [0, 1, 2],
      },
    ],
    [],
    [{ entry: 1, point: [1, 1, 20] }],
  );
  assert.equal(geometry.height(17, 1, 0, true), 10);
});
test("calibration rejects mismatched client geometry and invalid reference coordinates", () => {
  const geometry = new ReplayFloorGeometry(
    [floor(10, true), floor(30, true)],
    [],
    [
      { entry: 1, point: [1, 1, 50] },
      { entry: 2, point: [NaN, 1, 30] },
      { entry: 0, point: [1, 1, 30] },
    ],
  );
  assert.equal(geometry.height(10, 10, 12, true), 10);
  assert.deepEqual(geometry.contextCatalog(533, {}), {});
});
test("overlapping calibrated storeys remain seek-safe with changing encounter context", () => {
  const geometry = new ReplayFloorGeometry(
    [floor(10, true), floor(30, true)],
    [],
    [
      { entry: 1, point: [1, 1, 10] },
      { entry: 2, point: [1, 1, 30] },
    ],
  );
  for (const h of [10, 30, 10, 30])
    assert.equal(geometry.height(8, 8, h, true), h);
});
test("floor-only catalogs preserve overrides without modifying models or injecting spawn identity", () => {
  const geometry = new ReplayFloorGeometry(
    [floor(10, true), floor(30, true)],
    [],
    [{ entry: 1, point: [1, 1, 30] }],
  );
  const models = { 1: { displayID: 99 }, 2: { floorSeeds: [[533, 1, 1, 10]] } };
  const before = JSON.stringify(models),
    result = geometry.contextCatalog(533, models);
  assert.deepEqual(result[1], { floorSeeds: [[533, 1, 1, 30]] });
  assert.deepEqual(result[2], { floorSeeds: [[533, 1, 1, 10]] });
  assert.equal(JSON.stringify(models), before);
  assert.equal(geometry.contextCatalog(533, models), result);
});
test("projection caches stay bounded while queries remain deterministic after eviction", () => {
  const geometry = new ReplayFloorGeometry(
    [
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 30],
          [200, 0, 30],
          [0, 200, 30],
        ],
        indices: [0, 1, 2],
      },
    ],
    [],
    [{ entry: 1, point: [1, 1, 30] }],
  );
  const first = geometry.height(1, 1, 0, true);
  for (let x = 0; x < 65; x++)
    for (let y = 0; y < 65; y++) geometry.height(x + 0.1, y + 0.1, 0, true);
  assert.ok(
    (geometry as unknown as { projected: Map<string, unknown> }).projected
      .size <= 4096,
  );
  assert.equal(geometry.height(1, 1, 0, true), first);
});

test("an upper-level drop cannot borrow a continuous route on a lower calibrated storey", () => {
  const geometry = new ReplayFloorGeometry(
    [
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 0],
          [40, 0, 0],
          [0, 40, 0],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 20],
          [10, 0, 20],
          [0, 10, 20],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [15, 0, 10],
          [40, 0, 10],
          [15, 25, 10],
        ],
        indices: [0, 1, 2],
      },
    ],
    [],
    [
      { entry: 1, point: [1, 1, 20] },
      { entry: 2, point: [1, 1, 0] },
    ],
  );
  for (const hint of [20, 0, 20, 0])
    assert.equal(geometry.height(17, 1, hint, true), hint === 20 ? 10 : 0);
});
test("empty remote rooms use the nearest map calibration instead of entrance altitude", () => {
  const geometry = new ReplayFloorGeometry(
    [
      {
        area: "entry",
        interior: true,
        vertices: [
          [0, 0, 10],
          [20, 0, 10],
          [0, 20, 10],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "remote",
        interior: true,
        vertices: [
          [200, 0, 8],
          [220, 0, 8],
          [200, 20, 8],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "remote",
        interior: true,
        vertices: [
          [200, 0, 40],
          [220, 0, 40],
          [200, 20, 40],
        ],
        indices: [0, 1, 2],
      },
    ],
    [],
    [{ entry: 1, point: [1, 1, 10] }],
  );
  assert.equal(geometry.height(205, 1, 40, true), 8);
});

test("cached queries never move an actor off a platform before its actual coordinates leave the edge", () => {
  const geometry = new ReplayFloorGeometry(
    [
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 0],
          [40, 0, 0],
          [0, 40, 0],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 20],
          [10.2, 0, 20],
          [0, 10, 20],
          [10.2, 10, 20],
        ],
        indices: [0, 1, 2, 1, 3, 2],
      },
    ],
    [],
    [{ entry: 1, point: [1, 1, 20] }],
  );
  for (const [x, want] of [
    [9.9, 20],
    [10.1, 20],
    [10.25, 0],
    [10.1, 20],
  ])
    assert.equal(geometry.height(x, 1, 20, true), want);
});
