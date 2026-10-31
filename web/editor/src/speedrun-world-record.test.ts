import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSpeedCategory,
  fetchSpeedWorldRecord,
  defaultSpeedSelection,
} from "./speedrun-world-record";
import { compareSpeedrun } from "./speedrun-comparison";
import { fixture } from "./speedrun-test-fixture";
import { indexSpeedrun, speedrunAt } from "./speedrun-model";
const code = "ABcdEFghIJklMNop";
const category = {
  zoneID: 2007,
  encounterID: 10000,
  partitions: [{ id: 1, name: "Discovery P1", default: true }],
  difficulties: [{ id: 3, name: "Normal", sizes: [10] }],
};
const selection = defaultSpeedSelection(category);
const winner = {
  guild: { name: "Fast guild" },
  duration: 14000,
  report: { code, fightID: 99 },
};
const ranked = {
  worldData: { encounter: { fightRankings: { rankings: [winner] } } },
};
const report = {
  fights: [
    {
      id: 99,
      name: "Complete Raids",
      completeRaid: true,
      startTime: 2000,
      endTime: 16000,
      gameZone: { name: "Blackfathom Deeps" },
    },
    {
      id: 1,
      name: "Baron Aquanis",
      encounterID: 1,
      kill: true,
      startTime: 2000,
      endTime: 5000,
      gameZone: { name: "Blackfathom Deeps" },
    },
    {
      id: 2,
      name: "Ghamoo-ra",
      encounterID: 2,
      kill: true,
      startTime: 6000,
      endTime: 11000,
      gameZone: { name: "Blackfathom Deeps" },
    },
    {
      id: 3,
      name: "Aku'mai",
      encounterID: 7,
      kill: true,
      startTime: 12000,
      endTime: 16000,
      gameZone: { name: "Blackfathom Deeps" },
    },
    {
      id: 4,
      name: "Other run",
      encounterID: 7,
      kill: true,
      startTime: 20000,
      endTime: 30000,
      gameZone: { name: "Blackfathom Deeps" },
    },
  ],
};

