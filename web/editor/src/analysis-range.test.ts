import test from "node:test";
import assert from "node:assert/strict";
import { analysisRange, chartSummaryRange } from "./analysis-range";
import type { Replay } from "./types";

const replay = {
  duration: 60000,
  chapters: [
    { id: 1, name: "First pull", start: 5000, end: 15000 },
    { id: 2, name: "Second pull", start: 25000, end: 45000 },
  ],
} as Replay;
test("Current pull retains its completed duration and domain between pulls", () => {
  const live = analysisRange(replay, 10000, "encounter");
  assert.deepEqual(
    [live.start, live.end, live.displayEnd, live.seconds],
    [5000, 10000, 15000, 5],
  );
  const done = analysisRange(replay, 22000, "encounter");
  assert.deepEqual(
    [done.start, done.end, done.displayEnd, done.seconds, done.between],
    [5000, 15000, 15000, 10, true],
  );
  const next = analysisRange(replay, 30000, "encounter");
  assert.deepEqual(
    [next.start, next.end, next.seconds, next.between],
    [25000, 30000, 5, false],
  );
  assert.equal(analysisRange(replay, 10000, "encounter").chapter?.id, 1);
});

test("Subsecond pull duration stays exact, and an unstarted pull has no elapsed time", () => {
  assert.equal(analysisRange(replay, 5250, "encounter").seconds, 0.25);
  assert.equal(analysisRange(replay, 5000, "encounter").seconds, 0);
});
test("Chart summary uses the selected pull, viewport, brush or rolling range", () => {
  assert.equal(
    chartSummaryRange(replay, 12000, "encounter", [0, 60000]).seconds,
    7,
  );
  const viewport = chartSummaryRange(replay, 12000, "timeline", [10000, 20000]);
  assert.deepEqual(
    [viewport.start, viewport.end, viewport.seconds],
    [10000, 12000, 2],
  );
  const future = chartSummaryRange(replay, 1000, "timeline", [10000, 20000]);
  assert.equal(future.end, 1000);
  assert.equal(future.seconds, 0);
  const brush = chartSummaryRange(
    replay,
    30000,
    "encounter",
    [0, 60000],
    [10000, 20000],
  );
  assert.deepEqual([brush.start, brush.end, brush.seconds], [10000, 20000, 10]);
  assert.equal(chartSummaryRange(replay, 250, "10", [0, 60000]).seconds, 0.25);
  assert.equal(chartSummaryRange(replay, 20000, "run", [0, 60000]).seconds, 20);
});
test("Overall rates exclude downtime and merge overlapping combat intervals", () => {
  const r = analysisRange(replay, 30000, "elapsed");
  assert.deepEqual(r.intervals, [
    [5000, 15000],
    [25000, 30000],
  ]);
  assert.equal(r.seconds, 15);
  const overlapping = {
    ...replay,
    chapters: [
      ...replay.chapters,
      { id: 3, name: "Overlap", start: 10000, end: 35000 },
    ],
  };
  assert.equal(analysisRange(overlapping, 40000, "elapsed").seconds, 35);
  assert.deepEqual(analysisRange(replay, 1000, "elapsed").intervals, []);
});
test("A selected pull is a fixed completed segment independent of the playhead", () => {
  const r = analysisRange(replay, 0, "encounter", "2");
  assert.deepEqual(
    [r.start, r.end, r.displayEnd, r.seconds, r.label],
    [25000, 45000, 45000, 20, "Second pull"],
  );
  assert.equal(analysisRange(replay, 30000, "full").end, 60000);
});
test("Empty, zero duration and before-first-pull ranges remain finite", () => {
  for (const r of [
    analysisRange(null, 0, "encounter"),
    analysisRange(replay, -10, "encounter"),
    analysisRange(replay, 25000, "encounter"),
  ]) {
    assert.ok(Number.isFinite(r.seconds) && r.seconds >= 0);
    assert.ok(r.end >= r.start || r.seconds === 0);
  }
  assert.equal(
    analysisRange({ ...replay, chapters: [] }, 20000, "elapsed").seconds,
    20,
  );
});
