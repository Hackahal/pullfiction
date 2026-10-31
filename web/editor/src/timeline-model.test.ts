import test from "node:test";
import assert from "node:assert/strict";
import {
  playerTracks,
  followingStart,
  visibleCasts,
  castEvents,
  raidTimelineLanes,
  searchTimelineLanes,
  timelineMatches,
  nextTimelineMatch,
  draggedTimelineRange,
  detailLanes,
} from "./timeline-model";
import type { Replay, Actor, Cast } from "./types";
const cast = {
  spell: 10,
  name: "Fireball",
  start: 1000,
  end: 3000,
  target: "2:1",
} as Cast;
const actor = {
  id: 1,
  key: "1:1",
  name: "Mage",
  class: "Mage",
  type: "Player",
  casts: [
    cast,
    { spell: 20, name: "Blink", start: 4000, end: 4500, instant: true },
  ],
} as Actor;
test("Timeline has a lane for every friendly player, including players with no casts", () => {
  const replay = {
    fight: { friendlyPlayers: [1, 2] },
    actors: [
      actor,
      {
        id: 2,
        key: "2:1",
        name: "Priest",
        class: "Priest",
        type: "Player",
        casts: [],
      },
      {
        id: 3,
        key: "3:1",
        name: "External",
        class: "Mage",
        type: "Player",
        casts: [],
      },
      { id: 4, type: "NPC" },
    ],
  } as unknown as Replay;
  assert.deepEqual(
    playerTracks(replay).map((a) => a.id),
    [1, 2],
  );
});
test("Visible casts include instant abilities and preserve original indices for drilldown", () => {
  assert.deepEqual(
    visibleCasts(actor, 3500, 4100).map((c) => c.index),
    [1],
  );
  assert.deepEqual(
    visibleCasts(actor, 2000, 2500).map((c) => c.index),
    [0],
  );
  assert.deepEqual(visibleCasts(actor, 4100, 5000), []);
});
test("Playback following advances the viewport, follows loops backward and stops at run bounds", () => {
  assert.equal(followingStart(30000, 0, 60000, 120000), 0);
  assert.equal(followingStart(55000, 0, 60000, 120000), 13000);
  assert.equal(followingStart(5000, 43000, 60000, 120000), 0);
  assert.equal(followingStart(119000, 60000, 60000, 120000), 60000);
  assert.equal(followingStart(50000, 0, 120000, 120000), 0);
});
test("Cast drilldown only includes the same source/spell in its window and stops before the next cast", () => {
  const replay = {
    duration: 20000,
    combat: [
      { id: 1, t: 3000, source: "1:1", spell: 10 },
      { id: 2, t: 3500, source: "2:1", spell: 10 },
      { id: 3, t: 4000, source: "1:1", spell: 20 },
      { id: 4, t: 6000, source: "1:1", spell: 10 },
    ],
  } as Replay;
  const repeated = {
    ...actor,
    casts: [cast, { ...cast, start: 5000, end: 6000 }],
  };
  assert.deepEqual(
    castEvents(replay, repeated, cast).map((e) => e.id),
    [1],
  );
});

test("Ability lanes group repeated casts, preserve inspection indices and optionally hide melee", async () => {
  const { timelineLanes } = await import("./timeline-model");
  const a = {
    ...actor,
    casts: [
      ...actor.casts,
      { ...cast, start: 5000, end: 6000 },
      {
        ...cast,
        spell: 1,
        name: "Melee",
        instant: true,
        start: 7000,
        end: 7500,
      },
    ],
  };
  const lanes = timelineLanes([a], true, false);
  assert.deepEqual(
    lanes.map((l) => l.name),
    ["Mage", "Fireball", "Blink"],
  );
  assert.deepEqual(
    lanes[1].casts.map((c) => c.index),
    [0, 2],
  );
  assert.equal(timelineLanes([a], true, true).at(-1)?.spell, 1);
  assert.equal(timelineLanes([a], false, false)[0].casts.length, 3);
});

