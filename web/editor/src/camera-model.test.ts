import test from "node:test";
import assert from "node:assert/strict";
import {
  raidCameraSubjects,
  raidMapFrame,
  easeMapCamera,
  raidCameraCenter,
} from "./camera-model";
import type { Actor, Replay } from "./types";
import { poseAt } from "./domain";
test("raid streaming center follows the player majority, excluding pets and resisting stragglers", () => {
  const player = (x: number) => ({
    actor: { type: "Player" },
    pos: [x, 0, null] as [number, number, null],
  });
  assert.deepEqual(
    raidCameraCenter([
      player(10),
      player(12),
      player(1000),
      { actor: { type: "Pet" }, pos: [-1000, 0, null] },
    ]),
    [12, 0],
  );
  assert.deepEqual(raidCameraCenter([player(10), player(12)]), [11, 0]);
  assert.equal(raidCameraCenter([]), null);
});
const actor = (
  id: number,
  type: string,
  x: number,
  firstSeen = 0,
  dead = false,
) =>
  ({
    key: `${id}:1`,
    id,
    type,
    firstSeen,
    lastSeen: 100000,
    samples: [
      [0, x, 0, null],
      [100000, x, 0, null],
    ],
    deaths: dead ? [[0, true]] : [],
    headings: [0, 0],
    facings: [],
  }) as unknown as Actor;
test("Raid camera includes players and nearby active enemies but excludes dead and future packs", () => {
  const r = {
    duration: 100000,
    fight: { friendlyPlayers: [1, 2] },
    chapters: [],
    combat: [{ t: 9000, kind: "damage", source: "1:1", target: "3:1" }],
    actors: [
      actor(1, "Player", 0),
      actor(2, "Player", 20),
      actor(3, "NPC", 25),
      actor(4, "NPC", 500),
      actor(5, "NPC", 40, 50000),
      actor(6, "NPC", 10, 0, true),
    ],
  } as unknown as Replay;
  assert.deepEqual(
    raidCameraSubjects(r, 10000, true).map((p) => p.actor.id),
    [1, 2, 3],
  );
});
test("Map framing contains the whole raid with room for portraits", () => {
  const subjects = [
    { pos: [0, 0, null] as [number, number, null] },
    { pos: [40, 20, null] as [number, number, null] },
  ];
  const f = raidMapFrame(subjects, 800, 500)!;
  assert.ok(f.scale > 0);
  assert.equal(f.x, -10);
  assert.equal(f.y, -20);
  assert.equal(raidMapFrame([], 800, 500), null);
});
test("Camera easing converges without overshooting and avoids a frame-rate dependency", () => {
  const initial = { x: 0, y: 0, scale: 1 },
    goal = { x: 100, y: 50, scale: 2 };
  const tick = (dt: number, n: number) => {
    let c = initial;
    for (let i = 0; i < n; i++) c = easeMapCamera(c, goal, dt);
    return c;
  };
  const a = tick(1 / 60, 60),
    b = tick(1 / 30, 30);
  assert.ok(Math.abs(a.x - b.x) < 1e-8);
  assert.ok(Math.abs(a.scale - b.scale) < 1e-8);
  assert.ok(a.x < 100 && a.x > 90);
  assert.ok(a.scale > 1 && a.scale < 2);
});

test("Idle encountered mobs do not frame the camera, and combat grace rewinds deterministically", () => {
  const r = {
    fight: { friendlyPlayers: [1] },
    chapters: [{ start: 0, end: 100000, enemyNPCs: [{ id: 3 }] }],
    actors: [actor(1, "Player", 0), actor(3, "NPC", 10), actor(4, "NPC", 15)],
    combat: [
      { t: 10000, kind: "heal", source: "1:1", target: "4:1" },
      { t: 20000, kind: "damage", source: "1:1", target: "3:1" },
      { t: 21000, kind: "go", source: "3:1", target: "1:1" },
    ],
  } as unknown as Replay;
  const keys = (t: number) =>
    raidCameraSubjects(r, t, true).map((p) => p.actor.key);
  assert.deepEqual(keys(15000), ["1:1"]);
  assert.deepEqual(keys(22000), ["1:1", "3:1"]);
  assert.deepEqual(keys(30000), ["1:1"]);
  assert.deepEqual(keys(20000), ["1:1", "3:1"]);
  r.actors[1].deaths = [[20500, true]];
  assert.deepEqual(keys(22000), ["1:1"]);
});

test("an optional recorded-pose lookup preserves every camera subject and query argument", () => {
  const r = {
    fight: { friendlyPlayers: [1] },
    combat: [{ t: 9000, kind: "damage", source: "1:1", target: "2:1" }],
    actors: [
      actor(1, "Player", 0),
      actor(2, "NPC", 25),
      actor(3, "NPC", 30, 0, true),
    ],
  } as unknown as Replay;
  const calls: unknown[] = [];
  assert.deepEqual(
    raidCameraSubjects(r, 10000, true, (a, t, smooth) => {
      calls.push([a, t, smooth]);
      return poseAt(a, t, smooth);
    }),
    raidCameraSubjects(r, 10000, true),
  );
  assert.deepEqual(
    calls,
    r.actors.map((a) => [a, 10000, true]),
  );
});
