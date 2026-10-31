import test from "node:test";
import assert from "node:assert/strict";
import {
  chartMetrics,
  defaultChartQuery,
  queryChart,
  queryChartSummary,
  type ChartEvent,
  type ChartIndex,
  type ChartQuery,
  type ChartGroup,
  type ChartMode,
} from "./chart-model";
import type { Actor } from "./types";
function scalar(result: ReturnType<typeof queryChart>) {
  const { times: _times, series, ...rest } = result;
  return {
    ...rest,
    series: series.map(({ values: _values, amounts: _amounts, ...row }) => row),
  };
}
function fixture(): ChartIndex {
  const actor = (
    id: number,
    instance: number,
    name: string,
    type: string,
    cls: string,
    owner?: number,
  ) =>
    ({
      id,
      instance,
      key: `${id}:${instance}`,
      name,
      type,
      class: cls,
      owner,
    }) as Actor;
  // The first actor with id 1 is instance 2, matching the legacy Map scan.
  const actors = [
    actor(1, 2, "First mage", "Player", "Mage"),
    actor(1, 1, "Second mage", "Player", "Warrior"),
    actor(2, 1, "Priest", "Player", "Priest"),
    actor(3, 1, "Pet", "Pet", "", 1),
    actor(10, 1, "Enemy", "NPC", "Boss"),
    actor(10, 2, "Other enemy", "NPC", "Boss"),
  ];
  let seed = 112358;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const events: ChartEvent[] = Array.from({ length: 180 }, (_, i): ChartEvent => {
    const times = [
        0, 100, 250, 333, 500, 750, 1000, 1250, 1999.99, 2000, 4000, 5000,
      ],
      sources = ["1:1", "1:2", "2:1", "3:1", "10:1", "999:1"],
      targets = ["10:1", "10:2", "1:1", "2:1", "999:1"],
      amount = i % 37 === 0 ? 1e16 : random(10000) / 10;
    return {
      t: times[random(times.length)],
      kind: random(3) ? "damage" : "heal",
      source: sources[random(sources.length)],
      target: targets[random(targets.length)],
      spell: [1, 133, 200][random(3)],
      school: [1, 4, 5, 8][random(4)],
      name: `Spell ${i % 3}`,
      icon: `icon-${i % 3}`,
      amount,
      overheal: random(100) / 10,
      unmitigated: i % 3 ? amount + 0.1 : undefined,
      absorbed: random(20) / 10,
      overkill: random(20),
      blocked: random(20),
      resisted: random(20),
      mitigated: random(20),
      critical: i % 3 === 0,
      hitType: i % 3 === 0 ? 2 : 1,
      tick: i % 2 === 0,
      aoe: i % 3 === 0 ? undefined : i % 3 === 1,
    };
  }).sort((a, b) => a.t - b.t);
  return {
    events,
    actors: new Map(actors.map((a) => [a.key, a])),
    players: new Set([1, 2]),
  };
}
test("Scalar chart histories match full results for every metric, group and mode across filters and reverse cutoffs", () => {
  const index = fixture(),
    groups: ChartGroup[] = [
      "total",
      "player",
      "class",
      "ability",
      "target",
      "school",
    ],
    modes: ChartMode[] = ["rate", "amount", "cumulative", "share"];
  let seed = 73,
    comparisons = 0;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  for (const metric of Object.keys(chartMetrics) as ChartQuery["metric"][])
    for (const group of groups)
      for (const mode of modes) {
        const base: ChartQuery = {
          ...defaultChartQuery,
          metric,
          group,
          mode,
          start: 0,
          end: 5000,
          bucket: 250,
        };
        for (const end of [
          0, 250, 250.001, 500, 1000, 1250, 4000, 5000, 4000, 1000, 250, 0,
        ]) {
          assert.deepEqual(
            queryChartSummary(index, { ...base, end }),
            scalar(queryChart(index, { ...base, end })),
          );
          comparisons++;
        }
        for (let i = 0; i < 16; i++) {
          const q: ChartQuery = {
            ...base,
            start: [0, 100.1, 333][random(3)],
            end: [250, 333, 1000, 1999.99, 2000, 5000, 7_200_000][random(7)],
            cutoff: [0, 250, 333, 1250, 5000, 10000][random(6)],
            bucket: [100, 250, 333, 1000][random(4)],
            smoothing: [0, 1000, 3000][random(3)],
            players: [[], ["1:1"], ["1:2"], ["2:1", "1:1"]][random(4)],
            pets: !!random(2),
            mergePets: !!random(2),
            restrictPlayers: !!random(2),
            target: ["*", "10:1", "1:1"][random(3)],
            spell: ["*", "133"][random(2)],
            school: ["*", "4"][random(2)],
            periodic: ["all", "direct", "periodic"][
              random(3)
            ] as ChartQuery["periodic"],
            hits: ["all", "normal", "critical"][
              random(3)
            ] as ChartQuery["hits"],
            area: ["all", "aoe", "single"][random(3)] as ChartQuery["area"],
            hostility: ["all", "friendlies", "enemies"][
              random(3)
            ] as ChartQuery["hostility"],
          };
          assert.deepEqual(
            queryChartSummary(index, q),
            scalar(queryChart(index, q)),
            JSON.stringify(q),
          );
          comparisons++;
        }
      }
  assert.equal(comparisons, 7392);
});
test("Exact-end peak merges each tied event into the previous bin in original floating addition order", () => {
  const index = fixture(),
    base = index.events.find((e) => e.source === "1:1")!;
  index.events = [
    { ...base, t: 750, kind: "damage", amount: 1e16 },
    { ...base, t: 1000, kind: "damage", amount: 1 },
    { ...base, t: 1000, kind: "damage", amount: 1 },
    { ...base, t: 1000.001, kind: "damage", amount: 20 },
  ];
  const q: ChartQuery = {
    ...defaultChartQuery,
    start: 0,
    end: 1000,
    bucket: 250,
    group: "total",
  };
  assert.notEqual((1e16 + (1 + 1)) / 0.25, (1e16 + 1 + 1) / 0.25);
  for (const end of [750, 1000, 1000.001, 1250, 1000, 999.999])
    assert.deepEqual(
      queryChartSummary(index, { ...q, end }),
      scalar(queryChart(index, { ...q, end })),
    );
  assert.equal(queryChartSummary(index, q).series[0].peak, 4e16);
});
test("Summary cache isolates new source indices and survives eviction, caller edits and duplicate-owner instances", () => {
  const index = fixture(),
    q: ChartQuery = { ...defaultChartQuery, start: 0, end: 5000, bucket: 250 };
  const original = queryChartSummary(index, q);
  for (const group of [
    "ability",
    "class",
    "target",
    "school",
    "total",
  ] as ChartGroup[])
    assert.deepEqual(
      queryChartSummary(index, { ...q, group }),
      scalar(queryChart(index, { ...q, group })),
    );
  assert.deepEqual(queryChartSummary(index, q), original);
  original.series.reverse();
  original.series[0].total = -1;
  assert.deepEqual(queryChartSummary(index, q), scalar(queryChart(index, q)));
  const next = {
    ...index,
    events: index.events.map((e) => ({ ...e, amount: e.amount + 5 })),
  };
  assert.deepEqual(queryChartSummary(next, q), scalar(queryChart(next, q)));
  assert.notEqual(
    queryChartSummary(next, q).total,
    queryChartSummary(index, q).total,
  );
  const petOnly = {
    ...index,
    events: index.events.filter((e) => e.source === "3:1"),
  };
  const petSummary = queryChartSummary(petOnly, q);
  assert.ok(petSummary.series.length > 0);
  assert.ok(petSummary.series.every((s) => s.actor === "1:2"));
});
