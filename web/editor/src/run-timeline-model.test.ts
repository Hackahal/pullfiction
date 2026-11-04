import { pullAt } from "./domain";
import test from "node:test";
import assert from "node:assert/strict";
import {
  projectRunClip,
  runRange,
  runTimeAt,
  zoomRunRange,
  runSegments,
  visibleRunMobs,
} from "./run-timeline-model";
import type { Actor, Replay } from "./types";
const npc = (
  key: string,
  name: string,
  firstSeen: number,
  lastSeen: number,
  extra = {},
) =>
  ({
    key,
    id: Number(key.split(":")[0]),
    name,
    firstSeen,
    lastSeen,
    gameID: 10,
    type: "NPC",
    class: "NPC",
    ...extra,
  }) as Actor;
const replay = (actors: Actor[], chapters: Replay["chapters"] = []) =>
  ({
    duration: 120000,
    fight: { id: 1, name: "Boss", encounterID: 1 },
    chapters,
    actors,
  }) as Replay;
test("Scrubber inherits boss encounter boundaries and representative portrait actor", () => {
  const boss = npc("1:1", "Boss", 60000, 90000, { class: "Boss" });
  const r = replay(
    [boss],
    [
      {
        id: 4,
        name: "Boss",
        encounterID: 1,
        start: 50000,
        end: 95000,
        kill: true,
        enemyNPCs: [{ id: 1 }],
      },
    ],
  );
  assert.deepEqual(
    runSegments(r).bosses.map((s) => [
      s.name,
      s.start,
      s.end,
      s.actor?.key,
      s.kill,
    ]),
    [["Boss", 50000, 95000, "1:1", true]],
  );
  assert.equal(runSegments(r).mobs.length, 0);
});
test("Repeated mobs group per pull using observations rather than persistent spawn time", () => {
  const r = replay(
    [
      npc("2:1", "Hound", 10000, 15000),
      npc("2:2", "Hound", 11000, 16000),
      npc("2:3", "Hound", 80000, 85000),
      npc("3:1", "Mage", 0, 120000, { type: "Player" }),
      npc("4:1", "Unseen", Infinity, -Infinity),
    ],
    [
      { id: 1, name: "Trash", start: 5000, end: 20000 },
      { id: 2, name: "Trash", start: 70000, end: 90000 },
    ],
  );
  const groups = runSegments(r).mobs;
  assert.deepEqual(
    groups.map((s) => [s.start, s.end, s.count]),
    [
      [10000, 16000, 2],
      [80000, 85000, 1],
    ],
  );
});
test("Single encounters and observations outside chapters stay navigable", () => {
  assert.equal(
    runSegments(replay([npc("2:1", "Add", 10000, 20000)])).bosses[0].end,
    120000,
  );
  const r = replay(
    [npc("2:1", "Trash", 30000, 35000)],
    [{ id: 1, name: "Boss", encounterID: 1, start: 60000, end: 90000 }],
  );
  assert.deepEqual(
    runSegments(r).mobs.map((s) => [s.start, s.end]),
    [[30000, 35000]],
  );
});
test("Navigation zoom preserves cursor time and clamps ends and minimum span", () => {
  const before = runRange(20000, 60000, 120000);
  const next = zoomRunRange(before, 2, 0.3, 120000);
  assert.equal(
    runTimeAt(30, 100, before, 120000),
    runTimeAt(30, 100, next, 120000),
  );
  assert.deepEqual(runRange(-1000, 500000, 120000), { start: 0, span: 120000 });
  assert.deepEqual(runRange(120000, 1, 120000), { start: 119000, span: 1000 });
  assert.equal(runTimeAt(-50, 100, next, 120000), next.start);
  assert.equal(runTimeAt(150, 100, next, 120000), next.start + next.span);
});
test("Zooming separates crowded mob portraits without losing names or mutating source", () => {
  const mobs = runSegments(
    replay([
      npc("2:1", "Hound", 10000, 20000),
      npc("3:1", "Giant", 11000, 21000, { gameID: 20 }),
    ]),
  ).mobs;
  const broad = visibleRunMobs(mobs, { start: 0, span: 120000 }, 1000);
  assert.equal(broad.length, 1);
  assert.equal(broad[0].count, 2);
  assert.match(broad[0].names, /Hound/);
  assert.match(broad[0].names, /Giant/);
  assert.equal(
    visibleRunMobs(mobs, { start: 9000, span: 10000 }, 1000).length,
    2,
  );
  assert.equal(mobs[0].count, 1);
});

test("Pull context covers a standalone encounter and does not fill full-run gaps", () => {
  const standalone = replay([]);
  assert.deepEqual(pullAt(standalone, 5000), { start: 0, end: 120000 });
  assert.equal(pullAt(standalone, 120001), null);
  const chapter = {
    id: 2,
    name: "Boss",
    start: 5000,
    end: 10000,
    encounterID: 1,
  };
  const trash = {
    id: 3,
    name: "Trash",
    start: 10000,
    end: 20000,
    encounterID: 0,
  };
  const full = replay([], [chapter, trash]);
  assert.equal(pullAt(full, 6000), chapter);
  assert.equal(pullAt(full, 4999), null);
  assert.equal(pullAt(full, 10000), null);
  assert.equal(pullAt(full, 12000), null);
});

test("Boss clips show recorded duration and clip to the visible time window", () => {
  const view = { start: 1000, span: 10000 };
  assert.deepEqual(projectRunClip({ start: 0, end: 2000 }, view), {
    left: 0,
    width: 10,
  });
  assert.deepEqual(projectRunClip({ start: 10500, end: 12000 }, view), {
    left: 95,
    width: 5,
  });
  assert.deepEqual(projectRunClip({ start: 10100, end: 10200 }, view), {
    left: 91,
    width: 1,
  });
  assert.equal(projectRunClip({ start: 0, end: 1000 }, view), null);
  assert.equal(projectRunClip({ start: 11000, end: 12000 }, view), null);
});

test("Nearby mobs from different encounters remain separate in the overview", () => {
  const mobs = [
    { key: "a", name: "Hound", start: 10000, end: 12000, count: 2, scope: "1" },
    { key: "b", name: "Giant", start: 13000, end: 14000, count: 4, scope: "2" },
  ];
  const visible = visibleRunMobs(mobs, { start: 0, span: 60000 }, 300);
  assert.deepEqual(
    visible.map(({ count, start, end }) => [count, start, end]),
    [
      [2, 10000, 12000],
      [4, 13000, 14000],
    ],
  );
});
