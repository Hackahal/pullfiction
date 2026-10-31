import test from "node:test";
import assert from "node:assert/strict";
import {
  indexSpeedrun,
  speedrunAt,
  coveredThrough,
  timerTime,
} from "./speedrun-model";
import { SPEEDRUN_RULES, speedrunRules } from "./speedrun-rules";
import { RAIDS } from "./domain";
import type { RawReplay } from "./types";

import { fixture } from "./speedrun-test-fixture";

test("Every supported raid/version has explicit coverage and primary-source provenance", () => {
  for (const version of ["vanilla", "sod"] as const)
    for (const raid of RAIDS.filter(
      (r) => !r.rulesets || r.rulesets.includes(version),
    )) {
      const rules = speedrunRules(version, raid.map);
      assert.ok(rules, `${version}/${raid.map}`);
      assert.match(rules.source, /^https:\/\/www.archon.gg\//);
      if (rules.coverage === "published") assert.ok(rules.requirements.length);
    }
  assert.equal(
    new Set(SPEEDRUN_RULES.map((r) => `${r.version}/${r.map}`)).size,
    SPEEDRUN_RULES.length,
  );
  assert.equal(speedrunRules("vanilla", 409)!.coverage, "unverified");
  assert.equal(
    speedrunRules("vanilla", 533)!.requirements.find((r) =>
      r.ids.includes(15977),
    )!.count,
    81,
  );
  assert.equal(
    speedrunRules("sod", 533)!.requirements.find((r) => r.ids.includes(15977))!
      .count,
    91,
  );
});
test("Clock follows the start, pauses at final boss, and rewinds with cursor", () => {
  const index = indexSpeedrun(fixture());
  assert.equal(index.start, 1000);
  assert.equal(speedrunAt(index, 500).elapsed, 0);
  assert.equal(speedrunAt(index, 1000).elapsed, 0);
  assert.equal(speedrunAt(index, 10000).elapsed, 9000);
  assert.equal(speedrunAt(index, 20000).elapsed, 14000);
  assert.equal(speedrunAt(index, 5000).elapsed, 4000);
  assert.equal(speedrunAt(index, 20000).allBosses, false);
  assert.equal(
    speedrunAt(index, 20000).splits.filter((s) => s.completed).length,
    3,
  );
  assert.equal(
    speedrunAt(index, 1000).splits.filter((s) => s.completed).length,
    0,
  );
});
test("Death instances count once, OR groups combine, cutoff includes final timestamp but excludes later deaths", () => {
  const index = indexSpeedrun(fixture());
  assert.equal(speedrunAt(index, 4999).requirements[0].count, 0);
  assert.equal(speedrunAt(index, 5000).requirements[0].count, 1);
  assert.equal(speedrunAt(index, 6000).requirements[0].count, 2);
  assert.equal(speedrunAt(index, 20000).requirements[0].count, 3);
  assert.equal(speedrunAt(index, 5000).requirements[0].count, 1);
  assert.equal(speedrunAt(index, 20000).requirements[0].penalty, 75000);
  assert.equal(
    speedrunAt(index, 20000).requirements.find((r) => r.required === 68)!
      .penalty,
    1200000,
  );
});
test("Missing anchor never invents a start; incomplete streaming never presents a final penalty", () => {
  const replay = fixture(469);
  assert.equal(indexSpeedrun(replay).start, null);
  assert.equal(speedrunAt(indexSpeedrun(replay), 10000).started, false);
  const bfd = fixture();
  bfd.raw.stream = {
    full: [
      [0, 5000],
      [6000, 20000],
    ],
    revision: 1,
  } as RawReplay["stream"];
  assert.equal(coveredThrough(bfd, 1000, 4999), true);
  assert.equal(coveredThrough(bfd, 1000, 5000), false);
  assert.equal(speedrunAt(indexSpeedrun(bfd), 20000).finalPenalty, false);
  bfd.raw.stream!.full = [
    [0, 5000],
    [5000, 20000],
  ];
  assert.equal(speedrunAt(indexSpeedrun(bfd), 20000).finalPenalty, true);
});
test("Single-fight preview cannot evaluate a complete run", () => {
  const replay = fixture();
  replay.fight.completeRaid = false;
  assert.equal(speedrunAt(indexSpeedrun(replay), 20000).fullRun, false);
  assert.equal(speedrunAt(indexSpeedrun(replay), 20000).finalPenalty, false);
});
test("Heat 3 waits for The Molten Core instead of stopping at Ragnaros", () => {
  const replay = fixture(409);
  replay.raw.actors = [{ id: 2, type: "NPC", name: "Molten Giant" }];
  replay.chapters = [
    {
      id: 1,
      name: "Ragnaros",
      encounterID: 1,
      start: 5000,
      end: 10000,
      kill: true,
    },
    {
      id: 2,
      name: "The Molten Core",
      encounterID: 2,
      start: 12000,
      end: 15000,
      kill: true,
    },
  ];
  assert.equal(indexSpeedrun(replay, { heat: 1 }).finish, 10000);
  assert.equal(indexSpeedrun(replay, { heat: 3 }).finish, 15000);
  assert.equal(
    speedrunAt(indexSpeedrun(replay, { heat: 3 }), 11000).finished,
    false,
  );
});
test("Scarlet lieutenants count distinct creature types", () => {
  const replay = fixture(2856);
  replay.chapters[0].name = "Balnazzar";
  replay.chapters[3].name = "Caldoran";
  replay.actors.forEach((a) => {
    if (a.type === "NPC") a.gameID = 242224;
  });
  let index = indexSpeedrun(replay);
  assert.equal(speedrunAt(index, 20000).requirements[0].count, 1);
  replay.actors.find((a) => a.id === 3)!.gameID = 242296;
  index = indexSpeedrun(replay);
  assert.equal(speedrunAt(index, 20000).requirements[0].count, 2);
});
test("Razuvious penalty uses deaths strictly before kill, independently of final captain count", () => {
  const replay = fixture(533);
  replay.raw.actors = [{ id: 2, type: "NPC", name: "Deathknight Captain" }];
  replay.chapters = [
    {
      id: 1,
      name: "Instructor Razuvious",
      encounterID: 1,
      start: 2000,
      end: 8000,
      kill: true,
    },
    {
      id: 2,
      name: "Kel'Thuzad",
      encounterID: 2,
      start: 10000,
      end: 15000,
      kill: true,
    },
  ];
  const example = replay.actors.find((a) => a.type === "NPC")!;
  replay.actors = Array.from({ length: 14 }, (_, i) => ({
    ...example,
    key: `captain-${i}`,
    gameID: 16145,
    deaths: [[i < 11 ? 7000 : 8000, true]] as [number, boolean][],
  }));
  let run = speedrunAt(indexSpeedrun(replay), 15000);
  assert.equal(run.requirements.find((r) => r.ids.includes(16145))!.count, 14);
  assert.equal(run.captainPenalty, 300000);
  assert.equal(speedrunAt(indexSpeedrun(replay), 7999).captainPenalty, 0);
  replay.actors[11].deaths = [[7999, true]];
  run = speedrunAt(indexSpeedrun(replay), 15000);
  assert.equal(run.captainPenalty, 0);
});
test("Timer uses centiseconds and supports hour-long runs", () => {
  assert.equal(timerTime(-1), "0:00.00");
  assert.equal(timerTime(3723456), "62:03.45");
});

test("A later matching anchor cannot hide a missing initial stream chunk", () => {
  const replay = fixture(469);
  replay.raw.actors = [{ id: 2, type: "NPC", name: "Grethok the Controller" }];
  replay.raw.events = [
    { type: "damage", timestamp: 11000, sourceID: 1, targetID: 2 },
  ];
  replay.raw.stream = {
    full: [[10000, 20000]],
    revision: 1,
  } as RawReplay["stream"];
  const index = indexSpeedrun(replay);
  assert.equal(index.start, 10000);
  assert.equal(speedrunAt(index, 15000).coverage, false);
  replay.raw.stream!.full = [[0, 20000]];
  assert.equal(speedrunAt(indexSpeedrun(replay), 15000).coverage, true);
});

test("Streaming counts include chunk-boundary deaths through the actual controller loader", async () => {
  const { ReplayBuffer } = await import("./replay-buffer");
  const { EditorController } = await import("./controller");
  const { analysisDataIdentity, requestAnalysisChunk } =
    await import("./analysis-data");
  const raw = fixture().raw;
  raw.fight.startTime = 0;
  raw.fight.endTime = 180000;
  (raw.fight as any).chapters[3].startTime = 140000;
  (raw.fight as any).chapters[3].endTime = 160000;
  const events = [
    { timestamp: 2000, type: "damage", sourceID: 1, targetID: 2, amount: 1 },
    { timestamp: 60000, type: "death", targetID: 2, targetInstance: 1 },
    { timestamp: 120000, type: "death", targetID: 3, targetInstance: 1 },
  ];
  raw.events = [];
  raw.stream = {
    version: 1,
    id: "speedrun-test",
    revision: 1,
    segments: 1,
    reportEnd: 180000,
    full: [],
    history: [],
    stateEvents: [],
    contextEvents: [],
    foreign: [],
  };
  const buffer = new ReplayBuffer(
    raw,
    async (start, end) =>
      events.filter((e) => e.timestamp >= start && e.timestamp <= end),
    async () => {},
  );
  const controller = new EditorController(undefined, {
    browserAssets: false,
    projectStore: null,
  });
  try {
    await buffer.ensure(0);
    controller.installReplay(buffer.snapshot(), undefined, buffer);
    const source = analysisDataIdentity(controller.getSnapshot().replay);
    const run = (t: number) =>
      speedrunAt(indexSpeedrun(controller.getSnapshot().replay!), t);
    assert.equal(run(60000).coverage, false);
    assert.equal(
      await requestAnalysisChunk(controller, source, [[0, 60000]]),
      true,
    );
    assert.equal(run(60000).coverage, true);
    assert.equal(run(60000).requirements[0].count, 1);
    assert.equal(run(120000).coverage, false);
    assert.equal(
      await requestAnalysisChunk(controller, source, [[0, 120000]]),
      true,
    );
    assert.equal(run(120000).coverage, true);
    assert.equal(run(120000).requirements[0].count, 2);
    assert.equal(run(59999).requirements[0].count, 0);
  } finally {
    controller.stop();
    buffer.close();
  }
});

test("Trash starts use WCL pull metadata before the first damaging event", () => {
  const replay = fixture(469);
  replay.raw.actors = [{ id: 2, type: "NPC", name: "Grethok the Controller" }];
  replay.chapters.unshift({
    id: 0,
    name: "Trash",
    start: 200,
    end: 1500,
    enemyNPCs: [{ id: 2 }],
  });
  const index = indexSpeedrun(replay);
  assert.equal(index.start, 200);
  assert.equal(index.estimated, false);
  replay.chapters.shift();
  assert.equal(indexSpeedrun(replay).start, 1000);
  assert.equal(indexSpeedrun(replay).estimated, true);
});
