import test from "node:test";
import assert from "node:assert/strict";
import { ReplayPresenceIndex } from "./replay-presence-index";
import { normalizeReplay, poseAt } from "./domain";
import type { Actor, RawReplay } from "./types";
test("presence candidates preserve every live pose at spawn, lifetime and death boundaries", () => {
  const base = {
    type: "NPC",
    samples: [
      [100, 1, 2, null],
      [200, 2, 3, null],
    ],
    deaths: [],
    casts: [],
    activity: [],
    headings: [],
  };
  const actors = [
    {
      ...base,
      key: "observed",
      deaths: [
        [180, true],
        [240, false],
        [400, true],
      ],
    },
    {
      ...base,
      key: "spawn",
      spawn: { visibleFrom: 50, position: [1, 2, 3], facing: 0 },
    },
    {
      ...base,
      key: "bounded",
      runLifetime: true,
      firstSeen: 100,
      lastSeen: 300,
    },
    { ...base, key: "pet", type: "Pet" },
    { ...base, key: "empty", samples: [] },
    { ...base, key: "player", type: "Player" },
  ] as unknown as Actor[];
  const index = new ReplayPresenceIndex(actors);
  for (const time of [
    -10, 0, 49, 50, 99, 100, 179, 180, 200, 240, 399, 400, 3300, 3300.001, 5000,
  ]) {
    const candidates = index.at(time);
    for (const actor of actors) {
      const pose = poseAt(actor, time, true);
      if (actor.type === "Player" || (pose && !pose.dead))
        assert.ok(candidates.has(actor.key), `${actor.key} at ${time}`);
    }
    if (time >= 400) assert.equal(candidates.has("observed"), false);
  }
});

test("recorded summon and destroy bound held run pets without an activity timeout", () => {
  const raw = {
    report: { code: "presence" },
    fight: {
      startTime: 0,
      endTime: 20000,
      gameZone: { id: 409 },
      friendlyPlayers: [1],
      chapters: [{ id: 1, startTime: 0, endTime: 20000 }],
    },
    actors: [
      { id: 1, type: "Player", name: "P" },
      { id: 2, type: "Pet", name: "Pet", petOwner: 1 },
    ],
    events: [
      { timestamp: 1000, type: "summon", sourceID: 1, targetID: 2 },
      {
        timestamp: 1100,
        type: "damage",
        sourceID: 2,
        targetID: 1,
        resourceActor: 1,
        x: 100,
        y: 200,
      },
      { timestamp: 12000, type: "destroy", targetID: 2 },
      { timestamp: 15000, type: "create", targetID: 2 },
    ],
  };
  for (const events of [
    raw.events,
    raw.events.filter((e) => e.type !== "destroy" && e.type !== "create"),
  ]) {
    const pet = normalizeReplay(
      { ...raw, events } as unknown as RawReplay,
      {},
    ).actors.find((a) => a.id === 2)!;
    const index = new ReplayPresenceIndex([pet]);
    assert.equal(pet.runLifetime, true);
    assert.ok(poseAt(pet, 10000));
    assert.ok(index.at(10000).has(pet.key));
    for (const time of [11999, 12000, 14000, 15000, 19000, 1100, 10000]) {
      assert.equal(
        index.at(time).has(pet.key),
        !!poseAt(pet, time),
        `at ${time}`,
      );
    }
    assert.ok(index.between(10000, 11999).has(pet.key));
    if (events === raw.events) {
      assert.equal(index.at(12000).has(pet.key), false);
      assert.equal(index.between(12000, 14999).has(pet.key), false);
      assert.ok(index.at(15000).has(pet.key));
    }
  }
});
