import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chartIndex,
  chartLinePath,
  queryChart,
  defaultChartQuery,
  schoolName,
  type ChartQuery,
} from "./chart-model";
import { normalizeReplay, enrichCombat } from "./domain";
import type { Replay, RawReplay } from "./types";
const raw = {
  report: { code: "DyN7vF94QR8aj1Lc" },
  fight: {
    startTime: 0,
    endTime: 5000,
    gameZone: { name: "Molten Core" },
    friendlyPlayers: [1, 2],
  },
  actors: [
    { id: 1, name: "Mage", type: "Player", subType: "Mage" },
    { id: 2, name: "Priest", type: "Player", subType: "Priest" },
    { id: 3, name: "Pet", type: "Pet", petOwner: 1 },
    { id: 10, name: "Boss", type: "NPC", gameID: 10 },
  ],
  abilities: [
    { gameID: 133, name: "Fireball", type: "4" },
    { gameID: 1, name: "Melee", type: "1" },
    { gameID: 10, name: "Holy", type: "2" },
    { gameID: 20, name: "Heal", type: "2" },
  ],
  events: [
    {
      timestamp: 0,
      type: "damage",
      sourceID: 1,
      targetID: 10,
      abilityGameID: 133,
      amount: 100,
      isAoE: false,
      unmitigatedAmount: 120,
      hitType: 2,
    },
    {
      timestamp: 1000,
      type: "damage",
      sourceID: 3,
      targetID: 10,
      abilityGameID: 1,
      amount: 30,
      hitType: 1,
    },
    {
      timestamp: 1000,
      type: "damage",
      sourceID: 2,
      targetID: 10,
      abilityGameID: 10,
      amount: 20,
      unmitigatedAmount: 30,
      hitType: 17,
    },
    {
      timestamp: 1500,
      type: "damage",
      sourceID: 10,
      targetID: 1,
      abilityGameID: 1,
      amount: 70,
      unmitigatedAmount: 100,
      hitType: 1,
    },
    {
      timestamp: 2000,
      type: "damage",
      sourceID: 1,
      targetID: 10,
      targetInstance: 2,
      abilityGameID: 133,
      amount: 50,
      isAoE: true,
      tick: true,
      absorbed: 20,
      resisted: 10,
      hitType: 5,
    },
    {
      timestamp: 2200,
      type: "heal",
      sourceID: 2,
      targetID: 1,
      abilityGameID: 20,
      amount: 40,
      overheal: 60,
      hitType: 1,
    },
    {
      timestamp: 2500,
      type: "heal",
      sourceID: 2,
      targetID: 1,
      abilityGameID: 20,
      amount: 30,
      overheal: 10,
      tick: true,
      hitType: 2,
    },
    {
      timestamp: 3000,
      type: "damage",
      sourceID: 1,
      targetID: 2,
      abilityGameID: 1,
      amount: 10,
      hitType: 1,
    },
  ],
} as unknown as RawReplay;
const replay = enrichCombat(normalizeReplay(raw, {}), {}),
  index = chartIndex(replay),
  q: ChartQuery = {
    ...defaultChartQuery,
    hostility: "all",
    start: 0,
    end: 4000,
    smoothing: 0,
  };
