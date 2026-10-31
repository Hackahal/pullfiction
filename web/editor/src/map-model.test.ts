import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  CLASS_CELLS,
  fitMap,
  frameMapSelection,
  mapPoint,
  worldPoint,
  mapScreen,
  screenMap,
  zoomMap,
  type MapManifest,
} from "./map-model";
import { RAIDS } from "./domain";
test("Tactical map is north-up and world/screen projection roundtrips at every raid entrance", () => {
  const camera = { x: 170, y: -300, scale: 1.7 };
  for (const raid of RAIDS) {
    const [x, y] = raid.spawn,
      p = mapPoint(x, y),
      pixel = mapScreen(p, camera, 900, 650),
      back = worldPoint(...screenMap(pixel, camera, 900, 650));
    assert.ok(Math.abs(back[0] - x) < 1e-8);
    assert.ok(Math.abs(back[1] - y) < 1e-8);
    assert.deepEqual(worldPoint(...p), [x, y]);
  }
  assert.ok(mapPoint(10, 0)[1] < mapPoint(0, 0)[1]);
  assert.ok(mapPoint(0, 10)[0] < mapPoint(0, 0)[0]);
});
test("Map zoom keeps the point under the cursor fixed and fit stays within the viewport", () => {
  const bounds = [-200, -300, 600, 200],
    camera = fitMap(bounds, 1000, 700),
    pixel: [number, number] = [200, 300];
  const p = screenMap(pixel, camera, 1000, 700),
    next = zoomMap(camera, pixel, 1.25, 1000, 700);
  const after = mapScreen(p, next, 1000, 700);
  assert.ok(Math.abs(after[0] - pixel[0]) < 1e-8);
  assert.ok(Math.abs(after[1] - pixel[1]) < 1e-8);
  for (const p of [
    [-200, -300],
    [600, 200],
  ] as [number, number][]) {
    const [x, y] = mapScreen(p, camera, 1000, 700);
    assert.ok(x >= 0 && x <= 1000 && y >= 0 && y <= 700);
  }
  assert.ok(zoomMap(camera, pixel, 1e20, 1000, 700).scale <= 20);
});
test("Class icons use distinct original atlas cells for all nine Vanilla classes", () => {
  assert.equal(Object.keys(CLASS_CELLS).length, 9);
  assert.equal(
    new Set(Object.values(CLASS_CELLS).map((c) => c.join(":"))).size,
    9,
  );
  assert.deepEqual(CLASS_CELLS.Mage, [1, 0]);
  assert.deepEqual(CLASS_CELLS.Paladin, [0, 2]);
});
test("Generated local map manifests cover raid entry coordinates and reference extracted images", (t) => {
  for (const raid of RAIDS) {
    const path = `../dist/maps/${raid.map}.json`;
    if (!existsSync(path)) {
      t.skip("Local map art not generated");
      return;
    }
    const map = JSON.parse(readFileSync(path, "utf8")) as MapManifest;
    assert.equal(map.map, raid.map);
    assert.ok(map.tiles.length > 0);
    assert.ok(
      map.tiles.every(
        (tile) =>
          tile.corners.length === 4 &&
          tile.corners.flat().every(Number.isFinite),
      ),
    );
    const entry = mapPoint(raid.spawn[0], raid.spawn[1]);
    assert.ok(
      entry[0] >= map.bounds[0] - 100 &&
        entry[0] <= map.bounds[2] + 100 &&
        entry[1] >= map.bounds[1] - 100 &&
        entry[1] <= map.bounds[3] + 100,
      raid.name,
    );
    for (const tile of map.tiles)
      assert.ok(existsSync("../dist" + tile.src), tile.src);
  }
});

test("Interior source-image edges meet their actual neighbouring MC grid cells", (t) => {
  const path = "../dist/maps/409.json";
  if (!existsSync(path)) {
    t.skip("Local MC art not generated");
    return;
  }
  const map = JSON.parse(readFileSync(path, "utf8")) as MapManifest;
  const byCell = new Map(
    map.tiles
      .filter((tile) => tile.cell)
      .map((tile) => [`${tile.area}:${tile.cell!.join(":")}`, tile]),
  );
  assert.ok(
    byCell.size > 0,
    "Interior cell metadata required for map art checks",
  );
  let joins = 0;
  const same = (a: number[], b: number[]) =>
    assert.ok(
      Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7,
      `Disconnected image edge ${a} vs ${b}`,
    );
  for (const tile of byCell.values()) {
    const [col, row] = tile.cell!;
    const right = byCell.get(`${tile.area}:${col + 1}:${row}`);
    if (right) {
      same(tile.corners[1], right.corners[0]);
      same(tile.corners[2], right.corners[3]);
      joins++;
    }
    // Interior row numbers rise along local +Y, while image V rises downwards.
    // The upper edge of row N must meet the lower edge of row N+1.
    const above = byCell.get(`${tile.area}:${col}:${row + 1}`);
    if (above) {
      same(tile.corners[0], above.corners[3]);
      same(tile.corners[1], above.corners[2]);
      joins++;
    }
  }
  assert.ok(
    joins > 20,
    "Check real adjacent images across multiple MC room groups",
  );
});

test("Map tokens use WCL boss classification for larger portraits and strip custom icon prefixes", async () => {
  const { mapActorToken } = await import("./map-model");
  const boss = mapActorToken({
    type: "NPC",
    class: "Boss",
    icon: "custom-icon-spell_fire_flametounge.jpg",
  });
  const mob = mapActorToken({ type: "NPC", class: "NPC", icon: "NPC" });
  const player = mapActorToken({ type: "Player", class: "Mage", icon: null });
  assert.equal(boss.boss, true);
  assert.equal(mob.boss, false);
  assert.ok(boss.radius > mob.radius);
  assert.ok(mob.radius > player.radius);
  assert.equal(boss.icon, "/game-ui/icons/spell_fire_flametounge.png");
  assert.equal(mob.icon, "/game-ui/icons/inv_misc_monsterhead_02.png");
  assert.equal(
    mapActorToken({ type: "Pet", class: "Pet", icon: null }).boss,
    false,
  );
});

test("Frame selection fits a range, retains actor context and includes multiple selections", () => {
  assert.equal(frameMapSelection([], 900, 650), null);
  assert.equal(frameMapSelection([[NaN, 1]], 900, 650), null);
  const actor = frameMapSelection([[700, 400]], 900, 650)!;
  assert.deepEqual(mapScreen([700, 400], actor, 900, 650), [450, 325]);
  assert.equal(actor.scale, (650 - 80) / 80);
  const points: [number, number][] = [
    [-200, -300],
    [600, 200],
    [0, 500],
  ];
  const camera = frameMapSelection(points, 900, 650)!;
  for (const point of points) {
    const [x, y] = mapScreen(point, camera, 900, 650);
    assert.ok(x >= 20 && x <= 880 && y >= 40 && y <= 610);
  }
});
