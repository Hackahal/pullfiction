import test from "node:test";
import assert from "node:assert/strict";
import {
  ReplayBuffer,
  IndexedReplayPartCache,
  normalizationEvents,
  covered,
  missing,
  streamComplete,
  analysisAvailable,
  analysisIntervalsAvailable,
  analysisLoadRange,
  type ReplayPart,
  type ReplayPartCache,
} from "./replay-buffer";
import { normalizeReplay, enrichCombat, combatStateAt, poseAt } from "./domain";
import { runSegments } from "./run-timeline-model";
import type { RawReplay } from "./types";
import { EditorController } from "./controller";
import { createElement } from "react";
import { analysisDataIdentity, requestAnalysisChunk } from "./analysis-data";
import { renderToString } from "react-dom/server";
test("Metric coverage skips excluded downtime but includes the cutoff event's chunk", () => {
  const r = {
    duration: 100,
    raw: {
      stream: {
        full: [
          [0, 20],
          [80, 100],
        ],
      },
    },
  } as any;
  assert.equal(
    analysisIntervalsAvailable(r, 0, 100, [
      [0, 19],
      [80, 100],
    ]),
    true,
  );
  assert.equal(analysisIntervalsAvailable(r, 0, 100), false);
  assert.equal(
    analysisIntervalsAvailable(r, 0, 100, [
      [0, 20],
      [80, 100],
    ]),
    false,
  );
  assert.equal(analysisIntervalsAvailable(r, 0, 0), true);
  assert.equal(analysisIntervalsAvailable(r, 0, 100, []), true);
});
import { RunTimeline } from "./RunTimeline";
import { DamageGraph } from "./DamageGraph";
import { Analysis } from "./Analysis";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  newProject,
  replaySource,
  encodeProjectBackup,
  parseProjectBackup,
} from "./project-store";
import { emptyPlan } from "./domain";

const stateType = (e: any) =>
  /^(combatantinfo|begincast|cast|interrupt|summon|death|resurrect|(?:apply|remove|refresh)(?:buff|debuff)(?:stack)?)$/.test(
    e.type,
  );
