import test from "node:test";
import assert from "node:assert/strict";
import {
  indexEvents,
  queryEvents,
  summarize,
  graphBuckets,
  deathRecap,
  type Query,
} from "./analysis-model";
import type { Replay } from "./types";
const replay = {
  fight: { startTime: 1000, friendlyPlayers: [1] },
  duration: 3000,
  actors: [
    { id: 1, key: "1:1", name: "Mage", type: "Player" },
    { id: 2, key: "2:1", name: "Boss", type: "NPC" },
    { id: 3, key: "3:1", name: "Pet", type: "Pet", owner: 1 },
  ],
  abilities: new Map([[133, { name: "Fireball" }]]),
  raw: {
    events: [
      {
        timestamp: 2000,
        type: "damage",
        sourceID: 1,
        targetID: 2,
        abilityGameID: 133,
        amount: 100,
        hitType: 2,
      },
      {
        timestamp: 3000,
        type: "damage",
        sourceID: 3,
        targetID: 2,
        abilityGameID: 133,
        amount: 40,
      },
      {
        timestamp: 2500,
        type: "damage",
        sourceID: 2,
        targetID: 1,
        abilityGameID: 133,
        amount: 70,
      },
      {
        timestamp: 3200,
        type: "heal",
        sourceID: 1,
        targetID: 1,
        abilityGameID: 133,
        amount: 20,
        overheal: 80,
      },
      { timestamp: 3500, type: "death", targetID: 1 },
      {
        timestamp: 4000,
        type: "applybuff",
        sourceID: 1,
        targetID: 1,
        abilityGameID: 133,
      },
      {
        timestamp: 4000,
        type: "applydebuff",
        sourceID: 1,
        targetID: 2,
        abilityGameID: 133,
      },
    ],
  },
} as unknown as Replay;
const events = indexEvents(replay);
const q: Query = {
  metric: "damage",
  source: "*",
  target: "*",
  spell: "*",
  pets: true,
  start: 0,
  end: 3000,
};
test("Analysis filters actor instances, pets, target and precise time endpoints", () => {
  assert.equal(queryEvents(events, q, replay).length, 2);
  assert.equal(queryEvents(events, { ...q, pets: false }, replay).length, 1);
  assert.equal(
    queryEvents(events, { ...q, start: 2000, end: 2000 }, replay)[0].amount,
    40,
  );
  assert.equal(queryEvents(events, { ...q, target: "1:1" }, replay).length, 0);
  assert.equal(queryEvents(events, { ...q, source: "3:1" }, replay).length, 1);
});
test("Reverse seeks remove future events and damage taken/deaths use the victim", () => {
  assert.equal(queryEvents(events, { ...q, end: 999 }, replay).length, 0);
  assert.equal(
    queryEvents(events, { ...q, metric: "taken" }, replay)[0].amount,
    70,
  );
  assert.equal(
    queryEvents(events, { ...q, metric: "death" }, replay).length,
    1,
  );
});
test("Tables preserve effective healing and separate overheal; buff changes exclude debuffs", () => {
  const r = summarize(
    queryEvents(events, { ...q, metric: "heal" }, replay),
    "heal",
    "spell",
    replay,
  )[0];
  assert.equal(r.total, 20);
  assert.equal(r.overheal, 80);
  assert.equal(queryEvents(events, { ...q, metric: "buff" }, replay).length, 1);
  assert.equal(
    queryEvents(events, { ...q, metric: "debuff", source: "2:1" }, replay)
      .length,
    1,
  );
  const totals = summarize(
    queryEvents(events, q, replay),
    "damage",
    "spell",
    replay,
  );
  assert.equal(totals[0].total, 140);
  assert.equal(totals[0].crit, 1);
});
test("Rate graph buckets preserve aggregate amounts across the range", () => {
  const b = graphBuckets(queryEvents(events, q, replay), 0, 3000, "damage");
  assert.ok(Math.abs(b.reduce((s, v) => s + v, 0) * 0.03 - 140) < 0.0001);
});

test("Aura changes belong to the affected player and group their source correctly", () => {
  const a = queryEvents(events, { ...q, metric: "buff" }, replay);
  assert.equal(summarize(a, "buff", "actor", replay)[0].actor, "1:1");
  assert.equal(
    queryEvents(events, { ...q, metric: "debuff" }, replay).length,
    0,
  );
  assert.equal(
    queryEvents(
      events,
      { ...q, metric: "debuff", source: "2:1", target: "1:1" },
      replay,
    ).length,
    1,
  );
});

