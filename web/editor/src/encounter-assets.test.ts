import test from "node:test";
import assert from "node:assert/strict";
import { encounterAssets, EncounterAssetWarmer } from "./encounter-assets";
import type { Replay } from "./types";
const replay = {
  map: 1,
  duration: 300,
  fight: { friendlyPlayers: [1] },
  actors: [
    { id: 1, key: "1:1" },
    { id: 2, key: "2:1" },
    { id: 3, key: "3:1" },
  ],
  chapters: [
    { start: 0, end: 90, enemyNPCs: [{ id: 2 }] },
    { start: 100, end: 190, enemyNPCs: [{ id: 3 }] },
    { start: 200, end: 300 },
  ],
  combat: [
    { t: 90, source: "1:1", target: "2:1", spell: 11 },
    { t: 100, source: "1:1", target: "3:1", spell: 12 },
    { t: 200, source: "1:1", spell: 13 },
  ],
} as unknown as Replay;
test("encounter preparation selects inclusive boundaries and at most one adjacent encounter", () => {
  assert.deepEqual(encounterAssets(replay, 90).spells, [11]);
  const current = encounterAssets(replay, 150);
  assert.deepEqual(current.spells, [12]);
  assert.deepEqual(
    current.actors.map((a) => a.id),
    [1, 3],
  );
  assert.deepEqual(encounterAssets(replay, 150, 1).spells, [11, 12, 13]);
  assert.throws(() => encounterAssets(replay, 150, 2), /window/);
  assert.throws(() => encounterAssets(replay, NaN), /window/);
});
test("preparation limits retained selections independently of replay duration", () => {
  const large = {
    ...replay,
    chapters: [],
    actors: [],
    combat: [],
  } as unknown as Replay;
  for (let i = 1; i <= 1000; i++) {
    large.actors.push({ id: i, key: `${i}:1` } as any);
    large.combat.push({ t: 0, source: `${i}:1`, spell: i } as any);
  }
  const selection = encounterAssets(large, 0);
  assert.equal(selection.actors.length, 512);
  assert.equal(selection.spells.length, 256);
  assert.equal(selection.omittedActors, 488);
  assert.equal(selection.omittedSpells, 744);
});
test("seek replacement aborts preparation and prevents late spell preparation", async () => {
  const warmer = new EncounterAssetWarmer();
  let started!: () => void;
  const start = new Promise<void>((resolve) => (started = resolve));
  const calls: string[] = [];
  const old = warmer.prepare(replay, 0, {
    geometry: async () => {},
    units: (_actors, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    spells: async () => {
      calls.push("old");
    },
  });
  await start;
  const next = warmer.prepare(replay, 150, {
    geometry: async () => {},
    units: async () => {},
    spells: async (ids) => {
      calls.push(ids.join(","));
    },
  });
  await assert.rejects(old, { name: "AbortError" });
  await next;
  assert.deepEqual(calls, ["12"]);
  warmer.close();
  await assert.rejects(
    warmer.prepare(replay, 0, {
      geometry: async () => {},
      units: async () => {},
      spells: async () => {},
    }),
    /closed/,
  );
});
test("report replacement cannot continue after an uncancellable callback returns late", async () => {
  const warmer = new EncounterAssetWarmer();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let units = 0;
  const pending = warmer.prepare(replay, 0, {
    geometry: () => ready,
    units: async () => {
      units++;
    },
    spells: async () => {},
  });
  warmer.close();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(units, 0);
});