test("WR category resolves WCL IDs from shared catalogue without mixing Era, SoD and Hardcore", async () => {
  const zones = [
    {
      id: 2000,
      name: "Molten Core",
      partitions: [
        { id: 1, name: "S0", default: false },
        { id: 2, name: "Hardcore", default: true },
        { id: 3, name: "SoM P1 & P2", default: false },
      ],
      difficulties: [{ id: 3, name: "Normal", sizes: [40] }],
      encounters: [{ id: 12118, name: "Lucifron" }],
    },
    {
      id: 2012,
      name: "Molten Core",
      partitions: [{ id: 1, name: "Discovery P4", default: true }],
      difficulties: [{ id: 5, name: "Heat 3", sizes: [20] }],
      encounters: [{ id: 100669, name: "Lucifron" }],
    },
  ];
  const completeRaids = { encounters: [{ id: 50673, name: "Molten Core" }] };
  const query = async (_q: string, vars: any) => ({
    worldData: {
      zones,
      completeRaids:
        vars.completeZone === 2504
          ? { encounters: [{ id: 2961, name: "Molten Core" }] }
          : completeRaids,
    },
  });
  const era = await fetchSpeedCategory(query, "vanilla", 409);
  const sod = await fetchSpeedCategory(query, "sod", 409);
  assert.equal(era.zoneID, 2000);
  assert.equal(era.partitions.length, 1);
  assert.equal(defaultSpeedSelection(era).partition, 1);
  assert.equal(sod.zoneID, 2012);
  assert.equal(defaultSpeedSelection(sod).difficulty, 5);
  assert.equal(era.encounterID, 50673);
  assert.equal(sod.encounterID, 2961);
  completeRaids.encounters = [];
  await assert.rejects(
    fetchSpeedCategory(query, "vanilla", 409),
    /Complete Raids leaderboard/,
  );
});
test("WR query uses selected category, no region filter, and only winning run metadata", async () => {
  const calls: any[] = [];
  const wr = await fetchSpeedWorldRecord(
    async (query, variables, version, signal) => {
      calls.push({ query, variables, version, signal });
      return query.includes("fightRankings") ? ranked : report;
    },
    "sod",
    48,
    category,
    selection,
  );
  assert.equal(wr!.guild, "Fast guild");
  assert.equal(wr!.duration, 14000);
  assert.equal(wr!.splits.length, 3);
  assert.deepEqual(
    wr!.splits.map((s) => s.end),
    [3000, 9000, 14000],
  );
  assert.equal(calls[0].variables.partition, 1);
  assert.equal(calls[0].variables.size, 10);
  assert.equal(calls[0].variables.filter, undefined);
  assert.doesNotMatch(calls[0].query, /serverRegion/);
  assert.doesNotMatch(calls[1].query, /events\(/);
  assert.match(wr!.url, /sod.warcraftlogs.com/);
});
test("Empty, invalid and inaccessible WR data do not fabricate rankings or split ranges", async () => {
  assert.equal(
    await fetchSpeedWorldRecord(
      async () => ({
        worldData: { encounter: { fightRankings: { rankings: [] } } },
      }),
      "sod",
      48,
      category,
      selection,
    ),
    null,
  );
  await assert.rejects(
    fetchSpeedWorldRecord(
      async () => ({
        worldData: {
          encounter: {
            fightRankings: { rankings: [{ ...winner, duration: -1 }, winner] },
          },
        },
      }),
      "sod",
      48,
      category,
      selection,
    ),
    /no usable/,
  );
  await assert.rejects(
    fetchSpeedWorldRecord(async () => ranked, "sod", 48, category, {
      ...selection,
      size: 40,
    }),
    /valid WCL/,
  );
  const wr = await fetchSpeedWorldRecord(
    async (query) =>
      query.includes("fightRankings")
        ? ranked
        : { fights: report.fights.filter((f) => !f.completeRaid) },
    "sod",
    48,
    category,
    selection,
  );
  assert.equal(wr!.duration, 14000);
  assert.equal(wr!.splits.length, 0);
  assert.match(wr!.splitNote!, /exact start\/end/);
  const abort = new AbortController();
  await assert.rejects(
    fetchSpeedWorldRecord(
      async (query) => {
        if (query.includes("fightRankings")) return ranked;
        abort.abort();
        throw new Error("cancelled");
      },
      "sod",
      48,
      category,
      selection,
      abort.signal,
    ),
    { name: "AbortError" },
  );
});
test("Comparison uses one WR route, signed cumulative/segment deltas and no future replay kills", async () => {
  const wr = await fetchSpeedWorldRecord(
    async (query) => (query.includes("fightRankings") ? ranked : report),
    "sod",
    48,
    category,
    selection,
  );
  const index = indexSpeedrun(fixture());
  let comparison = compareSpeedrun(index, speedrunAt(index, 10000), wr);
  assert.equal(comparison.delta, -1000);
  assert.equal(comparison.previousSegment, 0);
  assert.equal(comparison.projected, 13000);
  assert.equal(comparison.rows.at(-1)!.delta, null);
  comparison = compareSpeedrun(index, speedrunAt(index, 2000), wr);
  assert.equal(comparison.delta, null);
  wr!.splits.reverse();
  comparison = compareSpeedrun(index, speedrunAt(index, 10000), wr);
  assert.equal(comparison.routeMatches, false);
  assert.equal(comparison.delta, null);
  assert.equal(comparison.projected, null);
});

test("Complete-raid ranking bounds work without a synthetic fight ID", async () => {
  const boundsRanked = {
    worldData: {
      encounter: {
        fightRankings: {
          rankings: [
            { ...winner, report: { code, startTime: 2000, endTime: 16000 } },
          ],
        },
      },
    },
  };
  const wr = await fetchSpeedWorldRecord(
    async (q) =>
      q.includes("fightRankings")
        ? boundsRanked
        : { fights: report.fights.filter((f) => !f.completeRaid) },
    "sod",
    48,
    category,
    selection,
  );
  assert.equal(wr!.fightID, null);
  assert.equal(wr!.splits.length, 3);
  assert.match(wr!.url, /boss=-3&start=2000&end=16000/);
});
test("Estimated clocks and mismatched MC heat never produce WR deltas", async () => {
  const wr = await fetchSpeedWorldRecord(
    async (q) => (q.includes("fightRankings") ? ranked : report),
    "sod",
    48,
    category,
    selection,
  );
  const replay = fixture();
  const index = indexSpeedrun(replay);
  index.estimated = true;
  let result = compareSpeedrun(index, speedrunAt(index, 10000), wr);
  assert.equal(result.delta, null);
  assert.ok(result.rows.every((r) => r.delta === null));
  index.estimated = false;
  replay.map = 409;
  wr!.category.difficulty = 5;
  result = compareSpeedrun(index, speedrunAt(index, 10000), wr);
  assert.equal(result.categoryMatches, false);
  assert.equal(result.delta, null);
  assert.ok(result.rows.every((r) => r.delta === null));
});

test("unsupported complete-raid categories fail before a leaderboard query", async () => {
  for (const [version, map] of [
    ["vanilla", 249],
    ["sod", 509],
  ] as const) {
    await assert.rejects(
      fetchSpeedCategory(
        async () => {
          assert.fail(
            "Unsupported categories must not query an unrelated raid",
          );
        },
        version,
        map,
      ),
      /Complete Raids API category/,
    );
  }
});

test("Era trash-skip selection cannot silently return the no-skips record", async () => {
  await assert.rejects(
    fetchSpeedWorldRecord(
      async () => {
        assert.fail("WCL ignores allowskips in its advanced filter");
      },
      "vanilla",
      48,
      category,
      { ...selection, skips: true },
    ),
    /cannot verify the With skips/,
  );
});

test("live WCL epoch timestamps without exact run bounds retain only the total", async () => {
  const liveWinner = {
    duration: 2044745,
    startTime: 1738016171329,
    report: {
      code: "2rpgvWn9ahB7zYC6",
      fightID: 10000,
      startTime: 1738013431529,
    },
    guild: { name: "Fake Fresh" },
  };
  const wr = await fetchSpeedWorldRecord(
    async (q) =>
      q.includes("fightRankings")
        ? {
            worldData: {
              encounter: { fightRankings: { rankings: [liveWinner] } },
            },
          }
        : {
            fights: [
              {
                id: 23,
                encounterID: 100717,
                kill: true,
                startTime: 4547734,
                endTime: 4784545,
                gameZone: { id: 531, name: "Temple of Ahn'Qiraj" },
              },
            ],
          },
    "sod",
    531,
    category,
    selection,
  );
  assert.equal(wr?.duration, 2044745);
  assert.equal(wr?.guild, "Fake Fresh");
  assert.deepEqual(wr?.splits, []);
  assert.match(wr?.splitNote ?? "", /exact start\/end/);
});
