import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EditorController } from "./controller";
import { Toolbox } from "./Toolbox";
import {
  defaultRangeCheck,
  rangeCircles,
  rangeMatches,
  rangePlayerRole,
  type RangePose,
  type RangeSettings,
} from "./range-check";
import type { Actor, Replay } from "./types";

const player = (id: number, cls = "Mage") =>
  ({
    id,
    key: `${id}:1`,
    type: "Player",
    class: cls,
    name: `Player ${id}`,
  }) as Actor;
const players = [
  player(1),
  player(2, "Warrior"),
  player(3, "Druid"),
  player(4, "Shaman"),
  player(5, "Priest"),
];
function replay() {
  return {
    gameVersion: "sod",
    actors: players,
    fight: { friendlyPlayers: players.map((a) => a.id) },
    raw: {
      playerDetails: {
        data: {
          playerDetails: {
            dps: [
              { id: 1, specs: [{ spec: "Frost" }] },
              { id: 3, specs: [{ spec: "Feral" }] },
              { id: 4, specs: [{ spec: "Elemental" }] },
            ],
            tanks: [{ id: 2 }],
            healers: [{ id: 5 }],
          },
        },
      },
    },
  } as unknown as Replay;
}
const settings: RangeSettings = {
  ...defaultRangeCheck,
  enabled: true,
  radius: 10,
  players: [],
};
const pose = (x: number, y = 0, z: number | null = 0): RangePose => ({
  pos: [x, y, z],
  dead: false,
  estimated: false,
  wisp: false,
});
test("presets use recorded roles and hybrid specs, including SoD healer mages", () => {
  const run = replay();
  const select = (group: RangeSettings["group"]) =>
    players
      .filter((a) => rangeMatches(run, a, { ...settings, group }))
      .map((a) => a.id);
  assert.deepEqual(select("all"), [1, 2, 3, 4, 5]);
  assert.deepEqual(select("ranged"), [1, 4]);
  assert.deepEqual(select("melee"), [3]);
  assert.deepEqual(select("dps"), [1, 3, 4]);
  assert.deepEqual(select("tanks"), [2]);
  assert.deepEqual(select("healers"), [5]);
  run.raw.playerDetails.data.playerDetails.healers.push({ id: 1 });
  assert.equal(rangePlayerRole(run, players[0]).role, "dps"); // same immutable snapshot
  run.raw.playerDetails = structuredClone(run.raw.playerDetails);
  assert.equal(rangePlayerRole(run, players[0]).role, "healers");
});
test("unrecorded roles do not turn hybrid players or SoD mages into invented DPS", () => {
  const run = replay();
  run.raw.playerDetails = null;
  for (const actor of players)
    assert.equal(rangePlayerRole(run, actor).role, "unknown");
  run.gameVersion = "vanilla";
  assert.equal(rangePlayerRole(run, players[0]).role, "dps");
  assert.equal(rangePlayerRole(run, players[1]).role, "unknown");
});
test("individual circles still detect unselected players and compare radius rather than overlapping diameters", () => {
  const run = replay();
  const custom = {
    ...settings,
    group: "individuals" as const,
    players: ["1:1"],
  };
  let distance = 10;
  const result = () =>
    rangeCircles(run, custom, (a) =>
      a.id === 1 ? pose(0) : a.id === 2 ? pose(distance) : null,
    );
  assert.equal(result().length, 1);
  assert.equal(result()[0].status, "crowded");
  assert.equal(result()[0].nearby, 1);
  distance = 10.001;
  assert.equal(result()[0].status, "clear");
  distance = 15;
  assert.equal(result()[0].status, "clear");
});
test("self, dead, pets, enemies and foreign players never trigger a warning", () => {
  const run = replay();
  run.actors = [
    players[0],
    { ...players[0], key: "1:2" },
    { ...players[1], type: "Pet" },
    { ...players[2], type: "NPC" },
    player(99),
    players[4],
  ];
  const rings = rangeCircles(run, settings, (a) => ({
    ...pose(0),
    dead: a.id === 5,
  }));
  assert.equal(rings.length, 2);
  assert.ok(rings.every((r) => r.status === "clear"));
});
test("known height separates floors while missing altitude can use recorded horizontal distance", () => {
  const run = replay();
  run.actors = players.slice(0, 2);
  let z: number | null = 11;
  const rings = () =>
    rangeCircles(run, settings, (a) => (a.id === 1 ? pose(0) : pose(0, 0, z)));
  assert.equal(rings()[0].status, "clear");
  z = null;
  assert.equal(rings()[0].status, "crowded");
});
test("estimated and wisp positions use the same red/green range check as displayed players", () => {
  const run = replay();
  run.actors = players.slice(0, 2);
  const rings = rangeCircles(run, settings, (a) => ({
    ...pose(a.id),
    wisp: a.id === 2,
  }));
  assert.ok(rings.every((r) => r.status === "crowded"));
  const separated = rangeCircles(run, settings, (a) => ({
    ...pose(a.id * 20),
    estimated: true,
    wisp: true,
  }));
  assert.ok(separated.every((r) => r.status === "clear"));
  const missing = rangeCircles(run, settings, (a) =>
    a.id === 1 ? pose(NaN) : null,
  );
  assert.deepEqual(missing, []);
});
test("disabled and invalid ranges produce no geometry; radius is safely bounded", () => {
  assert.deepEqual(
    rangeCircles(replay(), defaultRangeCheck, () => pose(0)),
    [],
  );
  assert.deepEqual(
    rangeCircles(replay(), { ...settings, radius: NaN }, () => pose(0)),
    [],
  );
  assert.equal(
    rangeCircles(replay(), { ...settings, radius: 1000 }, () => pose(0))[0]
      .radius,
    100,
  );
});
test("sidebar exposes range controls only in Analyse, and changes do not dirty the plan", () => {
  const controller = new EditorController();
  const plan = controller.getSnapshot().plan;
  controller.setRangeCheck({ enabled: true, radius: 20, group: "individuals" });
  assert.equal(controller.getSnapshot().plan, plan);
  assert.equal(controller.getSnapshot().dirty, false);
  const html = () =>
    renderToString(
      createElement(Toolbox, {
        state: controller.getSnapshot(),
        controller,
        open: [],
        onOpen() {},
        onClose() {},
      }),
    );
  assert.match(html(), /Range radius in yards/);
  assert.match(html(), /Players with range circles/);
  assert.match(html(), /Ranged DPS/);
  controller.setWorkspaceMode("plan");
  assert.doesNotMatch(html(), /Range radius in yards/);
  assert.deepEqual(controller.rangeCheckCircles(), []);
  controller.stop();
});
