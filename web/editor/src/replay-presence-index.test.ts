import test from "node:test";
import assert from "node:assert/strict";
import { ReplayPresenceIndex } from "./replay-presence-index";
import { poseAt } from "./domain";
import type { Actor } from "./types";
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
