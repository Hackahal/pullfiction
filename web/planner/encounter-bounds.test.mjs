import test from "node:test";
import assert from "node:assert/strict";
import { resolveEncounterBounds } from "./encounter-bounds.mjs";

// Recorded KT boundary timestamps, raw/provider IDs and chapter identities from
// the complete 30-edge boundary-query-probe. Rosters below are small fixtures.
const start = 6456709,
  reported = 6686778,
  end = 6865121;
const zone = { id: 533, name: "Naxxramas" };
function fixture() {
  const prelude = {
    id: 41,
    encounterID: 0,
    startTime: start,
    endTime: 6686208,
    gameZone: zone,
    friendlyPlayers: [1, 2],
    enemyNPCs: [{ id: 257 }],
  };
  const fight = {
    id: 42,
    encounterID: 201114,
    startTime: reported,
    endTime: end,
    gameZone: zone,
    friendlyPlayers: [2, 3],
    enemyNPCs: [{ id: 260 }],
  };
  const edges = [
    { type: "encounterstart", timestamp: start, encounterID: 1114, fight: 41 },
    { type: "encounterend", timestamp: end, encounterID: 1114, fight: 42 },
  ];
  return {
    report: { gameVersion: "sod", fights: [prelude, fight] },
    fight,
    edges,
  };
}
const resolve = (f) => resolveEncounterBounds(f.report, f.fight, f.edges);

test("recorded KT pair expands the prelude across chapter and ID namespaces", () => {
  const f = fixture(),
    original = structuredClone(f),
    result = resolve(f);
  assert.equal(result.startTime, start);
  assert.equal(result.endTime, end);
  assert.equal(result.encounterID, 201114);
  assert.deepEqual(result.reportedBounds, {
    startTime: reported,
    endTime: end,
  });
  assert.deepEqual(result.recordedPrelude, {
    kind: "recorded-encounter-boundaries",
    rawEncounterID: 1114,
    startEvent: { timestamp: start, fight: 41 },
    endEvent: { timestamp: end, fight: 42 },
    chapterIds: [41, 42],
  });
  assert.deepEqual(result.friendlyPlayers, [2, 3, 1]);
  assert.deepEqual(result.enemyNPCs, [{ id: 257 }, { id: 260 }]);
  assert.deepEqual(f, original, "resolver does not change source truth");
  assert.equal(resolveEncounterBounds(f.report, result, f.edges), result);
  assert.deepEqual(
    resolveEncounterBounds(f.report, f.fight, [...f.edges].reverse()),
    result,
  );
});

test("repeated pulls pair independently by raw identity and observed terminal fight", () => {
  const f = fixture();
  f.edges.unshift(
    { type: "encounterstart", timestamp: 100, encounterID: 1114, fight: 9 },
    { type: "encounterend", timestamp: 200, encounterID: 1114, fight: 10 },
  );
  assert.equal(resolve(f).startTime, start);
});

for (const [name, mutate] of [
  ["missing start", (f) => f.edges.shift()],
  ["missing end", (f) => f.edges.pop()],
  ["different raw identities", (f) => (f.edges[1].encounterID = 1115)],
  ["wrong terminal chapter", (f) => (f.edges[1].fight = 43)],
  ["nonmatching terminal timestamp", (f) => f.edges[1].timestamp--],
  ["unmapped start chapter", (f) => (f.edges[0].fight = 99)],
  ["duplicate start", (f) => f.edges.push({ ...f.edges[0] })],
  ["duplicate terminal", (f) => f.edges.push({ ...f.edges[1] })],
  [
    "nested same-identity start",
    (f) => f.edges.push({ ...f.edges[0], timestamp: start + 1 }),
  ],
  [
    "intervening different encounter",
    (f) =>
      f.edges.push({ ...f.edges[0], encounterID: 1115, timestamp: start + 1 }),
  ],
  [
    "foreign map chapter",
    (f) => (f.report.fights[0].gameZone = { id: 469, name: "Blackwing Lair" }),
  ],
  [
    "foreign map boundary",
    (f) => (f.edges[0].gameZone = { id: 469, name: "Blackwing Lair" }),
  ],
  ["foreign map ID on boundary", (f) => (f.edges[0].mapID = 469)],
  [
    "intervening foreign raw end",
    (f) =>
      f.edges.push({ ...f.edges[1], encounterID: 1115, timestamp: start + 1 }),
  ],
  ["missing selected metadata", (f) => f.report.fights.pop()],
  ["ambiguous selected metadata", (f) => f.report.fights.push({ ...f.fight })],
  ["crossed boss chapter", (f) => (f.report.fights[0].encounterID = 201119)],
  ["full run", (f) => (f.fight.id = "run")],
  ["aggregate raid", (f) => (f.fight.completeRaid = true)],
  ["ordinary trash", (f) => (f.fight.encounterID = 0)],
  ["start would shrink scope", (f) => (f.edges[0].timestamp = reported + 1)],
])
  test(`retains reported bounds for ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(resolve(f), f.fight);
  });

test("another boss ending before the prelude does not block expansion", () => {
  const f = fixture();
  f.report.fights.unshift({
    id: 40,
    encounterID: 201119,
    startTime: 6183213,
    endTime: 6353573,
    gameZone: zone,
    friendlyPlayers: [99],
  });
  assert.deepEqual(resolve(f).recordedPrelude.chapterIds, [41, 42]);
  assert.ok(!resolve(f).friendlyPlayers.includes(99));
});
