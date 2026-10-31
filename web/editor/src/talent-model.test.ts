import test from "node:test";
import assert from "node:assert/strict";
import { classTalentTrees, recordedTalents } from "./talent-model";
import type { TalentCatalog } from "./local-talents";
import type { Actor, Replay } from "./types";
const player = { id: 1 } as Actor;
test("Partial talent metadata preserves canonical tree order and point totals", () => {
  const catalog = {
    trees: [{ id: 42, classId: 8, name: "Fire", order: 1, nodes: [] }],
  } as unknown as TalentCatalog;
  const trees = classTalentTrees(catalog, 8),
    points = [31, 20, 0];
  assert.equal(trees[0], undefined);
  assert.equal(trees[1]?.name, "Fire");
  assert.equal(trees[2], undefined);
  assert.equal(points[trees[1]!.order], 20);
});
function replay(events: unknown[]) {
  return {
    duration: 10000,
    raw: { fight: { startTime: 1000 }, events },
  } as Replay;
}
test("Classic three-tree totals are never interpreted as learned talent IDs", () => {
  const r = replay([
    {
      type: "combatantinfo",
      sourceID: 1,
      timestamp: 1000,
      talents: [{ id: 31 }, { id: 20 }, { id: 0 }],
      talentTree: [],
    },
  ]);
  const actual = recordedTalents(r, player, 2000)!;
  assert.deepEqual(actual.points, [31, 20, 0]);
  assert.deepEqual(actual.allocations, []);
});
test("Talent snapshots rewind and never borrow a future build", () => {
  const r = replay([
    {
      type: "combatantinfo",
      sourceID: 1,
      timestamp: 2000,
      talents: [{ id: 31 }, { id: 20 }, { id: 0 }],
    },
    {
      type: "combatantinfo",
      sourceID: 1,
      timestamp: 6000,
      talents: [{ id: 0 }, { id: 31 }, { id: 20 }],
    },
  ]);
  assert.equal(recordedTalents(r, player, 999), null);
  assert.deepEqual(recordedTalents(r, player, 5000)?.points, [0, 31, 20]);
  assert.deepEqual(recordedTalents(r, player, 2000)?.points, [31, 20, 0]);
});
test("Only explicit talent or spell identities supply node ranks", () => {
  const r = replay([
    {
      type: "combatantinfo",
      sourceID: 1,
      timestamp: 1000,
      talentTree: [
        { id: 123, rank: 5 },
        { talentID: 124, rank: 3 },
        { spellID: 125, rank: 1 },
        null,
        { talentID: 126, rank: -1 },
      ],
      talents: [null, 1, 2],
    },
  ]);
  assert.deepEqual(recordedTalents(r, player, 0)?.allocations, [
    { talentId: 124, rank: 3 },
    { spellId: 125, rank: 1 },
  ]);
});
test("A later player-details header invalidates an earlier absent build", () => {
  const r = replay([]);
  assert.equal(recordedTalents(r, player, 0), null);
  r.raw.playerDetails = {
    data: {
      playerDetails: {
        Warrior: [
          {
            id: 1,
            combatantInfo: { talents: [{ id: 31 }, { id: 20 }, { id: 0 }] },
          },
        ],
      },
    },
  };
  assert.deepEqual(recordedTalents(r, player, 0)?.points, [31, 20, 0]);
});