const events: any[] = [
  {
    timestamp: 0,
    type: "combatantinfo",
    sourceID: 1,
    auras: [{ ability: 100 }],
  },
  {
    timestamp: 10000,
    type: "applybuff",
    sourceID: 1,
    targetID: 1,
    abilityGameID: 101,
  },
  { timestamp: 20000, type: "damage", sourceID: 1, targetID: 2, amount: 5 },
  { timestamp: 20000, type: "damage", sourceID: 1, targetID: 2, amount: 5 },
  {
    timestamp: 60000,
    type: "cast",
    sourceID: 1,
    targetID: 2,
    abilityGameID: 200,
  },
  {
    timestamp: 90000,
    type: "removebuff",
    sourceID: 1,
    targetID: 1,
    abilityGameID: 100,
  },
  { timestamp: 120000, type: "damage", sourceID: 1, targetID: 2, amount: 10 },
  {
    timestamp: 178000,
    type: "begincast",
    sourceID: 1,
    targetID: 2,
    abilityGameID: 200,
  },
  {
    timestamp: 180000,
    type: "damage",
    sourceID: 1,
    targetID: 2,
    amount: 15,
    sourceResources: { x: 100, y: 200, hitPoints: 70, maxHitPoints: 100 },
  },
  {
    timestamp: 181000,
    type: "cast",
    sourceID: 1,
    targetID: 2,
    abilityGameID: 200,
  },
  { timestamp: 200000, type: "death", targetID: 2 },
  { timestamp: 240000, type: "damage", sourceID: 1, targetID: 2, amount: 1 },
];
export function bufferFixture(): RawReplay {
  return {
    gameVersion: "vanilla",
    report: { code: "97KPaWhAQLrDvqtB", title: "Buffered fixture" },
    fight: {
      id: "run",
      name: "Full MC run",
      gameZone: { name: "Molten Core" },
      startTime: 0,
      endTime: 240000,
      friendlyPlayers: [1],
      chapters: [
        {
          id: 1,
          name: "Lucifron",
          encounterID: 1,
          startTime: 0,
          endTime: 60000,
          enemyNPCs: [{ id: 2, instanceCount: 1 }],
        },
        {
          id: 2,
          name: "Magmadar",
          encounterID: 2,
          startTime: 180000,
          endTime: 240000,
          enemyNPCs: [{ id: 2, instanceCount: 1 }],
        },
      ],
    } as any,
    actors: [
      { id: 1, name: "Mage", type: "Player", subType: "Mage" },
      { id: 2, name: "Magmadar", type: "NPC", subType: "Boss", gameID: 11982 },
    ],
    abilities: [{ gameID: 200, name: "Fireball" }],
    events: [],
    stream: {
      version: 1,
      id: "snapshot-1",
      revision: 1,
      segments: 1,
      reportEnd: 240000,
      full: [],
      history: [],
      stateEvents: [],
      contextEvents: [],
      foreign: [],
    },
  };
}
function fixture(cache?: ReplayPartCache) {
  const calls: any[] = [];
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start, end, state) => {
      calls.push({ start, end, state });
      return events.filter(
        (e) =>
          e.timestamp >= start &&
          e.timestamp <= end &&
          (!state || stateType(e)),
      );
    },
    async () => {},
    cache,
  );
  return { buffer, calls };
}
test("Metric range loading fetches an inclusive internal cutoff and the final endpoint", async () => {
  const { buffer } = fixture();
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  let r = c.getSnapshot().replay!;
  assert.equal(analysisIntervalsAvailable(r, 0, 60000), false);
  await c.loadReplayRange(...analysisLoadRange(r, 0, 60000));
  r = c.getSnapshot().replay!;
  assert.equal(analysisIntervalsAvailable(r, 0, 60000), true);
  assert.equal(buffer.ready(60000), true);
  await c.loadReplayRange(...analysisLoadRange(r, r.duration, r.duration));
  assert.equal(buffer.ready(r.duration), true);
  c.stop();
  buffer.close();
});
test("Automatic analysis loading is bounded, coalesces requests and reuses cached sections", async () => {
  const { buffer, calls } = fixture();
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  const source = analysisDataIdentity(c.getSnapshot().replay);
  const first = requestAnalysisChunk(c, source, [[60000, 180000]]);
  const concurrent = requestAnalysisChunk(c, source, [[180000, 200000]]);
  assert.deepEqual(await Promise.all([first, concurrent]), [true, false]);
  assert.equal(buffer.ready(60000), true);
  assert.equal(buffer.ready(120000), false);
  // A changed view requests its new section, not the rest of the old range.
  await requestAnalysisChunk(c, source, [[180000, 200000]]);
  assert.equal(buffer.ready(180000), true);
  assert.equal(buffer.ready(120000), false);
  const count = calls.length;
  assert.equal(
    await requestAnalysisChunk(c, source, [[180000, 200000]]),
    false,
  );
  assert.equal(await requestAnalysisChunk(c, source, []), false);
  assert.equal(
    await requestAnalysisChunk(c, source + "other", [[120000, 150000]]),
    false,
  );
  assert.equal(calls.length, count);
  c.stop();
  buffer.close();
});
test("A failed background range keeps cached playback moving and retry resumes loading", async () => {
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start, end, state) => {
      if (start >= 115000 && !state)
        throw new Error("Unavailable future section");
      return events.filter(
        (e) =>
          e.timestamp >= start &&
          e.timestamp <= end &&
          (!state || stateType(e)),
      );
    },
    async () => {},
  );
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  await c.loadReplayRange(180000, 240000);
  assert.match(c.getSnapshot().bufferError!, /Unavailable/);
  c.toggle();
  c.advance(1000);
  c.render();
  assert.equal(c.getSnapshot().time, 1000);
  assert.equal(c.getSnapshot().playing, true);
  c.retryReplaySection();
  await settled(c);
  assert.equal(c.getSnapshot().bufferError, null);
  c.stop();
});
test("first section starts without whole-run events; distant seek fetches target plus sparse history", async () => {
  const { buffer, calls } = fixture();
  await buffer.ensure(0);
  assert.deepEqual(calls, [{ start: 0, end: 65000, state: false }]);
  assert.equal(buffer.ready(1000), true);
  assert.equal(buffer.ready(180000), false);
  const overview = enrichCombat(normalizeReplay(buffer.snapshot(), {}), {}, {});
  assert.equal(overview.duration, 240000);
  assert.deepEqual(
    runSegments(overview).bosses.map((b) => [b.name, b.start, b.end]),
    [
      ["Lucifron", 0, 60000],
      ["Magmadar", 180000, 240000],
    ],
  );
  await buffer.ensure(180100);
  assert.deepEqual(calls.slice(1), [
    { start: 175000, end: 240000, state: false },
    { start: 60000, end: 180000, state: true },
  ]);
  const raw = buffer.snapshot();
  assert.equal(buffer.ready(180100), true);
  assert.equal(analysisAvailable(overview, 60000, 120000), false);
  assert.equal(
    raw.events.some((e: any) => e.timestamp === 120000),
    false,
  );
  const replay = enrichCombat(
    normalizeReplay({ ...raw, events: normalizationEvents(raw) }, {}),
    {},
    {},
  );
  const mage = replay.actors.find((a) => a.id === 1)!;
  assert.deepEqual(
    combatStateAt(mage, 180100).auras.map((a) => a.spell),
    [101],
  );
  assert.equal(combatStateAt(mage, 180100).cast?.spell, 200);
  assert.ok(
    replay.actors
      .find((a) => a.id === 2)!
      .deaths.some(([at, dead]) => at === 200000 && dead),
  );
  buffer.close();
});
test("complete buffering conserves identical legitimate events and exact boundary timestamps", async () => {
  const { buffer } = fixture();
  for (const t of [180100, 0, 60000, 120000]) await buffer.ensure(t);
  const raw = buffer.snapshot();
  assert.equal(streamComplete(raw), true);
  assert.deepEqual(raw.events, events);
  assert.deepEqual(normalizationEvents(raw), events);
  assert.equal(
    (raw.events as any[]).filter((e) => e.timestamp === 20000).length,
    2,
  );
});
test("cached chunks restore a distant seek without fetching; portable coverage does not duplicate cached parts", async () => {
  const parts = new Map<string, ReplayPart>();
  const cache = {
    list: async () => [...parts.values()],
    put: async (_: string, p: ReplayPart) => {
      parts.set(`${p.kind}:${p.start}:${p.end}`, structuredClone(p));
    },
  };
  const { buffer } = fixture(cache);
  await buffer.ensure(0);
  await buffer.ensure(180000);
  await buffer.flush();
  const manifest = bufferFixture();
  let fetched = 0;
  const restored = new ReplayBuffer(
    manifest,
    async () => {
      fetched++;
      throw new Error("offline");
    },
    async () => {
      throw new Error("offline");
    },
    cache,
  );
  await restored.restore();
  await restored.ensure(180000);
  assert.equal(fetched, 0);
  assert.deepEqual(restored.snapshot().events, buffer.snapshot().events);
  const backup = new ReplayBuffer(
    buffer.snapshot(),
    async () => [],
    async () => {},
    cache,
  );
  await backup.restore();
  assert.deepEqual(backup.snapshot().events, buffer.snapshot().events);
});
test("superseded requests cannot install late events and report revisions are checked before network resume", async () => {
  let resolve: any;
  const calls: number[] = [];
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start, end, state) => {
      calls.push(start);
      if (start === 0 && !state) await new Promise((r) => (resolve = r));
      return [];
    },
    async () => {},
  );
  const first = buffer.ensure(0);
  await new Promise((r) => setImmediate(r));
  const seek = buffer.ensure(180000);
  resolve();
  await assert.rejects(first, /abort/i);
  await seek;
  assert.deepEqual(buffer.snapshot().stream!.full, [[180000, 240000]]);
  let fetched = 0;
  const stale = new ReplayBuffer(
    bufferFixture(),
    async () => {
      fetched++;
      return [];
    },
    async () => {
      throw new Error("report changed");
    },
  );
  await assert.rejects(stale.ensure(0), /report changed/);
  assert.equal(fetched, 0);
  assert.equal(stale.ready(0), false);
});
test("failed caching does not mark failed network ranges ready or stop loaded playback", async () => {
  let errors = 0;
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start) => {
      if (start > 0) throw new Error("network");
      return events.filter((e) => e.timestamp <= 65000);
    },
    async () => {},
    {
      list: async () => [],
      put: async () => {
        throw new Error("quota");
      },
    },
    () => {},
    () => errors++,
  );
  await buffer.ensure(0);
  await buffer.flush();
  assert.equal(errors, 1);
  assert.equal(buffer.ready(0), true);
  await assert.rejects(buffer.ensure(180000), /network/);
  assert.equal(buffer.ready(180000), false);
  assert.equal(
    covered(
      [
        [0, 60000],
        [120000, 180000],
      ],
      0,
      180000,
    ),
    false,
  );
  assert.deepEqual(
    missing(
      [
        [0, 60000],
        [120000, 180000],
      ],
      0,
      240000,
    ),
    [
      [60000, 120000],
      [180000, 240000],
    ],
  );
});