test("Aura intervals preserve snapshots, refreshes, stacks, removals and rewind boundaries", async () => {
  const { auraIntervals, detailLanes } = await import("./timeline-model");
  const a = {
    ...actor,
    initialAuras: [10],
    auras: [
      [1000, { spell: 10, name: "Buff", stack: 2, debuff: false }],
      [
        2000,
        { spell: 10, name: "Buff", stack: 1, debuff: false, remove: true },
      ],
      [2500, { reset: [20] }],
      [3000, { spell: 30, name: "Debuff", stack: 1, debuff: true }],
    ],
  } as Actor;
  const r = {
    duration: 5000,
    abilities: new Map([
      [10, { name: "Buff" }],
      [20, { name: "Snapshot" }],
    ]),
  } as Replay;
  const intervals = auraIntervals(a, r);
  assert.deepEqual(
    intervals
      .filter((i) => i.spell === 10)
      .map((i) => [i.start, i.end, i.stack]),
    [
      [0, 1000, 1],
      [1000, 2000, 2],
    ],
  );
  assert.deepEqual(
    intervals.filter((i) => i.spell === 20).map((i) => [i.start, i.end]),
    [[2500, 5000]],
  );
  const lanes = detailLanes(a, r, false, true, false);
  assert.ok(lanes.some((l) => l.name === "Buff · Buff"));
  assert.ok(!lanes.some((l) => l.name === "Debuff · Debuff"));
  assert.ok(
    detailLanes(a, r, false, false, true).some(
      (l) => l.name === "Debuff · Debuff",
    ),
  );
});
test("Damage graph uses recorded source, raid/pet scope and only prior five seconds for current DPS", async () => {
  const { damageSeries, currentDps } = await import("./timeline-model");
  const r = {
    duration: 10000,
    fight: { friendlyPlayers: [1] },
    actors: [
      actor,
      { id: 3, key: "3:1", owner: 1, type: "Pet" },
      { id: 2, key: "2:1", type: "NPC" },
    ],
    combat: [
      { t: 1000, kind: "damage", source: "1:1", amount: 100 },
      { t: 2000, kind: "damage", source: "3:1", amount: 50 },
      { t: 3000, kind: "damage", source: "2:1", amount: 500 },
      { t: 7000, kind: "damage", source: "1:1", amount: 200 },
    ],
  } as Replay;
  assert.equal(damageSeries(r, "1:1")[1], 100);
  assert.equal(damageSeries(r)[2], 50);
  assert.equal(damageSeries(r)[3], 0);
  assert.equal(currentDps(r, 5000, "1:1"), 20);
  assert.equal(currentDps(r, 5000), 30);
  assert.equal(currentDps(r, 8000, "1:1"), 40);
  assert.equal(currentDps(r, 500, "1:1"), 0);
});

test("Healing graphs and HPS only aggregate effective healing events", async () => {
  const { damageSeries, currentDps } = await import("./timeline-model");
  const r = {
    duration: 10000,
    fight: { friendlyPlayers: [1] },
    actors: [actor],
    combat: [
      { t: 1000, kind: "damage", source: "1:1", amount: 1000 },
      { t: 2000, kind: "heal", source: "1:1", amount: 100 },
    ],
  } as Replay;
  assert.equal(damageSeries(r, "1:1", "heal")[1], 0);
  assert.equal(damageSeries(r, "1:1", "heal")[2], 100);
  assert.equal(currentDps(r, 5000, "1:1", "heal"), 20);
});

test("Player, ability and combined timeline views conserve casts and original source indices", () => {
  const other = {
    ...actor,
    id: 3,
    key: "3:1",
    name: "Other mage",
    casts: [
      { ...cast, start: 500, end: 900 },
      { ...cast, start: 3500, end: 3900 },
    ],
  };
  for (const view of ["players", "abilities", "combined"] as const) {
    const lanes = raidTimelineLanes([actor, other], view, false);
    assert.equal(
      lanes.reduce((n, l) => n + l.casts.length, 0),
      4,
    );
  }
  const players = raidTimelineLanes([actor, other], "players", false);
  assert.equal(players.length, 2);
  const combined = raidTimelineLanes([actor, other], "combined", false);
  assert.deepEqual(
    combined.map((l) => l.name),
    ["Mage", "Fireball", "Blink", "Other mage", "Fireball"],
  );
  const abilities = raidTimelineLanes([actor, other], "abilities", false);
  assert.deepEqual(
    abilities.map((l) => l.name),
    ["Blink", "Fireball"],
  );
  assert.equal(abilities[1].aggregate, true);
  assert.deepEqual(
    abilities[1].casts.map((c) => [c.actor?.key, c.index]),
    [
      ["3:1", 0],
      ["1:1", 0],
      ["3:1", 1],
    ],
  );
});

