import test from "node:test";
import assert from "node:assert/strict";
import { populateRaidSpawns, spawnStatus } from "./spawn-model";
import { poseAt, combatStateAt } from "./domain";
import type { Actor, Replay } from "./types";
const actor = (id: number, x: number, first = 10000, death?: number) =>
  ({
    key: `${id}:1`,
    id,
    instance: 1,
    name: "Guard",
    type: "NPC",
    class: "NPC",
    gameID: 100,
    displayID: 1,
    scale: 1,
    samples: [[first, x, 0, null]],
    deaths: death === undefined ? [] : [[death, true]],
    firstSeen: first,
    lastSeen: death ?? first + 1000,
    runLifetime: false,
    facings: [],
    headings: [],
    health: [],
    power: [],
    resourceChanges: [],
    casts: [],
    auras: [],
    initialAuras: [],
    gear: [],
  }) as Actor;
const replay = (actors: Actor[]) =>
  ({ map: 469, actors, chapters: [], duration: 100000 }) as unknown as Replay;
const catalog = (xs: number[]) => ({
  100: {
    name: "Guard",
    displayID: 1,
    scale: 1,
    spawns: xs.map((x, i) => ({
      id: String(i + 1),
      map: 469,
      position: [x, 0, 413],
      facing: 1.5,
    })),
  },
});

test("all static spawns are visible, while matching reserves each slot once", () => {
  const a = actor(1, 0),
    b = actor(2, 20),
    r = populateRaidSpawns(replay([a, b]), catalog([0, 20, 40]));
  assert.equal(r.actors.length, 3);
  assert.notEqual(a.spawn?.key, b.spawn?.key);
  const unknown = r.actors.find((a) => a.spawn?.synthetic)!;
  assert.deepEqual(poseAt(unknown, 0)?.pos, [40, 0, null]);
  assert.equal(spawnStatus(unknown, 90000), "Unobserved spawn");
  assert.equal(combatStateAt(unknown, 0).health?.percent, 1);
  assert.equal(unknown.samples.length, 0);
});
test("pack assignment avoids the nearest-first greedy trap and is input-order stable", () => {
  const run = (reverse = false) => {
    const actors = [actor(1, 1), actor(2, -1.1)];
    const r = populateRaidSpawns(
      replay(reverse ? actors.reverse() : actors),
      catalog([0, 3]),
    );
    return Object.fromEntries(
      r.actors
        .filter((a) => !a.spawn?.synthetic)
        .map((a) => [a.key, a.spawn?.position[0]]),
    );
  };
  assert.deepEqual(run(), { "1:1": 3, "2:1": 0 });
  assert.deepEqual(run(true), run());
});
test("spawn estimate switches to recorded position without rewriting samples", () => {
  const a = actor(1, 20),
    samples = JSON.stringify(a.samples);
  populateRaidSpawns(replay([a]), catalog([0]));
  assert.deepEqual(poseAt(a, 0)?.pos, [0, 0, null]);
  assert.equal(poseAt(a, 0)?.positionSource, "matched spawn estimate");
  assert.deepEqual(poseAt(a, 10000)?.pos, [20, 0, null]);
  assert.equal(JSON.stringify(a.samples), samples);
});
test("death and backward seeking operate on the bound logged instance", () => {
  const a = actor(1, 0, 10000, 20000);
  populateRaidSpawns(replay([a]), catalog([0]));
  assert.equal(poseAt(a, 21000)?.dead, true);
  assert.equal(spawnStatus(a, 21000), "Killed in log");
  assert.equal(poseAt(a, 19000)?.dead, false);
  assert.equal(spawnStatus(a, 19000), "Observed in log");
  assert.equal(spawnStatus(a, 0), "Unobserved spawn");
});
test("respawn reuses a dead slot without showing the later life at raid start", () => {
  const a = actor(1, 0, 10000, 20000),
    b = actor(2, 1, 30000, 40000);
  const r = populateRaidSpawns(replay([b, a]), catalog([0]));
  assert.equal(a.spawn?.key, b.spawn?.key);
  assert.equal(r.actors.length, 2);
  assert.equal(poseAt(b, 0), null);
  assert.equal(poseAt(b, 25000), null);
  assert.ok(poseAt(b, 30000));
  assert.equal(poseAt(a, 30000)?.dead, true);
});
test("a living reservation cannot be stolen and distant/summoned mobs are not pre-spawned", () => {
  const a = actor(1, 0),
    b = actor(2, 0, 30000),
    far = actor(3, 1000);
  populateRaidSpawns(replay([a, b, far]), catalog([0]));
  assert.ok(a.spawn);
  assert.equal(b.spawn, undefined);
  assert.equal(far.spawn, undefined);
  assert.equal(poseAt(b, 0), null);
  assert.equal(poseAt(far, 0), null);
  assert.ok(poseAt(b, 30000));
});
test("unique NPC death without coordinates can bind; ambiguous deaths stay unassigned", () => {
  const a = { ...actor(1, 0, 10000, 20000), samples: [] } as Actor;
  populateRaidSpawns(replay([a]), catalog([0]));
  assert.ok(a.spawn);
  assert.equal(poseAt(a, 21000)?.dead, true);
  const b = { ...actor(2, 0, 10000, 20000), samples: [] } as Actor;
  const r = populateRaidSpawns(replay([b]), catalog([0, 20]));
  assert.equal(b.spawn, undefined);
  assert.equal(r.actors.filter((a) => a.spawn?.synthetic).length, 2);
});
test("map boundaries, duplicate metadata and repeat preparation do not duplicate mobs", () => {
  const c = catalog([0]);
  c[100].spawns.push(
    { ...c[100].spawns[0] },
    { ...c[100].spawns[0], id: "2", map: 531 },
  );
  const r = populateRaidSpawns(replay([]), c);
  assert.equal(r.actors.length, 1);
  populateRaidSpawns(r, c);
  assert.equal(r.actors.length, 1);
  assert.equal(r.actors[0].key, "spawn:469:1");
});

test("a death removes only its matched spawn among identical NPC entries", () => {
  const killed = actor(1, 0, 10000, 20000),
    survivor = actor(2, 20);
  const r = populateRaidSpawns(
    replay([killed, survivor]),
    catalog([0, 20, 40]),
  );
  const alive = (time: number) =>
    r.actors
      .filter((a) => {
        const p = poseAt(a, time);
        return p && !p.dead;
      })
      .map((a) => a.spawn!.key)
      .sort();
  assert.deepEqual(alive(0), ["spawn:469:1", "spawn:469:2", "spawn:469:3"]);
  assert.deepEqual(alive(21000), ["spawn:469:2", "spawn:469:3"]);
  assert.deepEqual(alive(19000), ["spawn:469:1", "spawn:469:2", "spawn:469:3"]);
});