async function settled(c: EditorController) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r));
    if (!c.getSnapshot().buffering && !(c as any).replayBuffer?.active) return;
  }
  throw new Error("Buffered controller did not settle");
}
test("buffer updates keep selected player, edits and requested time, and allow planning immediately after first load", async () => {
  const { buffer } = fixture();
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  assert.equal(c.getSnapshot().buffering, false);
  c.planFromMoment();
  assert.ok(c.getSnapshot().plan.steps.some((s) => s.snapshot));
  c.updateStep({ notes: "Keep this plan" });
  c.select("1:1");
  c.seek(180100);
  assert.equal(c.getSnapshot().time, 180100);
  await settled(c);
  assert.equal(c.getSnapshot().selected, "1:1");
  assert.equal(
    c.getSnapshot().plan.steps.find((s) => s.id === c.getSnapshot().activeStep)
      ?.notes,
    "Keep this plan",
  );
  assert.equal(c.getSnapshot().time, 180100);
  assert.equal(c.getSnapshot().bufferError, null);
  c.seek(0);
  await settled(c);
  assert.equal(c.getSnapshot().time, 0);
  c.stop();
});
test("complete encounter navigator and partial-data views remain honest before the rest downloads", async (t) => {
  const { buffer } = fixture();
  await buffer.ensure(0);
  await buffer.ensure(180100);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  const raw = buffer.snapshot(),
    replay = enrichCombat(
      normalizeReplay({ ...raw, events: normalizationEvents(raw) }, {}),
      {},
      {},
    );
  replay.raw = raw;
  c.installReplay(raw, { replay, models: {} }, buffer);
  const state = { ...c.getSnapshot(), replay, time: 180100 };
  const navigator = renderToString(
    createElement(RunTimeline, { state, controller: c }),
  );
  assert.match(navigator, /Lucifron/);
  assert.match(navigator, /Magmadar/);
  assert.match(navigator, /aria-valuemax="240000"/);
  assert.match(navigator, /run-buffered/);
  const chart = renderToString(
    createElement(DamageGraph, { state, controller: c, range: [0, 240000] }),
  );
  assert.match(chart, /downloaded total/);
  assert.match(chart, /Blank sections/);
  // The current pull is buffered; an unloaded earlier pull must not block it.
  assert.doesNotMatch(chart, /Loading totals for this range/);
  assert.match(chart, /Magmadar/);
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key.includes(".chart.") ? JSON.stringify({ window: "run" }) : null,
      setItem() {},
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const fullRunChart = renderToString(
    createElement(DamageGraph, { state, controller: c, range: [0, 240000] }),
  );
  assert.match(fullRunChart, /Loading totals for this range/);
  const analysis = renderToString(
    createElement(Analysis, {
      state: { ...state, time: 150000 },
      preset: { window: "full" },
      controller: c,
      close: () => {},
    }),
  );
  assert.match(analysis, /Loading this range/);
  assert.doesNotMatch(analysis, /0<!-- --> total/);
  c.stop();
  buffer.close();
});
test("interpolation and resource display do not bridge unloaded holes", () => {
  const actor = {
    samples: [
      [0, 0, 0, null],
      [100000, 10, 0, null],
    ],
    headings: [0, 0],
    facings: [],
    deaths: [],
    activity: [],
    activityWindows: [],
    type: "Player",
    bufferedRanges: [
      [0, 60000],
      [90000, 120000],
    ],
    health: [[0, { current: 10, max: 100, percent: 0.1 }]],
    power: [[0, { current: 10, max: 100, type: 0 }]],
  } as any;
  const pose = poseAt(actor, 95000, true)!;
  assert.deepEqual(pose.pos, [0, 0, null]);
  assert.equal(pose.estimated, false);
  assert.equal(pose.wisp, false);
  assert.equal(combatStateAt(actor, 95000).health, null);
  assert.equal(combatStateAt(actor, 95000).power, null);
});
test("revision changing during a request does not commit or cache mixed events", async () => {
  let checked = 0,
    written = 0;
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async () => events,
    async () => {
      if (++checked > 1) throw new Error("report changed");
    },
    {
      list: async () => [],
      put: async () => {
        written++;
      },
    },
  );
  await assert.rejects(buffer.ensure(0), /report changed/);
  assert.equal(buffer.ready(0), false);
  assert.equal(written, 0);
});

