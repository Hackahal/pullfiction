import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserLogs, browserQuery } from "./wcl-browser";
import { collectEvents } from "../../planner/wcl-report.mjs";

const code = "bZX7VqdwpcmyrGzN";
const fight = (
  id: number,
  name: string,
  startTime: number,
  endTime: number,
  player: number,
) => ({
  id,
  name,
  encounterID: id,
  startTime,
  endTime,
  friendlyPlayers: [player],
  gameZone: { id: 409, name },
});

test("browser API authenticates only to the selected supported ruleset", async () => {
  let disconnected = false;
  const query = browserQuery(
    {
      accessToken: async () => "test-access",
      disconnect: () => {
        disconnected = true;
      },
    },
    async (url, options) => {
      assert.equal(url, "https://sod.warcraftlogs.com/api/v2/user");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer test-access",
      );
      assert.equal(options?.redirect, "error");
      assert.equal(options?.credentials, "omit");
      return Response.json({ data: { reportData: { report: { code } } } });
    },
  );
  assert.equal((await query("query{}", {}, "sod")).code, code);
  await assert.rejects(query("query{}", {}, "evil.example"), /Unsupported/);
  assert.equal(disconnected, false);
  const denied = browserQuery(
    {
      accessToken: async () => "test",
      disconnect: () => {
        disconnected = true;
      },
    },
    async () => new Response(null, { status: 401 }),
  );
  await assert.rejects(denied("query{}", {}, "sod"), /401/);
  assert.equal(disconnected, true);
});

test("full raid import retains resources, pet metadata and actions across encounters", async () => {
  const actors = [
    { id: 1, name: "Mage", subType: "Mage", type: "Player" },
    { id: 2, name: "Pet", type: "Pet", petOwner: 1 },
  ];
  const fights = [
    fight(1, "Molten Core", 0, 100, 1),
    fight(2, "Blackwing Lair", 110, 120, 2),
    fight(3, "Molten Core", 150, 200, 1),
  ];
  const events = [
    { timestamp: 25, sourceID: 1, classResources: [{ type: 0, amount: 500 }] },
    { timestamp: 115, sourceID: 2 },
    { timestamp: 130, sourceID: 1 },
    { timestamp: 160, sourceID: 2, petOwner: 1 },
  ];
  const progress: number[] = [],
    requests: Record<string, unknown>[] = [];
  const logs = new BrowserLogs(async (query, variables, version) => {
    requests.push(variables);
    assert.equal(version, "sod");
    if (query.includes("visibility revision"))
      return { code, title: "Raid", fights, masterData: { actors } };
    if (query.includes("events(")) {
      assert.match(query, /includeResources:true/);
      assert.doesNotMatch(query, /fightIDs/);
      return {
        events:
          variables.start === 0
            ? { data: events.slice(0, 2), nextPageTimestamp: 125 }
            : { data: events.slice(2), nextPageTimestamp: null },
      };
    }
    return {
      masterData: { actors, abilities: [{ gameID: 116, icon: "frostbolt" }] },
      playerDetails: { gear: [1, 2] },
    };
  });
  const replay = await logs.replay(code, "run", "sod", 409, {
    onProgress: (p) => progress.push(p.events),
  });
  assert.deepEqual(
    replay.events,
    [events[0], events[2], events[3]],
    "only the foreign raid's interval is removed",
  );
  assert.deepEqual(replay.actors, actors);
  assert.deepEqual(replay.playerDetails, { gear: [1, 2] });
  assert.equal(replay.gameVersion, "sod");
  assert.deepEqual(progress, [2, 4]);
  assert.deepEqual(requests.at(-1)?.fights, [1, 3]);
  assert.deepEqual(
    replay.fight.chapters.map((f: { id: number }) => f.id),
    [1, 3],
  );
});

test("event pagination cancels before the next page and rejects a stalled cursor", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectEvents(
      async () => {
        calls++;
        return { data: [{ timestamp: 1 }], nextPageTimestamp: 2 };
      },
      0,
      10,
      { signal: controller.signal, onProgress: () => controller.abort() },
    ),
    /abort/i,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    collectEvents(async () => ({ data: [], nextPageTimestamp: 0 }), 0, 10),
    /did not advance/,
  );
});

test("encounter import uses fight IDs and rejects invalid report/ruleset requests before fetching", async () => {
  let calls = 0;
  const logs = new BrowserLogs(async (query, variables) => {
    calls++;
    if (query.includes("visibility revision"))
      return {
        fights: [fight(4, "Molten Core", 10, 20, 1)],
        masterData: { actors: [] },
      };
    if (query.includes("events(")) {
      assert.match(query, /fightIDs:\[\$fight\]/);
      assert.equal(variables.fight, 4);
      return { events: { data: [], nextPageTimestamp: null } };
    }
    return {};
  });
  await assert.rejects(logs.replay("bad", 4), /valid/);
  await assert.rejects(logs.replay(code, 4, "retail"), /Unsupported/);
  assert.equal(calls, 0);
  assert.equal((await logs.replay(code, 4)).fight.id, 4);
  assert.equal(calls, 3);
});