test("Timeline search matches abilities, IDs, source, class and target while retaining player headers", () => {
  const boss = { key: "2:1", name: "Ragnaros" } as Actor;
  const r = { actors: [actor, boss] } as Replay;
  const lanes = raidTimelineLanes([actor], "combined", false);
  for (const query of [
    "FIREBALL",
    "10",
    'ability:"Fireball" player:Mage',
    "class:Mage target:Ragnaros",
    "spell:10",
  ]) {
    const found = searchTimelineLanes(lanes, r, query);
    assert.deepEqual(
      found.map((l) => l.name),
      ["Mage", "Fireball"],
    );
    assert.equal(timelineMatches(found)[0].castIndex, 0);
  }
  assert.equal(searchTimelineLanes(lanes, r, "spell:1").length, 0);
  assert.equal(
    searchTimelineLanes(lanes, r, "ability:Fireball target:missing").length,
    0,
  );
  assert.equal(
    timelineMatches(searchTimelineLanes(lanes, r, "Mage")).length,
    2,
  );
  assert.equal(searchTimelineLanes(lanes, r, "  "), lanes);
  const compact = raidTimelineLanes([actor], "players", false);
  assert.equal(searchTimelineLanes(compact, r, "Fireball")[0].casts.length, 1);
});

test("Search includes focused buffs and debuffs and respects their visibility toggles", () => {
  const a = {
    ...actor,
    initialAuras: [],
    auras: [
      [500, { spell: 100, name: "Arcane Intellect", stack: 1, debuff: false }],
      [1000, { spell: 101, name: "Curse of Doom", stack: 1, debuff: true }],
    ],
  } as Actor;
  const r = { actors: [a], duration: 6000, abilities: new Map() } as Replay;
  const lanes = detailLanes(a, r, false, true, true);
  const buff = timelineMatches(
    searchTimelineLanes(lanes, r, 'buff:"arcane intellect"'),
  );
  assert.deepEqual(
    buff.map((m) => [m.t, m.spell]),
    [[500, 100]],
  );
  assert.equal(
    timelineMatches(searchTimelineLanes(lanes, r, "debuff:curse")).length,
    1,
  );
  assert.equal(searchTimelineLanes(lanes, r, "buff:curse").length, 0);
  assert.equal(
    searchTimelineLanes(
      detailLanes(a, r, false, true, false),
      r,
      "debuff:curse",
    ).length,
    0,
  );
});

test("Timeline search navigation wraps, handles same-time occurrences and follows rewinds", () => {
  const lanes = raidTimelineLanes(
    [actor, { ...actor, key: "3:1" }],
    "abilities",
    false,
  );
  const matches = timelineMatches(lanes);
  assert.equal(matches.length, 4);
  assert.equal(nextTimelineMatch(matches, 0, 1), 0);
  assert.equal(nextTimelineMatch(matches, 1000, 1), 0);
  assert.equal(nextTimelineMatch(matches, 1000, 1, 0), 1);
  assert.equal(nextTimelineMatch(matches, 1000, -1, 1), 0);
  assert.equal(nextTimelineMatch(matches, 5000, 1), 0);
  assert.equal(nextTimelineMatch(matches, 0, -1), 3);
  assert.equal(nextTimelineMatch(matches, 3000, -1), 1);
  assert.equal(nextTimelineMatch([], 0, 1), -1);
});

test("Right-drag timeline panning follows grab direction and clamps time and row bounds", () => {
  assert.deepEqual(
    draggedTimelineRange(5000, 100, 20, 30, 10, 20000, 4000, 500),
    { start: 4800, vertical: 70 },
  );
  assert.deepEqual(
    draggedTimelineRange(5000, 100, -20, -30, 10, 20000, 4000, 500),
    { start: 5200, vertical: 130 },
  );
  assert.deepEqual(
    draggedTimelineRange(5000, 100, 99999, 99999, 10, 20000, 4000, 500),
    { start: 0, vertical: 0 },
  );
  assert.deepEqual(
    draggedTimelineRange(5000, 100, -99999, -99999, 10, 20000, 4000, 500),
    { start: 16000, vertical: 500 },
  );
});
