import test from "node:test";
import assert from "node:assert/strict";
import { WclParseData } from "./wcl-parse-data";
import type { ParseOptions } from "./playback-parses";
const code = "ABcdEFghIJklMNop";
const encounter = {
  id: 14,
  encounterID: 201118,
  name: "Patchwerk",
  start: 0,
  end: 10000,
  kill: true,
};
const options: ParseOptions = {
  compare: "Rankings",
  timeframe: "Today",
  bracket: "overall",
};
const character = {
  id: 87319451,
  name: "Reymea",
  class: "Warlock",
  spec: "Tank",
  server: { name: "Living Flame" },
  amount: 6523,
  bracket: 12,
  rankPercent: 83,
  bracketPercent: 81,
  totalParses: 304,
};
const fight = {
  fightID: 14,
  partition: 1,
  encounter: { id: 201118 },
  difficulty: 5,
  size: 20,
  kill: 1,
  roles: { tanks: { characters: [character] } },
};
function fixture(
  overrides: {
    population?: number;
    bracketPopulation?: number;
    alter?: (data: any, vars: any) => void;
  } = {},
) {
  const calls: any[] = [];
  const loader = new WclParseData(async (q, v, version, signal) => {
    calls.push({ q, v, version });
    signal?.throwIfAborted();
    const pop = overrides.population ?? 304;
    const data = q.includes("reportData")
      ? {
          rankings: {
            data: [
              {
                ...structuredClone(fight),
                roles: {
                  tanks: { characters: [{ ...character, totalParses: pop }] },
                },
              },
            ],
          },
        }
      : (() => {
          const n =
            v.bracket === null ? pop : (overrides.bracketPopulation ?? 125);
          const count = Math.max(
            0,
            Math.min(100, n - (Number(v.page) - 1) * 100),
          );
          return {
            worldData: {
              encounter: {
                characterRankings: {
                  page: v.page,
                  count,
                  hasMorePages: Number(v.page) * 100 < n,
                  rankings: Array.from({ length: count }, (_, i) => ({
                    class: "Warlock",
                    spec: "Tank",
                    size: i % 2 ? 18 : 20,
                    amount: 200000 - ((Number(v.page) - 1) * 100 + i),
                  })),
                },
              },
            },
          };
        })();
    overrides.alter?.(data, v);
    return data;
  });
  return { loader, calls };
}
test("live WCL ranking response shape produces a full-population sampled curve", async () => {
  const { loader, calls } = fixture();
  const result = await loader.load(code, encounter, "sod", options);
  const ref = result.references[0];
  assert.equal(ref.player.name, "Reymea");
  assert.equal(ref.player.percentile, 83);
  assert.equal(ref.player.bracketPercentile, 81);
  assert.equal(ref.curve?.length, 304);
  assert.equal(ref.curve?.[0].percentile, 100);
  assert.equal(Math.min(...ref.curve!.map((p) => p.percentile)), 0);
  assert.ok(
    calls
      .filter((c) => c.q.includes("characterRankings"))
      .every(
        (c) =>
          c.v.partition === 1 &&
          c.v.difficulty === 5 &&
          c.v.size === 20 &&
          c.v.className === "Warlock" &&
          c.v.specName === "Tank" &&
          c.version === "sod",
      ),
  );
  const n = calls.length;
  await loader.load(code, encounter, "sod", options);
  assert.equal(calls.length, n + 1);
});
test("all comparison options reach WCL, without fetching unsupported prediction curves", async () => {
  for (const compare of ["Rankings", "Parses"] as const)
    for (const timeframe of ["Today", "Historical"] as const) {
      const { loader, calls } = fixture();
      await loader.load(code, encounter, "sod", {
        ...options,
        compare,
        timeframe,
      });
      assert.equal(calls[0].v.compare, compare);
      assert.equal(calls[0].v.timeframe, timeframe);
      if (compare !== "Rankings" || timeframe !== "Today")
        assert.equal(calls.length, 1);
    }
});
test("item-level uses its own population and never the overall denominator", async () => {
  const { loader, calls } = fixture();
  const r = await loader.load(code, encounter, "sod", {
    ...options,
    bracket: "itemLevel",
  });
  const curve = r.references[0].curve!;
  assert.equal(curve.length, 125);
  assert.equal(curve.at(-1)?.percentile, 0);
  assert.ok(calls.slice(1).every((c) => c.v.bracket === 12));
});
test("large populations load bounded pages across distribution rather than treating top100 as all players", async () => {
  const { loader, calls } = fixture({ population: 100000 });
  const r = await loader.load(code, encounter, "sod", options);
  assert.equal(r.references[0].curve?.length, 500);
  assert.ok(calls.some((c) => c.v.page === 1000));
  assert.ok(calls.some((c) => c.v.page === 500));
  assert.equal(calls.length, 6);
});
test("invalid report ranking category rejects explicitly", async () => {
  const { loader } = fixture({
    alter(d) {
      if (d.rankings) d.rankings.data[0].encounter.id = 123;
    },
  });
  await assert.rejects(loader.load(code, encounter, "sod", options), {
    message: "WCL returned a different or unsupported ranking category.",
  });
});
test("malformed leaderboard rows resolve with a category note and no curve", async () => {
  const { loader } = fixture({
    alter(d) {
      const page = d.worldData?.encounter?.characterRankings;
      if (page?.rankings.length) page.rankings[0].class = "Mage";
    },
  });
  const result = await loader.load(code, encounter, "sod", options);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].curve, null);
  assert.equal(
    result.references[0].note,
    "WCL returned a different ranking category.",
  );
});
test("incomplete leaderboard pages resolve with a page note and no curve", async () => {
  const { loader } = fixture({
    alter(d) {
      const page = d.worldData?.encounter?.characterRankings;
      if (page?.rankings.length) page.count = -1;
    },
  });
  const result = await loader.load(code, encounter, "sod", options);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].curve, null);
  assert.equal(
    result.references[0].note,
    "WCL returned an incomplete ranking page.",
  );
});
test("empty fight results, healer roles and aborts never manufacture damage percentiles", async () => {
  const empty = new WclParseData(async () => ({ rankings: { data: [] } }));
  await assert.rejects(
    empty.load(code, encounter, "sod", options),
    /no rankings/,
  );
  const healer = new WclParseData(async () => ({
    rankings: {
      data: [{ ...fight, roles: { healers: { characters: [character] } } }],
    },
  }));
  const r = await healer.load(code, encounter, "sod", options);
  assert.equal(r.references[0].curve, null);
  assert.match(r.references[0].note!, /healing/);
  const { loader } = fixture();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    loader.load(code, encounter, "sod", options, abort.signal),
    /abort/i,
  );
});

test("selected-player mode fetches only that player's spec, and does not fetch future damage", async () => {
  const { loader, calls } = fixture();
  const r = await loader.load(code, encounter, "sod", options, undefined, {
    name: "Different",
    className: "Mage",
  });
  assert.equal(calls.length, 1);
  assert.equal(r.references[0].curve, null);
  assert.ok(calls.every((c) => !c.q.includes("events")));
});
test("API allowance errors stop additional leaderboard work in that load", async () => {
  let requests = 0;
  const loader = new WclParseData(async (q) => {
    requests++;
    if (q.includes("reportData"))
      return {
        rankings: {
          data: [
            {
              ...fight,
              roles: {
                dps: {
                  characters: Array.from({ length: 20 }, (_, i) => ({
                    ...character,
                    name: `Player${i}`,
                    spec: `Spec${i}`,
                  })),
                },
              },
            },
          ],
        },
      };
    throw new Error("no database points remaining");
  });
  const r = await loader.load(code, encounter, "sod", options);
  assert.ok(requests <= 3);
  assert.ok(r.references.every((r) => /allowance reached/.test(r.note ?? "")));
});
