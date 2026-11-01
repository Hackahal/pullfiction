import test from "node:test";
import assert from "node:assert/strict";
import { IncrementalReplayNormalizer } from "./incremental-replay";
import { enrichCombat, normalizeReplay, combatStateAt, poseAt } from "./domain";
import type { RawReplay } from "./types";
const models = {},
  items = {},
  spells = { 10: { castMs: 1000 } };
const event = (timestamp: number, id: number, type = "damage") => ({
  timestamp,
  type,
  sourceID: id,
  targetID: 3,
  abilityGameID: 10,
  sourceResources: {
    x: 10000 + timestamp,
    y: 20000,
    hitPoints: 100,
    maxHitPoints: 100,
  },
  amount: 1,
});
function raw(events: unknown[]): RawReplay {
  return {
    report: { code: "incremental", title: "Incremental fixture" },
    fight: {
      id: 1,
      name: "Test fight",
      startTime: 0,
      endTime: 180000,
      gameZone: { name: "Molten Core" },
      friendlyPlayers: [1, 2],
    },
    actors: [
      { id: 1, name: "One", type: "Player", subType: "Mage" },
      { id: 2, name: "Two", type: "Player", subType: "Mage" },
      { id: 3, name: "Target", type: "NPC", gameID: 1 },
    ],
    events,
    stream: {
      version: 1,
      id: "source",
      revision: 1,
      segments: 3,
      reportEnd: 180000,
      full: [[0, 60000]],
      history: [],
      stateEvents: [],
      contextEvents: [],
      foreign: [],
    },
  } as RawReplay;
}
function check(cache: IncrementalReplayNormalizer, input: RawReplay) {
  const actual = cache.normalize(input, models, items, spells);
  const expected = enrichCombat(normalizeReplay(input, models), items, spells);
  assert.deepEqual(actual, expected);
  for (const a of actual.actors)
    for (const at of [0, 1000, 60000, 120000, 179999]) {
      const b = expected.actors.find((b) => b.key === a.key)!;
      assert.deepEqual(combatStateAt(a, at), combatStateAt(b, at));
      assert.deepEqual(poseAt(a, at), poseAt(b, at));
    }
  return actual;
}
test("stream growth reuses unchanged actor objects and combat indexes with exact full-normalizer output", () => {
  const cache = new IncrementalReplayNormalizer();
  const events = [
    event(100, 1, "begincast"),
    event(1100, 1, "cast"),
    event(2000, 2),
  ];
  const first = check(cache, raw(events));
  const second = check(
    cache,
    raw([
      ...events,
      event(60000, 2),
      event(60000, 2),
      event(120000, 2, "death"),
    ]),
  );
  assert.equal(second.actors[0], first.actors[0]);
  assert.equal(second.actors[0].casts, first.actors[0].casts);
  assert.notEqual(second.actors[1], first.actors[1]);
});
test("earlier insertions rebuild affected cast IDs and backwards seeks retain exact states", () => {
  const cache = new IncrementalReplayNormalizer();
  const events = [event(60000, 1, "begincast"), event(61000, 1, "cast")];
  const first = check(cache, raw(events));
  const second = check(cache, raw([event(0, 2), ...events]));
  assert.notEqual(first.actors[0], second.actors[0]);
  assert.equal(second.actors[0].casts[0].id, 1);
});
test("global boundaries, source revisions, metadata and reset invalidate reuse", () => {
  const cache = new IncrementalReplayNormalizer();
  const events = [event(0, 1), event(1000, 1)];
  let prior = check(cache, raw(events));
  for (const type of [
    "zonechange",
    "encounterstart",
    "encounterend",
    "combatantinfo",
  ]) {
    const next = check(
      cache,
      raw([...events, { type, timestamp: 90000, sourceID: 2 }]),
    );
    assert.notEqual(prior.actors[0], next.actors[0]);
    prior = next;
  }
  const source = raw(events);
  source.stream!.revision++;
  const next = check(cache, source);
  assert.notEqual(prior.actors[0], next.actors[0]);
  const replaced = cache.normalize(source, {}, items, spells);
  assert.notEqual(next.actors[0], replaced.actors[0]);
  cache.reset();
  assert.notEqual(
    cache.normalize(source, models, items, spells).actors[0],
    replaced.actors[0],
  );
});

test("successive out-of-order chunks preserve deaths, resurrection, aura stacks, casts and target instances", () => {
  const cache = new IncrementalReplayNormalizer();
  const accumulated: unknown[] = [];
  const kinds = [
    "damage",
    "heal",
    "begincast",
    "cast",
    "applybuff",
    "applybuffstack",
    "removebuff",
    "death",
    "resurrect",
    "interrupt",
    "summon",
    "resourcechange",
  ];
  for (let chunk = 0; chunk < 12; chunk++) {
    for (let i = 0; i < kinds.length; i++) {
      accumulated.push({
        ...event(
          (chunk * 13000 + i * 1000) % 180000,
          (chunk % 2) + 1,
          kinds[i],
        ),
        sourceInstance: chunk % 3 === 0 ? 2 : 1,
        targetInstance: chunk % 4 === 0 ? 2 : 1,
        stack: 3,
        resourceChangeType: 0,
        resourceChange: 20,
        maxResourceAmount: 100,
      });
    }
    const input = raw([...accumulated]);
    Object.assign(input.fight, {
      chapters: [
        { ...input.fight, startTime: 0, endTime: 90000 },
        { ...input.fight, startTime: 100000, endTime: 180000 },
      ],
    });
    check(cache, input);
  }
});
