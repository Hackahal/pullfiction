import test from "node:test";
import assert from "node:assert/strict";
import {
  findCharacter,
  characterReports,
  rankingPage,
  rankingRaids,
  type RankingSearch,
} from "./wcl-discovery";
const server = {
  name: "Living Flame",
  slug: "living-flame",
  region: { slug: "eu" },
};
test("character lookup uses name, realm and selected host contract", async () => {
  const signal = new AbortController().signal;
  const c = await findCharacter(
    async (q, v, version, s) => {
      assert.match(q, /characterData/);
      assert.deepEqual(v, {
        name: "Hacka",
        realm: "living-flame",
        region: "eu",
      });
      assert.equal(version, "sod");
      assert.equal(s, signal);
      return {
        characterData: {
          character: { id: 42, name: "Hacka", classID: 1, server },
        },
      };
    },
    { name: " Hacka ", realm: "living-flame", region: "eu" },
    "sod",
    signal,
  );
  assert.equal(c.id, 42);
  await assert.rejects(
    findCharacter(
      async () => ({ characterData: { character: null } }),
      { name: "Hacka", realm: "living-flame", region: "eu" },
      "sod",
    ),
    /not found/,
  );
});
test("character report pagination uses recentReports and rejects another page", async () => {
  await characterReports(
    async (q, v) => {
      assert.match(q, /recentReports\(limit:20,page:\$page\)/);
      assert.equal(v.page, 2);
      return {
        characterData: {
          character: {
            recentReports: { data: [], current_page: 2, has_more_pages: false },
          },
        },
      };
    },
    42,
    2,
    "vanilla",
  );
  await assert.rejects(
    characterReports(
      async () => ({
        characterData: {
          character: { recentReports: { data: [], current_page: 1 } },
        },
      }),
      42,
      2,
      "vanilla",
    ),
    /Could not load/,
  );
});
const search: RankingSearch = {
  encounter: 1,
  metric: "speed",
  partition: 1,
  difficulty: 3,
  size: 40,
  region: "eu",
  className: "",
  page: 1,
};
test("rankings separate fight speed and character performance, retain absent backing reports", async () => {
  const speed = await rankingPage(
    async (q, v) => {
      assert.match(q, /fightRankings/);
      assert.doesNotMatch(q, /className:/);
      assert.equal(v.region, "eu");
      return {
        worldData: {
          encounter: {
            fightRankings: {
              rankings: [
                { guild: { name: "Guild", faction: 1 }, duration: 1000 },
              ],
              hasMorePages: true,
            },
          },
        },
      };
    },
    search,
    "vanilla",
  );
  assert.equal(speed.entries[0].reportCode, null);
  assert.equal(speed.more, true);
  assert.equal(speed.entries[0].faction, "Horde");
  const dps = await rankingPage(
    async (q) => {
      assert.match(q, /characterRankings/);
      assert.match(q, /CharacterRankingMetricType/);
      return {
        worldData: {
          encounter: {
            characterRankings: {
              rankings: [
                {
                  name: "Player",
                  type: "Mage",
                  guild: { name: "Guild" },
                  amount: 500,
                  report: { code: "bZX7VqdwpcmyrGzN", fightID: 2 },
                },
              ],
            },
          },
        },
      };
    },
    { ...search, metric: "dps" },
    "sod",
  );
  assert.equal(dps.entries[0].amount, 500);
  assert.equal(dps.entries[0].name, "Player");
  assert.equal(dps.entries[0].className, "Mage");
  await assert.rejects(
    rankingPage(
      async () => {
        throw Error("must not query");
      },
      { ...search, page: 0 },
      "vanilla",
    ),
    /valid ranking/,
  );
});
test("catalogue does not leak Season of Discovery into Era", async () => {
  const query = async () => ({
    worldData: {
      zones: [
        {
          id: 1,
          name: "Molten Core",
          partitions: [{ id: 1, name: "Season of Discovery", default: true }],
          difficulties: [{ id: 3, name: "Normal", sizes: [20] }],
          encounters: [{ id: 1, name: "Boss" }],
        },
      ],
    },
  });
  assert.equal((await rankingRaids(query, "vanilla")).length, 0);
  assert.equal((await rankingRaids(query, "sod")).length, 1);
});

test("character lookup normalizes WCL region casing", async () => {
  const c = await findCharacter(
    async () => ({
      characterData: {
        character: {
          id: 1,
          name: "Player",
          classID: 8,
          server: {
            name: "Living Flame",
            slug: "living-flame",
            region: { slug: "EU" },
          },
        },
      },
    }),
    { name: "Player", realm: "living-flame", region: "eu" },
    "sod",
  );
  assert.equal(c.server.region.slug, "eu");
});
test("all-class queries omit the optional argument and later-page ranks stay unknown", async () => {
  const page = await rankingPage(
    async (q) => {
      assert.doesNotMatch(q, /className/);
      return {
        worldData: {
          encounter: {
            characterRankings: {
              rankings: [
                { name: "Player", amount: 1 },
                { rank: 52, name: "Another", amount: 2 },
              ],
            },
          },
        },
      };
    },
    { ...search, metric: "dps", page: 2 },
    "sod",
  );
  assert.equal(page.entries[0].position, null);
  assert.equal(page.entries[1].position, 52);
});
