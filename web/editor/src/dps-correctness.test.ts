import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReplay, enrichCombat } from "./domain";
import { analysisRange, chartSummaryRange } from "./analysis-range";
import { perSecond } from "./combat-metrics";
import { indexEvents, queryEvents, summarize } from "./analysis-model";
import {
  chartIndex,
  queryChartSummary,
  queryChart,
  defaultChartQuery,
} from "./chart-model";
import type { RawReplay } from "./types";
const raw = {
  report: { code: "dps-oracle" },
  fight: {
    startTime: 100000,
    endTime: 107000,
    friendlyPlayers: [1, 2],
    gameZone: { name: "Molten Core" },
    chapters: [
      { id: 1, name: "First", startTime: 101000, endTime: 101500 },
      { id: 2, name: "Second", startTime: 104000, endTime: 106000 },
    ],
  },
  actors: [
    { id: 1, name: "Mage", type: "Player", subType: "Mage" },
    { id: 2, name: "Priest", type: "Player", subType: "Priest" },
    { id: 3, name: "Pet", type: "Pet", petOwner: 1 },
    { id: 10, name: "Boss", type: "NPC" },
  ],
  abilities: [{ gameID: 133, name: "Fireball" }],
  events: [
    [100500, 1, 10, 999],
    [101000, 1, 10, 100],
    [101125, 3, 10, 20],
    [101250, 1, 1, 40],
    [101375, 1, 2, 60],
    [101500, 1, 10, 30],
    [102500, 1, 10, 70],
    [104000, 1, 10, 200],
    [104500, 2, 10, 50],
    [105000, 3, 10, 50],
    [101200, 1, 99, 10000],
    [101200, 10, 1, 90],
  ].map(([timestamp, sourceID, targetID, amount]) => ({
    timestamp,
    sourceID,
    targetID,
    amount,
    type: "damage",
    abilityGameID: 133,
    overkill: 500,
  })),
} as unknown as RawReplay;
const replay = enrichCombat(normalizeReplay(raw, {}), {}),
  events = indexEvents(replay),
  index = chartIndex(replay);
const q = {
  metric: "damage" as const,
  source: "*",
  target: "*",
  spell: "*",
  pets: true,
  start: 0,
  end: 7000,
};
test("Both meter paths use enemy damage and exact current-pull duration", () => {
  for (const [clock, expectedAmount, expectedSeconds] of [
    [500, 0, 0],
    [1250, 120, 0.25],
    [3000, 150, 0.5],
    [5000, 300, 1],
  ]) {
    const range = analysisRange(replay, clock, "encounter");
    const selected = queryEvents(
      events,
      { ...q, start: range.start, end: range.end },
      replay,
    );
    assert.equal(
      selected.reduce((n, e) => n + e.amount, 0),
      expectedAmount,
    );
    assert.equal(range.seconds, expectedSeconds);
    const chartRange = chartSummaryRange(replay, clock, "encounter", [0, 7000]);
    const chart = queryChartSummary(index, {
      ...defaultChartQuery,
      start: chartRange.start,
      end: chartRange.end,
      cutoff: chartRange.end,
    });
    assert.equal(chart.total, expectedAmount);
    assert.equal(
      perSecond(chart.total, chartRange.seconds),
      expectedSeconds > 0 ? expectedAmount / expectedSeconds : null,
    );
  }
});
test("Overall excludes gap damage and downtime, while explicit run scope includes them", () => {
  const range = analysisRange(replay, 5000, "elapsed");
  assert.equal(range.seconds, 1.5);
  const overall = queryEvents(
    events,
    { ...q, end: 5000, intervals: range.intervals },
    replay,
  );
  assert.equal(
    overall.reduce((n, e) => n + e.amount, 0),
    450,
  );
  const allIntervals = analysisRange(
    replay,
    replay.duration,
    "elapsed",
  ).intervals;
  const summary = queryChartSummary(index, {
    ...defaultChartQuery,
    start: 0,
    end: 5000,
    cutoff: 5000,
    intervals: allIntervals,
  });
  assert.equal(summary.total, 450);
  assert.equal(perSecond(summary.total, range.seconds), 300);
  assert.equal(
    queryChartSummary(index, { ...defaultChartQuery, start: 0, end: 5000 })
      .total,
    1519,
  );
});
test("Explicit friendly fire and all-target scopes remain available without cache collisions", () => {
  const first = 1000,
    end = 1500;
  assert.equal(
    queryChartSummary(index, { ...defaultChartQuery, start: first, end }).total,
    150,
  );
  assert.equal(
    queryChartSummary(index, {
      ...defaultChartQuery,
      start: first,
      end,
      hostility: "all",
    }).total,
    10250,
  );
  assert.equal(
    queryChartSummary(index, {
      ...defaultChartQuery,
      start: first,
      end,
      hostility: "friendlies",
    }).total,
    100,
  );
  assert.equal(
    queryEvents(
      events,
      { ...q, start: first, end, hostility: "friendlies" },
      replay,
    ).reduce((n, e) => n + e.amount, 0),
    100,
  );
  assert.equal(
    queryChartSummary(index, { ...defaultChartQuery, start: first, end }).total,
    150,
  );
  assert.equal(
    queryEvents(events, { ...q, source: "10:1", start: first, end }, replay)[0]
      .amount,
    90,
  );
});
test("Pet grouping and bounded sliding summaries preserve eligible damage and exact peaks", () => {
  const selected = queryEvents(
    events,
    { ...q, start: 1000, end: 1500 },
    replay,
  );
  assert.equal(
    summarize(selected, "damage", "actor", replay, true)[0].total,
    150,
  );
  for (const start of [0, 500, 1000, 1250, 1500, 2000]) {
    const query = {
      ...defaultChartQuery,
      start,
      end: Math.max(start + 1, 1500),
      cutoff: 1500,
      bucket: 250,
      smoothing: 0,
    };
    const bounded = queryChartSummary(index, query, false),
      full = queryChart(index, query);
    assert.equal(bounded.total, full.total);
    assert.deepEqual(
      bounded.series.map((s) => [s.key, s.total, s.peak]),
      full.series.map((s) => [s.key, s.total, s.peak]),
    );
  }
});