test("IndexedDB chunks survive a new cache connection and isolate immutable source snapshots", async () => {
  const factory = new IDBFactory(),
    cache = new IndexedReplayPartCache(factory, IDBKeyRange);
  const { buffer } = fixture(cache);
  await buffer.ensure(0);
  await buffer.ensure(180000);
  await buffer.flush();
  const reopened = new IndexedReplayPartCache(factory, IDBKeyRange);
  const parts = await reopened.list("snapshot-1");
  assert.equal(parts.length, 3);
  assert.deepEqual(await reopened.list("different-import"), []);
  const restored = new ReplayBuffer(
    bufferFixture(),
    async () => {
      throw new Error("offline");
    },
    async () => {
      throw new Error("offline");
    },
    reopened,
  );
  await restored.restore();
  await restored.ensure(180000);
  assert.deepEqual(restored.snapshot().events, buffer.snapshot().events);
});

test("scrubbing cached sections does not rebuild actor tracks or chart indexes", async () => {
  const { buffer } = fixture();
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  await settled(c);
  const replay = c.getSnapshot().replay;
  for (const t of [1000, 5000, 10000, 4000]) {
    c.seek(t);
    await settled(c);
    assert.equal(c.getSnapshot().replay, replay);
  }
  c.stop();
});

test("playback buffers at an unavailable boundary and resumes without skipping time", async () => {
  let release: () => void = () => {};
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start, end, state) => {
      if (start === 55000 && !state)
        await new Promise<void>((resolve) => (release = resolve));
      return events.filter(
        (e) =>
          e.timestamp >= start &&
          e.timestamp <= end &&
          (!state || stateType(e)),
      );
    },
    async () => {},
  );
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  await new Promise((r) => setImmediate(r));
  c.seek(59900);
  await new Promise((r) => setImmediate(r));
  c.toggle();
  c.advance(250);
  c.render();
  assert.equal(c.getSnapshot().buffering, true);
  assert.equal(c.getSnapshot().time, 59900);
  assert.equal(c.getSnapshot().playing, true);
  release();
  await settled(c);
  c.advance(250);
  c.render();
  assert.equal(c.getSnapshot().time, 60150);
  assert.equal(c.getSnapshot().playing, true);
  c.stop();
});
test("stopping a background download is not reported as a playback failure", async () => {
  let release: () => void = () => {};
  const buffer = new ReplayBuffer(
    bufferFixture(),
    async (start, end, state) => {
      if (start === 55000 && !state)
        await new Promise<void>((resolve) => (release = resolve));
      return events.filter(
        (e) =>
          e.timestamp >= start &&
          e.timestamp <= end &&
          (!state || stateType(e)),
      );
    },
    async () => {},
  );
  await buffer.ensure(0);
  const c = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  c.installReplay(buffer.snapshot(), undefined, buffer);
  await new Promise((r) => setImmediate(r));
  const download = c.downloadFullReplay();
  await new Promise((r) => setImmediate(r));
  c.cancelReplayDownload();
  release();
  await download;
  assert.equal(c.getSnapshot().downloadingReplay, false);
  assert.equal(c.getSnapshot().bufferError, null);
  c.stop();
});

test("portable partial backup preserves events and state without reusing another import's cache identity", async () => {
  const { buffer } = fixture();
  await buffer.ensure(0);
  await buffer.ensure(180000);
  const raw = buffer.snapshot(),
    project = newProject(emptyPlan(409, "vanilla"), replaySource(raw, 409));
  project.plan.steps[0].notes = "Retain these edits";
  const backup = encodeProjectBackup(project, raw),
    imported = parseProjectBackup(backup.text);
  assert.equal(imported.project.plan.steps[0].notes, "Retain these edits");
  assert.notEqual(imported.replay!.stream!.id, raw.stream!.id);
  assert.notEqual(imported.project.source!.cacheKey, project.source!.cacheKey);
  const restored = new ReplayBuffer(
    imported.replay!,
    async () => {
      throw new Error("offline");
    },
    async () => {
      throw new Error("offline");
    },
  );
  await restored.ensure(180000);
  assert.deepEqual(restored.snapshot().events, raw.events);
  assert.deepEqual(
    normalizationEvents(restored.snapshot()),
    normalizationEvents(raw),
  );
  assert.equal(streamComplete(restored.snapshot()), false);
});
