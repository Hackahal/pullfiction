import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSpeedWorldRecord,
  defaultSpeedSelection,
} from "./speedrun-world-record";
import {
  praxisCategory,
  praxisWinner,
  praxisReport,
} from "./speedrun-wr-live-fixture";
const selection = defaultSpeedSelection(praxisCategory);
const load = (report: any = praxisReport, winner: any = praxisWinner) =>
  fetchSpeedWorldRecord(
    async (q) =>
      q.includes("fightRankings")
        ? {
            worldData: { encounter: { fightRankings: { rankings: [winner] } } },
          }
        : report,
    "sod",
    533,
    praxisCategory,
    selection,
  );

test("actual Naxx WR resolves synthetic10000 through ranked start and recorded terminal kill", async () => {
  const wr = await load();
  assert.equal(wr?.duration, 3311720);
  assert.equal(wr?.splitNote, null);
  assert.equal(wr?.splits.length, 14);
  assert.equal(wr?.splits.find((f) => f.encounterID === 201118)?.end, 1613851);
  assert.equal(wr?.splits.find((f) => f.encounterID === 201111)?.end, 1732867);
  assert.equal(wr?.splits.find((f) => f.encounterID === 201108)?.end, 1823632);
  assert.equal(wr?.splits.at(-1)?.end, 3311720);
  assert.equal(wr?.splits[0].start, 308063);
});
test("penalty-adjusted duration never invents terminal timestamp or shifts boss splits", async () => {
  const wr = await load(praxisReport, { ...praxisWinner, duration: 3371720 });
  assert.equal(wr?.duration, 3371720);
  assert.equal(wr?.splits.at(-1)?.end, 3311720);
});
test("missing, ambiguous or mismatched run evidence retains total-only fallback", async () => {
  const altered: [any, any][] = [
    [
      {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          f.id === 3 ? { ...f, difficulty: 3 } : f,
        ),
      },
      praxisWinner,
    ],
    [
      {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          f.id === 3 ? { ...f, size: 40 } : f,
        ),
      },
      praxisWinner,
    ],
    [{ ...praxisReport, code: "ABcdEFghIJklMNop" }, praxisWinner],
    [{ ...praxisReport, startTime: 1744045710684 }, praxisWinner],
    [praxisReport, { ...praxisWinner, startTime: undefined }],
    [praxisReport, { ...praxisWinner, startTime: praxisWinner.startTime + 1 }],
    [
      { ...praxisReport, fights: praxisReport.fights.slice(0, -1) },
      praxisWinner,
    ],
    [
      {
        ...praxisReport,
        fights: [
          ...praxisReport.fights,
          {
            ...praxisReport.fights.at(-1)!,
            id: 32,
            startTime: 9500000,
            endTime: 9600000,
          },
        ],
      },
      praxisWinner,
    ],
    [
      {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          f.id === 31
            ? { ...f, gameZone: { id: 469, name: "Blackwing Lair" } }
            : f,
        ),
      },
      praxisWinner,
    ],
    [
      {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          f.id === 31 ? { ...f, difficulty: 3 } : f,
        ),
      },
      praxisWinner,
    ],
    [
      {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          f.id === 31 ? { ...f, size: 40 } : f,
        ),
      },
      praxisWinner,
    ],
  ];
  for (const [report, winner] of altered) {
    const wr = await load(report, winner);
    assert.equal(wr?.duration, 3311720);
    assert.deepEqual(wr?.splits, []);
    assert.match(wr?.splitNote ?? "", /exact start\/end/);
  }
});
test("an earlier completed raid in same report is excluded by actual ranked start", async () => {
  const wr = await load({
    ...praxisReport,
    fights: [
      {
        ...praxisReport.fights.at(-1)!,
        id: 0,
        startTime: 100000,
        endTime: 200000,
      },
      ...praxisReport.fights,
    ],
  });
  assert.equal(wr?.splits.length, 14);
  assert.equal(wr?.splits[0].id, 3);
});

