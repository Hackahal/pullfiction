import test from "node:test";
import assert from "node:assert/strict";
import { replayFloorHints } from "./floor-model";
import type { Actor, Replay } from "./types";
const npc = (
  id: number,
  entry: number,
  x: number,
  y: number,
  first = 0,
  last = 1000,
) =>
  ({
    id,
    gameID: entry,
    key: `${id}:1`,
    type: "NPC",
    firstSeen: first,
    lastSeen: last,
    samples: [[first, x, y, null]],
    deaths: [],
    headings: [],
  }) as unknown as Actor;
const player = { ...npc(1, 0, -7435, -1049), type: "Player" } as Actor;
test("chapter enemies distinguish overlapping BWL floors even on a direct seek", () => {
  const lower = npc(2, 12435, -7435, -1049, 0, 100),
    upper = npc(3, 14020, -7435, -1049, 900);
  const replay = {
    map: 469,
    actors: [player, lower, upper],
    chapters: [
      { start: 0, end: 100, enemyNPCs: [{ id: 2 }] },
      { start: 900, end: 1000, enemyNPCs: [{ id: 3 }] },
    ],
  } as Replay;
  const catalog = {
    12435: { floorSeeds: [[469, -7435, -1049, 413]] },
    14020: { floorSeeds: [[469, -7435, -1049, 477]] },
  };
  assert.equal(replayFloorHints(replay, 50, catalog).get(player.key), 413);
  assert.equal(replayFloorHints(replay, 950, catalog).get(player.key), 477);
  assert.equal(replayFloorHints(replay, 50, catalog).get(player.key), 413);
});
test("NPC instances use their first observation and never borrow another map's spawn", () => {
  const actor = npc(2, 100, 10, 20);
  const replay = {
    map: 531,
    actors: [actor],
    chapters: [],
  } as unknown as Replay;
  const catalog = {
    100: {
      floorSeeds: [
        [469, 10, 20, 477],
        [531, 10, 20, -98],
        [531, 1000, 1000, 100],
      ],
    },
  };
  assert.equal(replayFloorHints(replay, 0, catalog).get(actor.key), -98);
  assert.equal(replayFloorHints(replay, 0, {}).get(actor.key), undefined);
});
test("unknown entries use nearby level seeds, distant actors remain unresolved", () => {
  const actor = npc(2, 999, 0, 0),
    far = npc(3, 999, 1000, 1000);
  const replay = {
    map: 531,
    actors: [actor, far],
    chapters: [],
  } as unknown as Replay;
  const hints = replayFloorHints(replay, 0, {
    100: { floorSeeds: [[531, 1, 1, 100]] },
  });
  assert.equal(hints.get(actor.key), 100);
  assert.equal(hints.get(far.key), undefined);
});