test("Charts compare players with class colours and explicit pet ownership modes", () => {
  const all = queryChart(index, q);
  assert.equal(all.total, 210);
  assert.equal(all.count, 5);
  assert.equal(all.series[0].name, "Mage");
  assert.equal(all.series[0].total, 190);
  assert.equal(all.series[0].color, "#69ccf0");
  assert.equal(queryChart(index, { ...q, pets: false }).total, 180);
  assert.equal(queryChart(index, { ...q, mergePets: false }).series.length, 3);
  assert.equal(queryChart(index, { ...q, players: ["1:1"] }).total, 190);
  assert.equal(
    queryChart(index, { ...q, players: [], restrictPlayers: true }).count,
    0,
  );
});
test("Damage taken belongs to recipient, with attacker and hostility filters", () => {
  assert.equal(queryChart(index, { ...q, metric: "taken" }).total, 80);
  assert.equal(
    queryChart(index, { ...q, metric: "taken", target: "10:1" }).total,
    70,
  );
  assert.equal(queryChart(index, { ...q, hostility: "enemies" }).total, 200);
  assert.equal(queryChart(index, { ...q, hostility: "friendlies" }).total, 10);
});
test("Healing metrics keep effective and wasted healing separate and optional damage fields report coverage", () => {
  assert.equal(queryChart(index, { ...q, metric: "heal" }).total, 70);
  assert.equal(queryChart(index, { ...q, metric: "overheal" }).total, 70);
  assert.equal(queryChart(index, { ...q, metric: "rawHeal" }).total, 140);
  const u = queryChart(index, { ...q, metric: "unmitigated" });
  assert.equal(u.total, 150);
  assert.equal(u.count, 2);
  assert.equal(u.missing, 3);
  assert.equal(queryChart(index, { ...q, metric: "absorbed" }).total, 20);
  assert.equal(queryChart(index, { ...q, metric: "resisted" }).total, 10);
});
test("Ability, target-instance, school, periodic and critical filters use raw event detail", () => {
  assert.equal(queryChart(index, { ...q, spell: "133" }).total, 150);
  assert.equal(queryChart(index, { ...q, target: "10:2" }).total, 50);
  assert.equal(queryChart(index, { ...q, school: "4" }).total, 150);
  assert.equal(queryChart(index, { ...q, periodic: "periodic" }).total, 50);
  assert.equal(queryChart(index, { ...q, hits: "critical" }).total, 170);
  assert.equal(queryChart(index, { ...q, hits: "normal" }).total, 40);
  assert.equal(
    queryChart(index, { ...q, group: "ability" }).series.find(
      (s) => s.spell === 133,
    )?.name,
    "Fireball",
  );
  assert.equal(
    queryChart(index, { ...q, group: "class" }).series[0].name,
    "Mage",
  );
  assert.equal(queryChart(index, { ...q, group: "target" }).series.length, 3);
  assert.equal(schoolName(5), "Physical/Fire");
});
test("Chart buckets conserve amounts, include endpoint events, calculate cumulative/share and rewind safely", () => {
  const base = { ...q, group: "total" as const };
  const amounts = queryChart(index, { ...base, mode: "amount" });
  assert.deepEqual(amounts.series[0].values, [100, 50, 50, 10]);
  assert.deepEqual(
    queryChart(index, { ...base, mode: "cumulative" }).series[0].values,
    [100, 150, 200, 210],
  );
  const shares = queryChart(index, { ...q, mode: "share" });
  assert.equal(shares.series[0].values[1], 60);
  assert.equal(shares.series[1].values[1], 40);
  assert.equal(queryChart(index, { ...q, start: 2000, end: 3000 }).total, 60);
  assert.equal(queryChart(index, { ...q, cutoff: 999 }).total, 100);
  assert.equal(queryChart(index, { ...q, cutoff: 3000 }).total, 210);
  const partial = queryChart(index, { ...q, end: 3500, bucket: 1000 });
  assert.equal(
    partial.series.reduce(
      (a, s) => a + s.amounts.reduce((x, y) => x + y, 0),
      0,
    ),
    210,
  );
});
test("Rate smoothing uses trailing bins including zeroes and binning remains bounded", () => {
  const smoothed = queryChart(index, { ...q, group: "total", smoothing: 3000 });
  assert.equal(smoothed.series[0].values[0], 100);
  assert.equal(smoothed.series[0].values[1], 75);
  assert.ok(Math.abs(smoothed.series[0].values[3] - 110 / 3) < 0.0001);
  const bounded = queryChart(index, { ...q, end: 3_600_000, bucket: 500 });
  assert.equal(bounded.times.length, 7200);
  assert.equal(bounded.step, 500);
  const finest = queryChart(index, { ...q, end: 3_600_000, bucket: 100 });
  assert.equal(finest.times.length, 36000);
  assert.equal(finest.step, 100);
  const long = queryChart(index, { ...q, end: 7_200_000, bucket: 100 });
  assert.ok(long.times.length <= 36000);
});
test("Cached full run produces finite, bounded player and ability series from shared raw event index", (t) => {
  let raw: RawReplay;
  try {
    raw = JSON.parse(
      readFileSync(
        new URL("../../../.agent/work/wcl/full-run.json", import.meta.url),
        "utf8",
      ),
    );
  } catch {
    t.skip("Local cached report absent");
    return;
  }
  const r = enrichCombat(normalizeReplay(raw, {}), {}),
    i = chartIndex(r);
  assert.equal(chartIndex(r), i);
  const detailed = queryChart(i, { ...q, end: r.duration, bucket: 100 });
  const standard = queryChart(i, { ...q, end: r.duration, bucket: 1000 });
  assert.equal(detailed.total, standard.total);
  assert.equal(detailed.step, 100);
  assert.ok(detailed.times.length > standard.times.length * 9);
  assert.ok(detailed.series.every((s) => s.values.every(Number.isFinite)));
  for (const metric of [
    "damage",
    "taken",
    "heal",
    "overheal",
    "unmitigated",
  ] as const) {
    const result = queryChart(i, { ...q, metric, end: r.duration });
    assert.ok(result.total > 0);
    assert.ok(result.series.length >= 30);
    assert.ok(result.times.length <= 36000);
    assert.ok(result.series.every((s) => s.values.every(Number.isFinite)));
  }
});