test("DPS meter uses player class colour and inherits pet owner colour", async () => {
  const { meterColor } = await import("./analysis-model");
  const r = {
    ...replay,
    actors: replay.actors.map((a) =>
      a.id === 1 ? { ...a, class: "Mage" } : a,
    ),
  };
  assert.equal(meterColor(r, "1:1"), "#69ccf0");
  assert.equal(meterColor(r, "3:1"), "#69ccf0");
  assert.equal(meterColor(r, "2:1"), "#c9a65b");
});

test("Pet merging credits owners without changing totals or ability breakdowns", () => {
  const all = queryEvents(events, q, replay);
  const merged = summarize(all, "damage", "actor", replay, true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].actor, "1:1");
  assert.equal(merged[0].total, 140);
  assert.equal(summarize(all, "damage", "actor", replay, false).length, 2);
  assert.equal(queryEvents(events, { ...q, source: "1:1" }, replay).length, 2);
  assert.equal(
    queryEvents(events, { ...q, source: "1:1", pets: false }, replay).length,
    1,
  );
  assert.equal(
    queryEvents(
      events,
      { ...q, source: "1:1", ownerPets: false },
      replay,
    ).reduce((n, e) => n + e.amount, 0),
    100,
  );
});

test("Victim metrics retain pet identity and never credit pet deaths to owners", () => {
  const petDeath = {
    ...events.find((e) => e.kind === "death")!,
    target: "3:1",
  };
  const deaths = [events.find((e) => e.kind === "death")!, petDeath];
  assert.equal(
    queryEvents(deaths, { ...q, metric: "death", source: "1:1" }, replay)
      .length,
    1,
  );
  const rows = summarize(deaths, "death", "actor", replay, true);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.actor === "1:1")!.total, 1);
  assert.equal(
    queryEvents(deaths, { ...q, metric: "death", pets: false }, replay).length,
    1,
  );
});

test("Feign Death is an action, not a death; real deaths retain killing-blow metadata", () => {
  const local = {
    ...replay,
    raw: {
      ...replay.raw,
      events: [
        { timestamp: 2000, type: "death", targetID: 1, feign: true },
        {
          timestamp: 2500,
          type: "death",
          sourceID: -1,
          targetID: 1,
          killerID: 2,
          killingAbilityGameID: 133,
        },
      ],
    },
  } as Replay;
  const indexed = indexEvents(local),
    deaths = queryEvents(
      indexed,
      { ...q, metric: "death", pets: false },
      local,
    );
  assert.equal(indexed[0].kind, "feigndeath");
  assert.equal(deaths.length, 1);
  assert.equal(deaths[0].source, "2:1");
  assert.equal(deaths[0].name, "Fireball");
  assert.equal((local.raw.events[0] as { feign: boolean }).feign, true);
});
test("Overall filtering excludes downtime and includes interval endpoints once", () => {
  assert.equal(
    queryEvents(events, { ...q, intervals: [[0, 1500]] }, replay).reduce(
      (n, e) => n + e.amount,
      0,
    ),
    100,
  );
  assert.equal(
    queryEvents(
      events,
      {
        ...q,
        intervals: [
          [0, 2000],
          [2000, 3000],
        ],
      },
      replay,
    ).length,
    2,
  );
  assert.equal(queryEvents(events, { ...q, intervals: [] }, replay).length, 0);
});
test("Event index is shared and invalidates after streamed data is appended", () => {
  const local = {
    ...replay,
    raw: { ...replay.raw, events: [...replay.raw.events] },
  } as Replay;
  const first = indexEvents(local);
  assert.equal(indexEvents(local), first);
  local.raw.events.push({
    timestamp: 3900,
    type: "damage",
    sourceID: 1,
    targetID: 2,
    amount: 8,
  } as never);
  assert.notEqual(indexEvents(local), first);
  assert.equal(indexEvents(local).length, first.length + 1);
});
test("Death recap includes only the victim's recorded damage/healing before death", () => {
  const death = events.find((e) => e.kind === "death")!;
  assert.deepEqual(
    deathRecap(events, death).map((e) => e.kind),
    ["damage", "heal", "death"],
  );
  assert.ok(deathRecap(events, death).every((e) => e.t <= death.t));
});