test("Patchwerk-first route shows same-boss WR deltas and projection without route gates", async () => {
  const { patchwerkFirstReplay } = await import("./speedrun-wr-live-fixture");
  const { indexSpeedrun, speedrunAt } = await import("./speedrun-model");
  const { compareSpeedrun } = await import("./speedrun-comparison");
  const wr = await load();
  const index = indexSpeedrun(patchwerkFirstReplay());
  const run = speedrunAt(index, 600000);
  assert.equal(index.estimated, false);
  const comparison = compareSpeedrun(index, run, wr);
  assert.equal(comparison.routeMatches, false);
  assert.equal(comparison.rows[0].delta, 289300 - 1613851);
  assert.equal(comparison.rows[1].delta, 446300 - 1732867);
  assert.equal(comparison.rows[2].delta, 545700 - 1823632);
  assert.equal(comparison.delta, 545700 - 1823632);
  assert.equal(
    comparison.previousSegment,
    545700 - 446300 - (1823632 - 1732867),
  );
  assert.equal(comparison.projected, 3311720 + 545700 - 1823632);
  for (const change of ["category", "coverage", "start"]) {
    const replay = patchwerkFirstReplay();
    if (change === "category") replay.fight.categoryMixed = true;
    if (change === "coverage")
      replay.raw.stream = { full: [], revision: 1 } as any;
    if (change === "start")
      (replay.raw.actors as { id: number; name: string }[]).find(
        (a) => a.id === 2,
      )!.name = "Unknown NPC";
    const next = indexSpeedrun(replay);
    const guarded = compareSpeedrun(next, speedrunAt(next, 600000), wr);
    assert.equal(guarded.delta, null, change);
    assert.equal(guarded.projected, null, change);
    assert.ok(
      guarded.rows.every((r) => r.delta === null),
      change,
    );
  }
});

test("same-boss comparison supports positive deltas and unknown previous targets stay unknown", async () => {
  const { patchwerkFirstReplay } = await import("./speedrun-wr-live-fixture");
  const { indexSpeedrun, speedrunAt } = await import("./speedrun-model");
  const { compareSpeedrun } = await import("./speedrun-comparison");
  const wr = (await load())!;
  const replay = patchwerkFirstReplay();
  const index = indexSpeedrun(replay);
  const run = speedrunAt(index, 600000);
  const fasterReference = {
    ...wr,
    splits: wr.splits.map((s) =>
      s.encounterID === 201108 ? { ...s, end: 400000 } : s,
    ),
  };
  assert.equal(compareSpeedrun(index, run, fasterReference).delta, 145700);
  const missingPrevious = {
    ...wr,
    splits: wr.splits.filter((s) => s.encounterID !== 201111),
  };
  const result = compareSpeedrun(index, run, missingPrevious);
  assert.equal(result.delta, 545700 - 1823632);
  assert.equal(result.previousSegment, null);
  assert.equal(result.rows[1].delta, null);
});

test("nullable category metadata on terminal and intermediate kills remains unknown", async () => {
  for (const ids of [[31], [3], [3, 31]]) {
    for (const field of ["difficulty", "size", "both"]) {
      const report = {
        ...praxisReport,
        fights: praxisReport.fights.map((f) =>
          ids.includes(f.id)
            ? {
                ...f,
                ...(field !== "size" ? { difficulty: null } : {}),
                ...(field !== "difficulty" ? { size: null } : {}),
              }
            : f,
        ),
      };
      const wr = await load(report);
      assert.equal(wr?.splitNote, null, `${ids}:${field}`);
      assert.equal(wr?.splits.length, 14, `${ids}:${field}`);
      assert.equal(
        wr?.splits.find((s) => s.encounterID === 201118)?.end,
        1613851,
      );
    }
  }
  // An unrelated null value must not hide a known conflict in another field.
  for (const conflict of [
    { difficulty: null, size: 40 },
    { difficulty: 3, size: null },
  ]) {
    const wr = await load({
      ...praxisReport,
      fights: praxisReport.fights.map((f) =>
        f.id === 3 ? { ...f, ...conflict } : f,
      ),
    });
    assert.deepEqual(wr?.splits, []);
    assert.match(wr?.splitNote ?? "", /exact start\/end/);
  }
});