test("Expanded chart can render its player comparison, filters, styles and CSV control locally", async () => {
  const { createElement } = await import("react"),
    { renderToString } = await import("react-dom/server"),
    { DamageGraph } = await import("./DamageGraph"),
    { EditorController } = await import("./controller");
  const c = new EditorController(),
    state = { ...c.getSnapshot(), replay, time: 3500 };
  const html = renderToString(
    createElement(DamageGraph, {
      state,
      controller: c,
      range: [0, 4000],
      metric: "damage",
    }),
  );
  assert.match(html, /Damage done chart/);
  assert.match(html, /Chart player scope/);
  assert.match(html, /Choose players/);
  assert.match(html, /Stacked area/);
  assert.match(html, /Cumulative total/);
  assert.match(html, /Chart school filter/);
  assert.match(html, /Export full-run CSV/);
  assert.match(html, /stroke="#69ccf0"/);
  assert.match(html, /Show Mage/);
  assert.match(html, /Shift-drag/);
  c.stop();
});

test("Area filters require recorded flags and distinguish single-target and AoE", () => {
  assert.equal(queryChart(index, { ...q, area: "aoe" }).total, 50);
  assert.equal(queryChart(index, { ...q, area: "single" }).total, 100);
  assert.equal(
    queryChart(index, { ...q, metric: "heal", area: "aoe" }).count,
    0,
  );
});

test("Chart curves and vertical scale stay identical across playback and scrolling", async () => {
  const { createElement } = await import("react"),
    { renderToString } = await import("react-dom/server"),
    { DamageGraph } = await import("./DamageGraph"),
    { EditorController } = await import("./controller");
  const c = new EditorController();
  const render = (t: number, range: [number, number]) =>
    renderToString(
      createElement(DamageGraph, {
        state: { ...c.getSnapshot(), replay, time: t, playing: true },
        controller: c,
        range,
        metric: "damage",
      }),
    );
  const early = render(500, [0, 4000]),
    later = render(2500, [0, 4000]),
    scrolled = render(3500, [1000, 5000]);
  const paths = (s: string) =>
    [...s.matchAll(/<path[^>]*d="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths(early), paths(later));
  assert.deepEqual(paths(early), paths(scrolled));
  assert.match(early, /viewBox="0 0 5 180"/);
  assert.match(scrolled, /viewBox="0 0 5 180"/);
  assert.match(early, /200<!-- --> run total/);
  assert.match(later, /200<!-- --> run total/);
  assert.doesNotMatch(early, /Up to playhead/);
  c.stop();
});
test("Fixed chart grid does not stretch bucket sizes to fit a partial final bucket", () => {
  const r = queryChart(index, { ...q, end: 3500, bucket: 1000 });
  assert.equal(r.step, 1000);
  assert.deepEqual(r.times, [0, 1000, 2000, 3000]);
  assert.equal(r.total, 210);
});

test("Curved chart lines preserve every recorded sample and do not round extrema away", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 100],
    [2, 0],
    [3, 0],
  ];
  const before = structuredClone(points);
  const curve = chartLinePath(points, true);
  assert.match(curve, /^M0,0C/);
  assert.match(curve, / 1,100C/);
  assert.match(curve, / 2,0C/);
  assert.ok(curve.endsWith(" 3,0"));
  assert.deepEqual(points, before);
  assert.equal(chartLinePath(points, false), "M0,0L1,100L2,0L3,0");
  assert.equal(chartLinePath([], true), "");
});