test("discovery uses authenticated user and paginated guild reports without downloading events", async () => {
  const seen: {
    query: string;
    variables: Record<string, unknown>;
    version: string;
  }[] = [];
  const logs = new BrowserLogs(async (query, variables, version) => {
    seen.push({ query, variables, version });
    if (query.includes("currentUser"))
      return {
        userData: {
          currentUser: {
            id: 42,
            name: "Planner",
            guilds: [{ id: 775072, name: "Guild" }],
          },
        },
      };
    return {
      reportData: {
        reports: {
          data: [{ code, title: "MC" }],
          current_page: variables.page,
          has_more_pages: true,
        },
      },
    };
  });
  assert.equal((await logs.account("vanilla")).guilds[0].id, 775072);
  const page = await logs.reports(
    { guildID: 775072, page: 2, startTime: 100, endTime: 200 },
    "vanilla",
  );
  assert.equal(page.current_page, 2);
  assert.equal(page.has_more_pages, true);
  assert.equal(seen[1].variables.guildID, 775072);
  assert.equal(seen[1].variables.page, 2);
  assert.doesNotMatch(seen[1].query, /events\(|masterData/);
  await assert.rejects(logs.reports({ guildID: -2 }), /Invalid/);
  await assert.rejects(logs.reports({ page: 1 }), /Choose/);
  await assert.rejects(
    logs.reports({ userID: 42, startTime: 200, endTime: 100 }),
    /Invalid/,
  );
});

test("guild lookup resolves canonical identity from name, realm and region without fetching report events", async () => {
  const canonical = {
    id: 775072,
    name: "Guild",
    server: { name: "Firemaw", slug: "firemaw", region: { slug: "EU" } },
  };
  const logs = new BrowserLogs(async (query, variables, version) => {
    assert.equal(version, "sod");
    assert.match(query, /guildData/);
    assert.doesNotMatch(query, /events\(|reportData/);
    assert.deepEqual(variables, {
      name: "Guild",
      serverSlug: "firemaw",
      serverRegion: "eu",
    });
    return { guildData: { guild: canonical } };
  });
  assert.deepEqual(
    await logs.guild(
      { name: " Guild ", realm: " Firemaw ", region: "EU" },
      "sod",
    ),
    { ...canonical, server: { ...canonical.server, region: { slug: "eu" } } },
  );
  await assert.rejects(
    logs.guild({ name: "", realm: "Firemaw", region: "eu" }),
    /guild name/,
  );
  await assert.rejects(
    logs.guild({ name: "Guild", realm: "Firemaw", region: "bad" }),
    /region/,
  );
  await assert.rejects(
    new BrowserLogs(async () => ({ guildData: { guild: null } })).guild({
      name: "Missing",
      realm: "Firemaw",
      region: "eu",
    }),
    /Guild not found/,
  );
});
test("raid browsing sends WCL zone IDs to the server on every page, not client map IDs or page-local filters", async () => {
  const seen: any[] = [];
  const logs = new BrowserLogs(async (query, variables) => {
    seen.push({ query, variables });
    if (query.includes("worldData"))
      return {
        worldData: {
          zones: [
            { id: 2000, name: "Zul'Gurub" },
            { id: 1000, name: "Molten Core" },
          ],
        },
      };
    return {
      reportData: {
        reports: {
          data: [],
          current_page: variables.page,
          has_more_pages: false,
        },
      },
    };
  });
  assert.equal((await logs.zones())[0].id, 1000);
  await logs.reports({ guildID: 1, zoneID: 1000, startTime: 100, page: 2 });
  assert.match(seen[1].query, /zoneID:\$zoneID/);
  assert.deepEqual(seen[1].variables, {
    guildID: 1,
    zoneID: 1000,
    startTime: 100,
    page: 2,
  });
  await assert.rejects(logs.reports({ guildID: 1, zoneID: 0 }), /Invalid/);
  await assert.rejects(
    new BrowserLogs(async () => ({
      worldData: { zones: [{ id: -1, name: "Invalid" }] },
    })).zones(),
    /raid filters/,
  );
});

test("shared Era/SoD raid catalogue keeps identically named raids separate using season metadata", async () => {
  const logs = new BrowserLogs(async () => ({
    worldData: {
      zones: [
        {
          id: 2012,
          name: "Molten Core",
          partitions: [{ name: "Discovery P8" }],
        },
        {
          id: 2000,
          name: "Molten Core",
          partitions: [{ name: "S0" }, { name: "Hardcore" }],
        },
        {
          id: 2018,
          name: "Scarlet Enclave",
          partitions: [{ name: "Discovery P8" }],
        },
      ],
    },
  }));
  assert.deepEqual(await logs.zones("vanilla"), [
    { id: 2000, name: "Molten Core" },
  ]);
  assert.deepEqual(await logs.zones("sod"), [
    { id: 2012, name: "Molten Core" },
    { id: 2018, name: "Scarlet Enclave" },
  ]);
});

test("realm dropdown loads all regional pages, separates seasons and caches each version/region", async () => {
  const calls: any[] = [];
  const logs = new BrowserLogs(async (query, variables, version, signal) => {
    calls.push({ query, variables, version, signal });
    if (query.includes("regions{"))
      return {
        worldData: {
          regions: [
            { id: 2, slug: "EU" },
            { id: 1, slug: "US" },
          ],
        },
      };
    return {
      worldData: {
        region: {
          servers: {
            data:
              variables.page === 1
                ? [
                    { id: 10, name: "Zandalar", slug: "zandalar", seasonID: 0 },
                    {
                      id: 20,
                      name: "Wild Growth",
                      slug: "wild-growth",
                      seasonID: 3,
                    },
                  ]
                : [
                    {
                      id: 30,
                      name: "Soulseeker",
                      slug: "soulseeker",
                      seasonID: 6,
                    },
                  ],
            current_page: variables.page,
            has_more_pages: variables.page === 1,
          },
        },
      },
    };
  });
  const era = await logs.realms("EU");
  assert.deepEqual(
    era.map((r) => r.slug),
    ["soulseeker", "zandalar"],
  );
  assert.equal(calls[1].variables.region, 2);
  assert.equal(calls[2].variables.page, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(await logs.realms("eu"), era);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    (await logs.realms("eu", "sod")).map((r) => r.slug),
    ["wild-growth"],
  );
  assert.equal(calls.length, 6);
  await logs.realms("us");
  assert.equal(calls[7].variables.region, 1);
  await assert.rejects(logs.realms("invalid"), /valid region/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(logs.realms("eu", "vanilla", ac.signal));
});

test("realm lookup errors remain retryable instead of caching partial lists", async () => {
  let fail = true;
  const logs = new BrowserLogs(async (query) => {
    if (query.includes("regions{"))
      return { worldData: { regions: [{ id: 2, slug: "EU" }] } };
    if (fail) throw new Error("network unavailable");
    return {
      worldData: {
        region: {
          servers: { data: [], current_page: 1, has_more_pages: false },
        },
      },
    };
  });
  await assert.rejects(logs.realms("eu"), /network unavailable/);
  fail = false;
  assert.deepEqual(await logs.realms("eu"), []);
  await assert.rejects(logs.realms("kr"), /unavailable/);
});

test("buffered replay header retains all encounter boundaries without requesting events", async () => {
  const queries: string[] = [];
  const logs = new BrowserLogs(async (query) => {
    queries.push(query);
    if (query.includes("playerDetails"))
      return {
        playerDetails: {},
        masterData: {
          actors: [{ id: 1, type: "Player", subType: "Mage" }],
          abilities: [],
        },
      };
    return {
      title: "Run",
      revision: 2,
      segments: 1,
      endTime: 1000000,
      fights: [
        fight(1, "Molten Core", 100, 1000, 1),
        fight(2, "Molten Core", 900000, 950000, 1),
      ],
      masterData: { actors: [] },
    };
  });
  const raw = await logs.replayHeader(code, "run", "vanilla", 409);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((q) => !q.includes("events(")));
  assert.equal((raw.fight as any).chapters.length, 2);
  assert.equal(raw.fight.endTime, 950000);
  assert.deepEqual(raw.events, []);
  assert.equal(raw.stream?.revision, 2);
});
test("buffered ranges preserve pagination and resources while sparse state filters exclude damage history", async () => {
  const calls: any[] = [];
  const logs = new BrowserLogs(async (query, variables) => {
    calls.push({ query, variables });
    if (calls.length === 1)
      return { events: { data: [], nextPageTimestamp: 1200 } };
    return {
      events: {
        data: [
          { timestamp: 1300, type: "cast" },
          { timestamp: 6000, type: "cast" },
        ],
        nextPageTimestamp: null,
      },
    };
  });
  const raw = {
    report: { code, title: "Run" },
    gameVersion: "vanilla",
    fight: { id: 4, startTime: 1000, endTime: 5000 },
    events: [],
  } as any;
  const events = await logs.replayRange(raw, 0, 2000, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, 1300);
  assert.equal(calls[0].variables.start, 1000);
  assert.equal(calls[0].variables.end, 3000);
  assert.equal(calls[1].variables.start, 1200);
  assert.equal(calls[0].variables.fight, 4);
  assert.match(calls[0].query, /includeResources:true/);
  assert.match(calls[0].variables.filter, /applybuff/);
  assert.match(calls[0].variables.filter, /zonechange/);
  assert.doesNotMatch(calls[0].variables.filter, /damage|heal/);
});
test("changed report revisions block adding new sections to a saved run", async () => {
  const logs = new BrowserLogs(async () => ({
    revision: 3,
    segments: 1,
    endTime: 5000,
  }));
  await assert.rejects(
    logs.verifyReplayRevision({
      report: { code },
      stream: { revision: 2, segments: 1, reportEnd: 5000 },
    } as any),
    /report has changed/,
  );
});
