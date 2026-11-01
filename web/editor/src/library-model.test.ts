import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeRun,
  isSavedRun,
  viewedProjects,
  relativeDate,
} from "./library-model";
import { newProject, replaySource, validateProject } from "./project-store";
import { emptyPlan } from "./domain";
import type { RawReplay } from "./types";
const raw = (kills = 8): RawReplay => ({
  gameVersion: "vanilla",
  report: { code: "bZX7VqdwpcmyrGzN", title: "BWL" },
  fight: {
    id: "run",
    name: "Full run",
    startTime: 100,
    endTime: 2000,
    gameZone: { name: "Blackwing Lair" },
    friendlyPlayers: [],
    chapters: [
      ...Array.from({ length: kills }, (_, i) => ({
        id: i + 1,
        encounterID: i + 1,
        kill: true,
        startTime: 100 + i * 100,
        endTime: 200 + i * 100,
      })),
      { id: 20, encounterID: 1, kill: true, endTime: 1500 },
      { id: 21, encounterID: 9, kill: false, endTime: 1800 },
    ],
  } as RawReplay["fight"],
  actors: [],
  events: [],
});
test("run summaries count distinct kills, exclude wipes and stop clear time at final boss", () => {
  const s = summarizeRun(raw(), 469);
  assert.equal(s.bossesKilled, 8);
  assert.equal(s.bossCount, 8);
  assert.equal(s.clearTime, 800);
  assert.equal(s.elapsed, 1900);
  assert.equal(summarizeRun(raw(6), 469).clearTime, null);
});
test("an encounter is never presented as a full raid clear", () => {
  const r = raw();
  r.fight = { ...r.fight, id: 1 };
  assert.equal(summarizeRun(r, 469).clearTime, null);
});
test("legacy saved replays remain saved; viewed dates do not fall back to autosave", () => {
  const p = {
    ...newProject(emptyPlan(469, "vanilla")),
    kind: "replay" as const,
  };
  assert(isSavedRun(p));
  assert(!isSavedRun({ ...p, savedRun: false }));
  assert.equal(relativeDate(undefined), "Not recorded");
  assert.equal(
    viewedProjects([
      { ...p, id: "a", updatedAt: 999999, lastViewedAt: 1 },
      { ...p, id: "b", lastViewedAt: 2 },
    ])[0].id,
    "b",
  );
});
test("metadata roundtrips with schema 1 and malformed additions are rejected", () => {
  const p = {
    ...newProject(emptyPlan(469, "vanilla"), replaySource(raw(), 469)),
    pinned: true,
    savedRun: false,
    lastViewedAt: 123,
  };
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))), p);
  for (const values of [
    { pinned: "yes" },
    { savedRun: 1 },
    { lastViewedAt: -1 },
    {
      source: {
        ...p.source,
        summary: { bossesKilled: 9, bossCount: 8, clearTime: 5, elapsed: 8 },
      },
    },
  ])
    assert.throws(() => validateProject({ ...p, ...values }));
});