test("Chart table follows the playhead and reorders without changing full-run curves", async (t) => {
  const { createElement } = await import("react"),
    { renderToString } = await import("react-dom/server"),
    { DamageGraph } = await import("./DamageGraph"),
    { EditorController } = await import("./controller");
  const r = enrichCombat(
    normalizeReplay(
      {
        ...raw,
        events: [
          ...raw.events,
          {
            timestamp: 3000,
            type: "damage",
            sourceID: 2,
            targetID: 10,
            abilityGameID: 10,
            amount: 500,
          },
        ],
      } as RawReplay,
      {},
    ),
    {},
  );
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key.endsWith(".v2")
          ? JSON.stringify({ scope: "selected", bucket: 1000 })
          : null,
      setItem() {},
    },
  });
  t.after(() => {
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const c = new EditorController();
  const render = (time: number, actor?: (typeof r.actors)[number]) =>
    renderToString(
      createElement(DamageGraph, {
        state: { ...c.getSnapshot(), replay: r, time, playing: false },
        controller: c,
        range: [0, 5000],
        actor,
      }),
    );
  const early = render(500),
    late = render(3500),
    rewound = render(500);
  const body = (html: string) => html.match(/<tbody>(.*?)<\/tbody>/s)![1];
  assert.match(body(early), /100/);
  assert.doesNotMatch(body(early), /Priest/);
  assert.ok(body(late).indexOf("Priest") < body(late).indexOf("Mage"));
  assert.match(body(late), /520/);
  assert.deepEqual(body(early), body(rewound));
  const paths = (html: string) =>
    [...html.matchAll(/<path\b[^>]*data-series[^>]*>/g)].map(
      (m) => m[0].match(/\bd="([^"]*)"/)![1],
    );
  assert.deepEqual(paths(early), paths(late));
  assert.ok(paths(early).every((p) => p.includes("C")));
  // Focus in a raid comparison retains the other players and emphasizes the selected line.
  const focused = render(
    3500,
    r.actors.find((a) => a.id === 1),
  );
  assert.match(focused, /data-focused="true" opacity="1" stroke-width="3.5"/);
  assert.match(focused, /stroke="#69ccf0"/i);
  assert.match(focused, /opacity="0.25" stroke-width="1.6"/);
  assert.match(body(focused), /Priest/);
  assert.match(focused, /value="250" selected=""/);
  assert.match(body(focused), /class="chart-row-bar"/);
  const tags = [...focused.matchAll(/<path[^>]*data-series[^>]*>/g)].map(
    (m) => m[0],
  );
  assert.match(tags.at(-1)!, /data-focused="true"/);
  c.stop();
});

test("100ms chart bins distinguish events inside the former one-second bucket", () => {
  const r = enrichCombat(
    normalizeReplay(
      {
        ...raw,
        events: [
          {
            timestamp: 1100,
            type: "damage",
            sourceID: 1,
            targetID: 10,
            abilityGameID: 133,
            amount: 10,
          },
          {
            timestamp: 1300,
            type: "damage",
            sourceID: 1,
            targetID: 10,
            abilityGameID: 133,
            amount: 30,
          },
        ],
      } as RawReplay,
      {},
    ),
    {},
  );
  const detail = queryChart(chartIndex(r), { ...q, end: 5000, bucket: 100 });
  assert.equal(detail.step, 100);
  assert.equal(detail.series[0].amounts[11], 10);
  assert.equal(detail.series[0].amounts[13], 30);
  assert.equal(detail.total, 40);
});
