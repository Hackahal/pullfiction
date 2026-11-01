import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReplay, enrichCombat } from "./domain";
import {
  parseEncounter,
  parsePace,
  percentileAt,
  referenceFor,
  predictionSupported,
  defaultParseOptions,
  type ParseData,
} from "./playback-parses";
import type { RawReplay } from "./types";
export function parseFixture() {
  return enrichCombat(
    normalizeReplay(
      {
        report: { code: "ABcdEFghIJklMNop", title: "Parse fixture" },
        fight: {
          id: 14,
          encounterID: 201118,
          name: "Patchwerk",
          startTime: 100000,
          endTime: 110000,
          friendlyPlayers: [1],
          gameZone: { name: "Naxxramas" },
          kill: true,
        },
        actors: [
          { id: 1, name: "Mage", type: "Player", subType: "Mage" },
          { id: 2, name: "Pet", type: "Pet", petOwner: 1 },
          { id: 10, name: "Boss", type: "NPC" },
        ],
        abilities: [],
        events: [
          {
            timestamp: 101000,
            sourceID: 1,
            targetID: 10,
            type: "damage",
            amount: 1000,
          },
          {
            timestamp: 102000,
            sourceID: 2,
            targetID: 10,
            type: "damage",
            amount: 500,
          },
          {
            timestamp: 102000,
            sourceID: 1,
            targetID: 1,
            type: "damage",
            amount: 9000,
          },
          {
            timestamp: 109000,
            sourceID: 1,
            targetID: 10,
            type: "damage",
            amount: 9000,
          },
        ],
      } as unknown as RawReplay,
      {},
    ),
    {},
  );
}
test("pace includes pets, excludes friendly damage and never reads past playhead", () => {
  const replay = parseFixture(),
    fight = parseEncounter(replay, 0)!;
  assert.equal(parsePace(replay, fight, 0)[0].dps, null);
  assert.equal(parsePace(replay, fight, 1000)[0].dps, 1000);
  assert.equal(parsePace(replay, fight, 2000)[0].dps, 750);
  assert.equal(parsePace(replay, fight, 10000)[0].dps, 1050);
  assert.equal(parsePace(replay, fight, 20000)[0].dps, 1050);
  assert.equal(parsePace(replay, fight, 1000)[0].dps, 1000);
});
test("current boss selection resets at new pulls and does not leak future/trash", () => {
  const r = parseFixture();
  r.chapters = [
    {
      id: 1,
      name: "First",
      start: 1000,
      end: 3000,
      encounterID: 11,
      kill: true,
    },
    { id: 2, name: "Trash", start: 4000, end: 5000, encounterID: 0 },
    {
      id: 3,
      name: "Second",
      start: 6000,
      end: 8000,
      encounterID: 12,
      kill: false,
    },
  ];
  assert.equal(parseEncounter(r, 0), null);
  assert.equal(parseEncounter(r, 1500)?.id, 1);
  assert.equal(parseEncounter(r, 3500)?.id, 1);
  assert.equal(parseEncounter(r, 4500), null);
  assert.equal(parseEncounter(r, 6500)?.id, 3);
  assert.equal(parseEncounter(r, 6500)?.kill, false);
  assert.equal(parsePace(r, parseEncounter(r, 6500)!, 6500)[0].damage, 0);
});
test("percentile uses rank thresholds, rejects corrupt curves and handles ties", () => {
  const c = [
    { dps: 100, percentile: 0 },
    { dps: 1000, percentile: 90 },
    { dps: 1200, percentile: 95 },
    { dps: 1500, percentile: 100 },
  ];
  assert.equal(percentileAt(1100, c), 92.5);
  assert.equal(percentileAt(0, c), 0);
  assert.equal(percentileAt(1600, c), 100);
  assert.equal(percentileAt(NaN, c), null);
  assert.equal(percentileAt(1000, []), null);
  assert.equal(
    percentileAt(1000, [
      { dps: 10, percentile: 95 },
      { dps: 20, percentile: 90 },
    ]),
    null,
  );
  assert.equal(
    percentileAt(100, [
      { dps: 100, percentile: 50 },
      { dps: 100, percentile: 60 },
      { dps: 200, percentile: 100 },
    ]),
    60,
  );
});
test("WCL controls default to report choices; only Today Rankings predicts", () => {
  assert.deepEqual(defaultParseOptions, {
    compare: "Parses",
    timeframe: "Today",
    bracket: "overall",
  });
  for (const compare of ["Parses", "Rankings"] as const)
    for (const timeframe of ["Historical", "Today"] as const) {
      assert.equal(
        predictionSupported({ compare, timeframe, bracket: "overall" }),
        compare === "Rankings" && timeframe === "Today",
      );
    }
});
test("global WCL character IDs are not report IDs; ambiguous names are rejected", () => {
  const r = parseFixture();
  const data = {
    references: [
      {
        player: { name: "Mage", className: "Mage", server: "Realm" },
        curve: [],
        note: null,
      },
    ],
  } as unknown as ParseData;
  assert.equal(referenceFor(r, "1:1", data), data.references[0]);
  r.actors.push({ ...r.actors[0], key: "99:1", id: 99 });
  assert.equal(referenceFor(r, "1:1", data), null);
});

test("live WCL compact actor realm matches the ranking display realm", () => {
  const r = parseFixture();
  (r.raw.actors[0] as any).server = "LivingFlame";
  const data = {
    references: [
      {
        player: { name: "Mage", className: "Mage", server: "Living Flame" },
        curve: [],
        note: null,
      },
    ],
  } as unknown as ParseData;
  assert.equal(referenceFor(r, "1:1", data), data.references[0]);
  (r.raw.actors[0] as any).server = "DifferentRealm";
  assert.equal(referenceFor(r, "1:1", data), null);
});
