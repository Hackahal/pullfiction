import { ReplayFloorGeometry } from "./replay-floor-geometry";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorController } from "./controller";
import type { Engine, NativeFrame, RawReplay } from "./types";
import { STORAGE_KEY } from "./domain";
import luaparse from "luaparse";
import { IDBFactory } from "fake-indexeddb";
import { IndexedProjectStore, newProject, replaySource } from "./project-store";
import { emptyPlan, parsePlan } from "./domain";
const raw = {
  report: { code: "DyN7vF94QR8aj1Lc", title: "Run" },
  fight: {
    id: 1,
    name: "Lucifron",
    startTime: 1000,
    endTime: 12000,
    gameZone: { name: "Molten Core" },
    friendlyPlayers: [1],
  },
  actors: [
    { id: 1, name: "Mage", type: "Player", subType: "Mage" },
    { id: 2, name: "Lucifron", type: "NPC", gameID: 12118 },
  ],
  abilities: [
    { gameID: 133, name: "Fireball", icon: "spell_fire_flamebolt.jpg" },
  ],
  events: [
    { timestamp: 1000, type: "combatantinfo", sourceID: 1, auras: [] },
    {
      timestamp: 2000,
      type: "damage",
      sourceID: 1,
      targetID: 2,
      resourceActor: 1,
      x: 100,
      y: 200,
      facing: -470,
      classResources: [{ type: 3, amount: 60, max: 100 }],
      hitPoints: 100,
      maxHitPoints: 100,
      abilityGameID: 133,
      amount: 2,
    },
    {
      timestamp: 5000,
      type: "damage",
      sourceID: 1,
      targetID: 2,
      resourceActor: 2,
      x: 200,
      y: 300,
      facing: -470,
      hitPoints: 800,
      maxHitPoints: 1000,
      abilityGameID: 133,
      amount: 200,
    },
    { timestamp: 5500, type: "begincast", sourceID: 1, abilityGameID: 133 },
    {
      timestamp: 6500,
      type: "cast",
      sourceID: 1,
      targetID: 2,
      abilityGameID: 133,
    },
    {
      timestamp: 7000,
      type: "applybuff",
      targetID: 1,
      sourceID: 1,
      abilityGameID: 133,
    },
    { timestamp: 10000, type: "death", targetID: 2 },
  ],
} as unknown as RawReplay;
function fixture() {
  let frame: NativeFrame[] = [],
    events: { reset: boolean; data: unknown[] }[] = [],
    focus: number[][] = [],
    cameraSubjects: string[][] = [],
    cameraSettings: [number, string][] = [],
    maps: number[] = [],
    mapPicks: number[][] = [],
    selected = "";
  const memory = new Map<string, string>();
  const c = new EditorController({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  });
  const annotations: { marks: { id: string }[] }[] = [];
  const engine = {
    load_raid: (map: number) => maps.push(map),
    pick: () => {},
    set_typing: () => {},
    pick_map: (...point: number[]) => mapPicks.push(point),
    set_replay_frame: (json: string) => {
      frame = JSON.parse(json);
    },
    replay_events: (json: string, reset: boolean) =>
      events.push({ reset, data: JSON.parse(json) }),
    set_annotations: (json: string) => {
      annotations.push(JSON.parse(json));
    },
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    select_replay: (key: string) => {
      selected = key;
    },
    focus_replay: (...at: number[]) => focus.push(at),
    set_replay_camera: (json: string) => cameraSubjects.push(JSON.parse(json)),
    configure_replay_camera: (distance: number, player: string) =>
      cameraSettings.push([distance, player]),
  } as unknown as Engine;
  c.attachEngine(engine);
  c.installReplay(raw);
  return {
    c,
    engine,
    memory,
    get frame() {
      return frame;
    },
    events,
    annotations,
    maps,
    mapPicks,
    focus,
    cameraSubjects,
    cameraSettings,
    get selected() {
      return selected;
    },
  };
}
test("Route waypoints commit on clicks while hover is preview-only and the whole path has one undo", () => {
  const f = fixture();
  f.c.setWorkspaceMode("plan");
  f.c.setTool("route");
  f.c.pickMap(0, 0, 3, false, false, true);
  f.c.pickMap(4, 5, 3, false, true, true);
  f.c.pickMap(8, 7, 3, false, true, true);
  let annotation = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.deepEqual(annotation.points, [[0, 0, 3]]);
  assert.deepEqual(f.c.displayMarks()[0].points, [
    [0, 0, 3],
    [8, 7, 3],
  ]);
  f.c.pickMap(10, 5, 3, false, false, true);
  f.c.pickMap(15, 12, 3, false, true, true);
  f.c.pickMap(20, 10, 3, false, false, true);
  annotation = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.deepEqual(annotation.points, [
    [0, 0, 3],
    [10, 5, 3],
    [20, 10, 3],
  ]);
  f.c.finishDrawing();
  assert.equal(f.c.getSnapshot().drawing, false);
  assert.deepEqual(f.c.displayMarks()[0].points, annotation.points);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  f.c.stop();
});
test("Frame ignores a hidden Plan selection in Analyse and recovers without selection", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setWorkspaceMode("plan");
  f.c.setTool("marker");
  f.c.pickMap(900, 950, 3, false, false, true);
  assert.ok(f.c.getSnapshot().selectedMarks.length);
  f.c.setWorkspaceMode("analyse");
  f.c.select(f.c.getSnapshot().replay!.actors[0].key);
  f.c.frameSelection();
  assert.notDeepEqual(f.focus.at(-1), [900, 950, 3]);
  const pose = f.c.actorPose(f.c.getSnapshot().replay!.actors[0])!;
  assert.deepEqual(f.focus.at(-1)!.slice(0, 2), pose.pos.slice(0, 2));
  const count = f.focus.length;
  f.c.select(null);
  f.c.frameSelection();
  assert.equal(f.focus.length, count + 1);
  f.c.stop();
});
test("Frame returns a source-free scene to its map entrance when nothing is selected", () => {
  const f = fixture();
  let homes = 0;
  const c = new EditorController();
  c.attachEngine({ ...f.engine, home: () => homes++ });
  c.frameSelection();
  assert.equal(homes, 1);
  c.stop();
  f.c.stop();
});
test("Camera selector and status share the same Follow raid, player and Free camera state", () => {
  const f = fixture();
  f.c.setCameraMode("free");
  f.c.setOption("followRaid", true);
  assert.deepEqual(f.c.cameraPresentation(), {
    value: "raid",
    label: "Follow raid",
  });
  f.c.select(f.c.getSnapshot().replay!.actors[0].key);
  f.c.setOption("lockCamera", true);
  assert.equal(f.c.cameraPresentation().value, "player");
  assert.equal(f.c.cameraPresentation(true).label, "Follow raid");
  f.c.setOption("followRaid", false);
  assert.deepEqual(f.c.cameraPresentation(), {
    value: "free",
    label: "Free camera",
  });
  f.c.stop();
});
test("Character inspection sends baseline appearance independently of the world frame and rejects stale images", () => {
  const f = fixture(),
    requests: any[] = [];
  f.engine.request_actor_inspection = (json) => requests.push(JSON.parse(json));
  let closed = 0;
  f.engine.close_actor_inspection = () => closed++;
  const key = f.c.getSnapshot().replay!.actors[0].key,
    before = JSON.stringify(f.frame);
  const first = f.c.requestActorInspection(key, 0),
    second = f.c.requestActorInspection(key, 0.3);
  assert.equal(requests[1].unit.key, key);
  assert.equal(requests[1].unit.player, true);
  assert.equal(requests[1].unit.wisp, false);
  assert.equal(requests[1].yaw, 0.3);
  assert.equal(JSON.stringify(f.frame), before);
  f.c.receive(
    "actor-inspection",
    JSON.stringify({ key, requestId: first, url: "blob:http://local/stale" }),
  );
  assert.equal(f.c.getSnapshot().inspectionModel?.url, null);
  f.c.receive(
    "actor-inspection",
    JSON.stringify({
      key,
      requestId: second,
      url: "blob:http://local/current",
    }),
  );
  assert.equal(
    f.c.getSnapshot().inspectionModel?.url,
    "blob:http://local/current",
  );
  assert.equal(f.c.getSnapshot().inspectionModel?.loading, false);
  f.c.closeActorInspection();
  assert.equal(closed, 1);
  assert.equal(f.c.getSnapshot().inspectionModel, null);
  f.c.receive(
    "actor-inspection",
    JSON.stringify({ key, requestId: second, url: "blob:http://local/late" }),
  );
  assert.equal(f.c.getSnapshot().inspectionModel, null);
  f.c.stop();
});
test("SoD gear sends required native names and quality even when client metadata omits them", () => {
  const f = fixture();
  const model = {
    display: 123,
    class: 4,
    subclass: 1,
    inventory: 1,
    material: -1,
    sheath: 0,
  };
  (f.c as unknown as { modernItems: Record<string, unknown> }).modernItems = {
    234001: model,
    234002: model,
  };
  f.c.installReplay({
    ...raw,
    gameVersion: "sod",
    events: [
      {
        timestamp: 1000,
        type: "combatantinfo",
        sourceID: 1,
        auras: [],
        gear: [
          { id: 234001, name: "Enchanted Totem", quality: 4 },
          { id: 234002 },
        ],
      },
      ...raw.events.filter(
        (e) => (e as { type: string }).type !== "combatantinfo",
      ),
    ],
  } as unknown as RawReplay);
  const gear = f.frame.find((a) => a.key === "1:1")!.gear as Record<
    string,
    unknown
  >[];
  assert.equal(gear.length, 2);
  assert.equal(gear[0].name, "Enchanted Totem");
  assert.equal(gear[0].quality, 4);
  assert.equal(gear[1].name, "Item 234002");
  assert.equal(gear[1].quality, 0);
  for (const item of gear) {
    for (const field of [
      "id",
      "slot",
      "display",
      "class",
      "subclass",
      "inventory",
      "material",
      "sheath",
      "quality",
      "enchant",
      "temporary",
    ])
      assert.equal(typeof item[field], "number", field);
    assert.equal(typeof item.name, "string");
  }
  f.c.stop();
});
test("Native frame starts future mobs at full HP, registers raid players and follows exact health/death on seek", () => {
  const f = fixture();
  let mob = f.frame.find((a) => a.key === "2:1")!;
  assert.deepEqual(mob.position, [3, -2, 0]);
  assert.equal(mob.health, 1000);
  assert.equal(mob.max_health, 1000);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.raid, true);
  f.c.seek(4500);
  mob = f.frame.find((a) => a.key === "2:1")!;
  assert.equal(mob.health, 800);
  f.c.seek(9500);
  assert.equal(
    f.frame.some((a) => a.key === "2:1"),
    false,
  );
  f.c.seek(0);
  assert.equal(f.frame.find((a) => a.key === "2:1")!.health, 1000);
  f.c.stop();
});
test("native channel snapshots use only the recorded cast target and clear it on stop", () => {
  const f = fixture();
  const actor = f.c.getSnapshot().replay!.actors.find((a) => a.key === "1:1")!;
  const channel = {
    spell: 689,
    name: "Drain Life",
    start: 0,
    end: 2000,
    channel: true,
    target: "2:1" as string | null,
  };
  actor.casts.unshift(channel);
  f.c.seek(500);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.channel_target, "2:1");
  channel.target = "1:1";
  f.c.seek(501);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.channel_target, "1:1");
  channel.target = null;
  f.c.seek(502);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.channel_target, null);
  f.c.seek(2500);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.channel, false);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.channel_target, null);
  f.c.stop();
});
test("native self aura provenance follows active snapshots, rewinds and the aura visibility option", () => {
  const f = fixture();
  f.c.seek(6500);
  assert.deepEqual(f.frame.find((a) => a.key === "1:1")!.self_auras, [133]);
  f.c.seek(5000);
  assert.deepEqual(f.frame.find((a) => a.key === "1:1")!.self_auras, []);
  f.c.seek(6500);
  f.c.setOption("auras", false);
  assert.deepEqual(f.frame.find((a) => a.key === "1:1")!.self_auras, []);
  f.c.setOption("auras", true);
  assert.deepEqual(f.frame.find((a) => a.key === "1:1")!.self_auras, [133]);
  f.c.stop();
});

test("Playback, pause, casts, aura rewind and native selection share controller state", () => {
  const f = fixture();
  f.c.seek(4800);
  assert.equal(
    f.frame.find((a) => a.key === "1:1")!.plate_cast?.name,
    "Fireball",
  );
  f.c.toggle();
  f.c.advance(200);
  f.c.render();
  assert.equal(f.c.getSnapshot().time, 5000);
  f.c.toggle();
  f.c.advance(500);
  f.c.render();
  assert.equal(f.c.getSnapshot().time, 5000);
  assert.equal(f.frame.find((a) => a.player)!.speed, 0);
  f.c.seek(6500);
  assert.equal(f.frame.find((a) => a.player)!.auras.length, 1);
  f.c.seek(100);
  assert.equal(f.frame.find((a) => a.player)!.auras.length, 0);
  assert.equal(f.events.at(-1)?.reset, true);
  f.c.select("1:1");
  assert.equal(f.selected, "1:1");
  f.c.receive(
    "actors",
    JSON.stringify({ visualEvents: 3, unsupported: 0, selected: "2:1" }),
  );
  assert.equal(f.c.getSnapshot().selected, "2:1");
  f.c.stop();
});
test("Existing saved plan key survives undo, redo and save without automatically overwriting storage", () => {
  const f = fixture();
  f.c.setTool("marker");
  f.c.receive("point", "[1,2,3]");
  assert.equal(f.c.getSnapshot().plan.markers.length, 1);
  assert.equal(f.memory.has(STORAGE_KEY), false);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.markers.length, 0);
  f.c.redo();
  assert.equal(f.c.getSnapshot().plan.markers.length, 1);
  f.c.save();
  assert.equal(JSON.parse(f.memory.get(STORAGE_KEY)!).markers.length, 1);
  assert.equal(f.c.getSnapshot().dirty, false);
  f.c.stop();
});
test("Looping an encounter resets combat edges without drifting past its time range", () => {
  const f = fixture();
  f.c.toggleLoop();
  f.c.seek(10900);
  f.c.toggle();
  f.c.advance(200);
  f.c.render();
  assert.equal(f.c.getSnapshot().time, 100);
  assert.equal(f.c.getSnapshot().playing, true);
  assert.equal(f.events.at(-1)?.reset, true);
  f.c.stop();
});
test("Native Lua extensions parse as the client Lua 5.1 dialect", () => {
  for (const file of ["planner_raid.lua", "planner_nameplates.lua"]) {
    const source = readFileSync(
      new URL(`../../../crates/benilla-app/src/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotThrow(() => luaparse.parse(source, { luaVersion: "5.1" }));
  }
});

test("Cached full run fits the native bridge and retains persistent mobs, wisps and recorded models", async (t) => {
  let cached: RawReplay;
  try {
    cached = JSON.parse(
      readFileSync(
        new URL("../../../.agent/work/wcl/full-run.json", import.meta.url),
        "utf8",
      ),
    );
  } catch {
    t.skip("Local public log cache is unavailable");
    return;
  }
  const f = fixture();
  f.c.installReplay(cached);
  assert.equal(f.frame.filter((a) => !a.player && a.position).length, 113);
  assert.ok(
    Buffer.byteLength(JSON.stringify(f.frame)) <= 400000,
    "Frame fits the native bridge limit",
  );
  const replay = f.c.getSnapshot().replay!;
  assert.equal(
    replay.actors.reduce((n, a) => n + a.resourceChanges.length, 0),
    13213,
  );
  assert.ok(
    replay.actors.filter((a) => a.type === "Player" && a.power.length > 0)
      .length >= 35,
  );
  assert.ok(
    replay.actors.every((a) => a.power.every(([, p]) => p.current === null)),
    "Cached report does not contain known current power",
  );
  f.c.seek(5000);
  assert.ok(
    f.frame.filter((a) => a.player && a.max_power !== null && a.power === null)
      .length > 10,
    "Known caps cross bridge without fake zero currents",
  );
  f.c.seek(2030000);
  assert.equal(f.frame.filter((a) => a.player && a.estimated).length, 36);
  f.c.seek(2080000);
  assert.ok(
    f.frame.filter((a) => a.player && !a.estimated && a.position).length > 20,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(f.frame)) <= 400000);
  f.c.stop();
});

test("A dead actor remains inspectable when unchanged native selection is echoed", () => {
  const f = fixture();
  f.c.receive(
    "actors",
    JSON.stringify({ visualEvents: 0, unsupported: 0, selected: "1:1" }),
  );
  f.c.seek(9500);
  f.c.select("2:1");
  f.c.receive(
    "actors",
    JSON.stringify({ visualEvents: 0, unsupported: 0, selected: "1:1" }),
  );
  assert.equal(f.c.getSnapshot().selected, "2:1");
  f.c.receive(
    "actors",
    JSON.stringify({ visualEvents: 0, unsupported: 0, selected: null }),
  );
  assert.equal(f.c.getSnapshot().selected, null);
  f.c.stop();
});

test("Inspecting a cast selects its player, seeks to its timestamp and retains spell details through native echo", () => {
  const f = fixture();
  const actor = f.c.getSnapshot().replay!.actors.find((a) => a.id === 1)!;
  const index = actor.casts.findIndex(
    (c) => c.name === "Fireball" && !c.instant,
  );
  f.c.inspectCast(actor.key, index);
  assert.equal(f.c.getSnapshot().selected, actor.key);
  assert.equal(f.c.getSnapshot().time, actor.casts[index].start);
  assert.equal(f.c.getSnapshot().detail?.spell, 133);
  f.c.receive(
    "actors",
    JSON.stringify({ visualEvents: 0, unsupported: 0, selected: actor.key }),
  );
  assert.equal(f.c.getSnapshot().detail?.castIndex, index);
  f.c.inspectSpell(20589);
  assert.equal(f.c.getSnapshot().detail?.spell, 20589);
  f.c.stop();
});

test("Recorded resource type and values survive the native bridge and disappear before first snapshot", () => {
  const f = fixture();
  assert.equal(f.frame.find((a) => a.key === "1:1")!.max_power, null);
  f.c.seek(1500);
  const p = f.frame.find((a) => a.key === "1:1")!;
  assert.equal(p.power_type, 3);
  assert.equal(p.power, 60);
  assert.equal(p.max_power, 100);
  f.c.seek(0);
  assert.equal(f.frame.find((a) => a.key === "1:1")!.max_power, null);
  f.c.stop();
});

test("Explicit actor focus updates global selection while automatic raid framing preserves it", () => {
  const f = fixture();
  f.c.focus("1:1");
  assert.equal(f.c.getSnapshot().selected, "1:1");
  f.c.focusCurrent();
  assert.equal(f.c.getSnapshot().selected, "1:1");
  f.c.stop();
});

test("no-log scene readiness and Frame focus a modeled reference with a local floor without changing selection", () => {
  const f = fixture(),
    c = f.c;
  c.selectRaid(90, true, "sod");
  const [unsupported, grounded] = c.sceneActors();
  unsupported.displayID = grounded.displayID = 764;
  const [x, y] = grounded.spawn!.position;
  (c as any).loadedFloors.set(
    90,
    new ReplayFloorGeometry([
      {
        area: "room",
        interior: true,
        vertices: [
          [x - 1, y - 1, -206],
          [x + 1, y - 1, -206],
          [x + 1, y + 1, -206],
          [x - 1, y + 1, -206],
        ],
        indices: [0, 1, 2, 0, 2, 3],
      },
    ]),
  );
  c.setOption("followRaid", true);
  const selected = c.getSnapshot().selected;
  c.receive("scene", "90");
  assert.equal(c.getSnapshot().sceneReady, true);
  assert.deepEqual(f.focus.at(-1), [x, y, -206]);
  assert.equal(c.getSnapshot().selected, selected);
  c.frameSelection();
  assert.deepEqual(f.focus.at(-1), [x, y, -206]);
  assert.equal(c.getSnapshot().selected, selected);
  c.stop();
});

test("Raid switching isolates saved plans, unsaved drafts and undo history without overwriting MC", () => {
  const f = fixture();
  f.c.rename("MC saved");
  f.c.save();
  const original = f.memory.get(STORAGE_KEY);
  f.c.rename("MC unsaved");
  f.c.selectRaid(469);
  assert.equal(f.c.getSnapshot().plan.mapId, 469);
  assert.equal(f.c.getSnapshot().replay, null);
  assert.equal(f.c.getSnapshot().canUndo, false);
  f.c.rename("BWL draft");
  f.c.save();
  assert.equal(f.memory.get(STORAGE_KEY), original);
  assert.equal(
    JSON.parse(f.memory.get("pullfiction.plan.v1.map469")!).name,
    "BWL draft",
  );
  f.c.selectRaid(409);
  assert.equal(f.c.getSnapshot().plan.name, "MC unsaved");
  assert.equal(f.c.getSnapshot().dirty, true);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.name, "MC saved");
  assert.equal(f.c.getSnapshot().dirty, false);
  f.c.selectRaid(469);
  assert.equal(f.c.getSnapshot().plan.name, "BWL draft");
  assert.deepEqual(f.maps, [469, 409, 469]);
  assert.equal(f.memory.get(STORAGE_KEY), original);
});

test("Cross-raid replay chooses its map, rejects stale scene readiness and defers camera focus until geometry", () => {
  const f = fixture();
  f.c.setOption("followRaid", false);
  f.c.installReplay({
    ...raw,
    fight: { ...raw.fight, gameZone: { name: "Naxxramas" } },
  });
  assert.equal(f.c.getSnapshot().plan.mapId, 533);
  assert.equal(f.c.getSnapshot().replay?.map, 533);
  assert.equal(f.c.getSnapshot().sceneReady, false);
  f.c.receive("scene", "409");
  assert.equal(f.c.getSnapshot().sceneReady, false);
  const previousFocus = f.focus.length;
  f.c.receive("scene", "533");
  assert.equal(f.c.getSnapshot().sceneReady, true);
  assert.equal(f.c.getSnapshot().status, "Naxxramas");
  assert.ok(f.focus.length > previousFocus);
  assert.equal(f.maps.at(-1), 533);
});

test("All seven replay maps drive native map commands and preserve the MC save", async () => {
  const { raidsForVersion } = await import("./domain");
  const RAIDS = raidsForVersion("vanilla");
  const f = fixture();
  f.c.rename("Original MC");
  f.c.save();
  const saved = f.memory.get(STORAGE_KEY);
  for (const raid of RAIDS) {
    f.c.installReplay({
      ...raw,
      fight: { ...raw.fight, gameZone: { name: raid.name } },
    });
    assert.equal(f.c.getSnapshot().replay?.map, raid.map);
    assert.equal(f.c.getSnapshot().plan.mapId, raid.map);
  }
  assert.equal(f.memory.get(STORAGE_KEY), saved);
  assert.deepEqual(
    f.maps,
    RAIDS.filter((r) => r.map !== 409).map((r) => r.map),
  );
});

test("Free camera movement belongs to the focused 3D canvas and pauses for typing, shortcuts and map view", () => {
  const c = new EditorController();
  const typing: boolean[] = [];
  c.attachEngine({
    set_annotations() {},
    set_replay_frame() {},
    set_typing(on: boolean) {
      typing.push(on);
    },
  } as unknown as Engine);
  assert.equal(typing.at(-1), true);
  c.setSceneFocused(true);
  assert.equal(typing.at(-1), false);
  c.setTyping(true);
  assert.equal(typing.at(-1), true);
  c.setTyping(false);
  assert.equal(typing.at(-1), false);
  c.setShortcutCapture(true);
  assert.equal(typing.at(-1), true);
  c.setShortcutCapture(false);
  assert.equal(typing.at(-1), false);
  c.setMapView(true);
  assert.equal(typing.at(-1), true);
  assert.equal(c.freeCameraInput(), false);
  c.setMapView(false);
  assert.equal(typing.at(-1), false);
  assert.equal(c.freeCameraInput(), true);
  c.setSceneFocused(false);
  assert.equal(typing.at(-1), true);
  c.setSceneFocused(true);
  assert.equal(typing.at(-1), false);
  c.stop();
});

test("Map marking requests native collision and stores its returned height rather than the hint", () => {
  const f = fixture();
  f.c.pickMap(10, 20, 30);
  assert.equal(f.mapPicks.length, 0);
  f.c.setTool("marker");
  f.c.pickMap(10, 20, 30);
  assert.deepEqual(f.mapPicks, [[10, 20, 30]]);
  f.c.receive("point", JSON.stringify([10, 20, 37]));
  assert.deepEqual(f.c.getSnapshot().plan.markers.at(-1), [10, 20, 37]);
});

test("Busy playback preserves all ordered impacts across large time steps and bounded native batches", () => {
  const f = fixture();
  const events = [
    { timestamp: 1000, type: "combatantinfo", sourceID: 1, auras: [] },
    ...Array.from({ length: 750 }, (_, i) => ({
      timestamp: 1100 + i,
      type: "damage",
      sourceID: 1,
      targetID: 2,
      abilityGameID: 133,
      amount: 1,
    })),
  ];
  f.c.installReplay({ ...raw, events } as unknown as RawReplay);
  f.events.length = 0;
  f.c.toggle();
  f.c.advance(1500);
  f.c.render();
  const batches = f.events.filter((x) => !x.reset),
    all = batches.flatMap((x) => x.data) as { t: number; kind: string }[];
  assert.equal(all.length, 750);
  assert.ok(batches.every((x) => x.data.length <= 100));
  assert.deepEqual(
    all.map((x) => x.t),
    Array.from({ length: 750 }, (_, i) => 100 + i),
  );
  assert.ok(all.every((x) => x.kind === "impact"));
  const n = f.events.length;
  f.c.render();
  assert.equal(f.events.length, n, "same playhead never re-emits impacts");
  f.c.seek(0);
  assert.equal(f.events.at(-1)?.reset, true);
  f.c.stop();
});
test("Final playback step delivers end-of-fight impacts and an explicit seek never replays skipped actions", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    events: [
      {
        timestamp: 12000,
        type: "heal",
        sourceID: 1,
        targetID: 1,
        abilityGameID: 133,
        amount: 5,
      },
    ],
  } as unknown as RawReplay);
  f.c.seek(10000);
  f.events.length = 0;
  f.c.toggle();
  f.c.advance(1000);
  f.c.render();
  const all = f.events.flatMap((e) => e.data) as { t: number }[];
  assert.equal(all.length, 1);
  assert.equal(all[0].t, 11000);
  assert.equal(f.c.getSnapshot().playing, false);
  f.events.length = 0;
  f.c.seek(0);
  f.c.seek(11000);
  assert.equal(f.events.flatMap((e) => e.data).length, 0);
  f.c.stop();
});

test("Map portrait requests deduplicate displays, prioritize bosses and cache native images", () => {
  const f = fixture(),
    requests: { key: string; display: number }[][] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    request_portraits: (json: string) => requests.push(JSON.parse(json)),
  } as unknown as Engine;
  f.c.attachEngine(engine);
  const actor = f.c.getSnapshot().replay!.actors.find((a) => a.type === "NPC")!;
  actor.class = "Boss";
  actor.displayID = 123;
  f.c.requestMapPortraits();
  assert.deepEqual(requests.at(-1), [{ key: actor.key, display: 123 }]);
  f.c.receive(
    "portrait",
    JSON.stringify({ display: 123, url: "blob:local-client-portrait" }),
  );
  assert.equal(f.c.portraitUrl(actor), "blob:local-client-portrait");
  assert.equal(f.c.getSnapshot().portraitVersion, 1);
  const before = requests.length;
  f.c.requestMapPortraits();
  assert.equal(requests.length, before);
  f.c.stop();
});

test("Playbook drawings create one undo entry and preserve independent step annotations", () => {
  const f = fixture();
  f.c.setTool("drawing");
  f.c.receive("point", "[1,2,3]");
  f.c.receive("point", "[5,6,3]");
  f.c.receive("point", "[9,8,3]");
  assert.equal(f.c.getSnapshot().drawing, true);
  f.c.finishDrawing();
  let state = f.c.getSnapshot();
  assert.equal(state.plan.steps[0].annotations.length, 1);
  assert.equal(state.plan.steps[0].annotations[0].points.length, 3);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  f.c.redo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 1);
  const first = f.c.getSnapshot().activeStep;
  f.c.addStep("boss");
  f.c.setTool("marker");
  f.c.receive("point", "[100,200,30]");
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].points.length, 3);
  assert.equal(f.c.getSnapshot().plan.steps[1].annotations.length, 1);
  f.c.setActiveStep(first, false);
  assert.equal(f.c.getSnapshot().activeStep, first);
  f.c.stop();
});
test("Grounded drawing waits for its last pick, rejects stale responses, and saves the finished gesture", () => {
  const f = fixture(),
    requests: { x: number; token: number }[] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    pick_map_for_annotation: (
      x: number,
      _y: number,
      _z: number,
      token: number,
    ) => requests.push({ x, token }),
  } as unknown as Engine;
  f.c.attachEngine(engine);
  f.c.setTool("drawing");
  f.c.pickMap(1, 2, 3);
  f.c.pickMap(5, 6, 3);
  f.c.finishDrawing();
  f.c.save();
  const token = requests[0].token;
  f.c.receive("plan-point", JSON.stringify({ token, point: [1, 2, 3] }));
  assert.equal(f.c.getSnapshot().drawing, true);
  f.c.receive("plan-point", JSON.stringify({ token, point: [5, 6, 3] }));
  assert.equal(f.c.getSnapshot().drawing, false);
  assert.equal(f.c.getSnapshot().dirty, false);
  assert.equal(
    JSON.parse(f.memory.get(STORAGE_KEY)!).steps[0].annotations[0].points
      .length,
    2,
  );
  f.c.setTool("marker");
  f.c.pickMap(3, 4, 5);
  const stale = requests.at(-1)!.token;
  f.c.addStep();
  f.c.receive("plan-point", JSON.stringify({ token: stale, point: [3, 4, 5] }));
  assert.equal(f.c.getSnapshot().plan.steps[1].annotations.length, 0);
  f.c.stop();
});
test("Marker comments, locking, duplication and move operations survive undo/save", () => {
  const f = fixture();
  f.c.setTool("marker");
  f.c.receive("point", "[10,20,30]");
  const id = f.c.getSnapshot().selectedMark!;
  f.c.updateMark({ label: "Tank", color: "#65c6b4" });
  f.c.comment("Face the boss away");
  f.c.updateMark({ locked: true });
  f.c.removeMark();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 1);
  f.c.updateMark({ label: "Should not change" });
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].label, "Tank");
  f.c.duplicateMark();
  let copy = f.c.getSnapshot().plan.steps[0].annotations[1];
  assert.notEqual(copy.id, id);
  assert.notEqual(
    copy.comments[0].id,
    f.c.getSnapshot().plan.steps[0].annotations[0].comments[0].id,
  );
  f.c.setTool("move");
  f.c.receive("point", "[100,200,300]");
  copy = f.c.getSnapshot().plan.steps[0].annotations[1];
  assert.deepEqual(copy.points[0], [100, 200, 300]);
  f.c.save();
  assert.equal(f.c.getSnapshot().dirty, false);
  f.c.stop();
});
test("Timed page visibility follows replay boundaries while editor selection and ordering remain stable", () => {
  const f = fixture();
  f.c.stepsFromLog();
  let state = f.c.getSnapshot();
  assert.equal(state.plan.steps.length, 1);
  assert.equal(state.plan.steps[0].start, 0);
  f.c.addStep("phase");
  f.c.updateStep({ start: 5000, end: 8000, name: "Phase two" });
  const phase = f.c.getSnapshot().activeStep;
  f.c.setStepView({ followSteps: true });
  f.c.seek(6000);
  assert.equal(f.c.getSnapshot().activeStep, phase);
  f.c.seek(100);
  assert.equal(f.c.getSnapshot().activeStep, phase);
  assert.ok(!f.c.visiblePages().some((s) => s.id === phase));
  assert.ok(
    f.c.visiblePages().some((s) => s.id === f.c.getSnapshot().plan.steps[0].id),
  );
  f.c.setActiveStep(phase, false);
  f.c.moveStep(-1);
  assert.equal(f.c.getSnapshot().plan.steps[0].id, phase);
  f.c.duplicateStep();
  assert.equal(f.c.getSnapshot().plan.steps.length, 3);
  f.c.deleteStep();
  assert.equal(f.c.getSnapshot().plan.steps.length, 2);
  f.c.stop();
});

test("Editor and Playback modes keep the separate Playbook window independent", () => {
  const f = fixture();
  assert.equal(f.c.getSnapshot().workspaceMode, "analyse");
  f.c.setPlanning(true);
  f.c.setTool("marker");
  assert.equal(f.c.getSnapshot().workspaceMode, "plan");
  assert.equal(f.c.getSnapshot().planning, true);
  f.c.setPlanning(false);
  assert.equal(f.c.getSnapshot().tool, "marker");
  f.c.receive("point", "[10,20,30]");
  f.c.selectMark(f.c.getSnapshot().selectedMark);
  assert.equal(f.c.getSnapshot().planning, false);
  f.c.setWorkspaceMode("analyse");
  assert.equal(f.c.getSnapshot().tool, "explore");
  assert.equal(f.c.getSnapshot().sceneHover, null);
  f.c.stop();
});
test("Dragging a whole mark preserves its shape and is a single reversible gesture", () => {
  const f = fixture();
  f.c.setTool("route");
  f.c.receive("point", "[10,20,30]");
  f.c.receive("point", "[20,25,32]");
  f.c.finishDrawing();
  const id = f.c.getSnapshot().selectedMark!;
  assert.equal(f.c.beginMarkDrag(id, null, [12, 21, 30]), true);
  f.c.receive("point", "[22,31,35]");
  f.c.receive("point", "[32,41,40]");
  f.c.finishDrawing();
  assert.deepEqual(f.c.getSnapshot().plan.steps[0].annotations[0].points, [
    [30, 40, 40],
    [40, 45, 42],
  ]);
  f.c.undo();
  assert.deepEqual(f.c.getSnapshot().plan.steps[0].annotations[0].points, [
    [10, 20, 30],
    [20, 25, 32],
  ]);
  f.c.redo();
  assert.deepEqual(f.c.getSnapshot().plan.steps[0].annotations[0].points, [
    [30, 40, 40],
    [40, 45, 42],
  ]);
  f.c.stop();
});
test("Dragging a radius handle changes radius, center drag translates, and cancel restores the original", () => {
  const f = fixture();
  f.c.setTool("circle");
  f.c.receive("point", "[0,0,3]");
  f.c.receive("point", "[5,0,3]");
  const id = f.c.getSnapshot().selectedMark!;
  f.c.beginMarkDrag(id, 1, [5, 0, 3]);
  f.c.receive("point", "[12,0,3]");
  f.c.finishDrawing();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].size, 12);
  f.c.beginMarkDrag(id, 0, [0, 0, 3]);
  f.c.receive("point", "[20,20,4]");
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [20, 20, 4],
  );
  f.c.cancelDrawing();
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [0, 0, 3],
  );
  f.c.updateMark({ locked: true });
  assert.equal(f.c.beginMarkDrag(id, null, [0, 0, 3]), false);
  f.c.stop();
});

test("3D drag picks wait for their last native response and late responses cannot edit after cancelling", () => {
  const f = fixture(),
    tokens: number[] = [],
    modes: boolean[] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    select_replay: () => {},
    set_editor_mode: (on: boolean) => modes.push(on),
    pick_for_annotation: (_x: number, _y: number, token: number) =>
      tokens.push(token),
  } as unknown as Engine;
  f.c.attachEngine(engine);
  f.c.setTool("marker");
  f.c.receive("point", "[10,20,30]");
  const id = f.c.getSnapshot().selectedMark!;
  f.c.beginMarkDrag(id, null, [10, 20, 30]);
  f.c.pick(100, 200);
  f.c.finishDrawing();
  assert.equal(tokens.length, 1);
  assert.equal(f.c.getSnapshot().drawing, true);
  f.c.receive(
    "plan-point",
    JSON.stringify({ token: tokens[0], point: [50, 60, 70] }),
  );
  assert.equal(f.c.getSnapshot().drawing, false);
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [50, 60, 70],
  );
  f.c.beginMarkDrag(id, null, [50, 60, 70]);
  f.c.pick(200, 300);
  const stale = tokens[1];
  f.c.setWorkspaceMode("analyse");
  f.c.receive("plan-point", JSON.stringify({ token: stale, point: [1, 1, 1] }));
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [50, 60, 70],
  );
  assert.equal(modes.at(-1), false);
  assert.ok(modes.includes(true));
  f.c.stop();
});

function markerSet() {
  const f = fixture();
  f.c.setTool("marker");
  f.c.receive("point", "[10,20,30]");
  const a = f.c.getSnapshot().selectedMark!;
  f.c.receive("point", "[30,40,30]");
  const b = f.c.getSnapshot().selectedMark!;
  f.c.receive("point", "[50,60,30]");
  const c = f.c.getSnapshot().selectedMark!;
  return { ...f, ids: [a, b, c] };
}
test("Modifier selection adds, toggles and selects ranges without touching the plan", () => {
  const f = markerSet(),
    [a, b, c] = f.ids,
    before = JSON.stringify(f.c.getSnapshot().plan);
  f.c.selectMark(a);
  f.c.selectMark(c, "add");
  assert.deepEqual(f.c.getSnapshot().selectedMarks, [a, c]);
  f.c.selectMark(a, "toggle");
  assert.deepEqual(f.c.getSnapshot().selectedMarks, [c]);
  f.c.selectMark(a);
  f.c.selectMark(c, "range");
  assert.deepEqual(f.c.getSnapshot().selectedMarks, [a, b, c]);
  assert.equal(JSON.stringify(f.c.getSnapshot().plan), before);
  f.c.stop();
});
test("Group drag moves every unlocked selected mark and undo restores the entire gesture", () => {
  const f = markerSet(),
    [a, b, c] = f.ids;
  f.c.selectMark(c);
  f.c.updateMark({ locked: true });
  f.c.selectAllMarks();
  assert.equal(f.c.beginMarkDrag(a, null, [10, 20, 30]), true);
  f.c.receive("point", "[15,25,30]");
  f.c.receive("point", "[20,30,30]");
  f.c.finishDrawing();
  let marks = f.c.getSnapshot().plan.steps[0].annotations;
  assert.deepEqual(
    marks.map((a) => a.points[0]),
    [
      [20, 30, 30],
      [40, 50, 30],
      [50, 60, 30],
    ],
  );
  f.c.undo();
  marks = f.c.getSnapshot().plan.steps[0].annotations;
  assert.deepEqual(
    marks.map((a) => a.points[0]),
    [
      [10, 20, 30],
      [30, 40, 30],
      [50, 60, 30],
    ],
  );
  f.c.stop();
});
test("Batch styling and delete skip locked marks even if the primary mark is locked", () => {
  const f = markerSet(),
    [a, b, c] = f.ids;
  f.c.selectMark(c);
  f.c.updateMark({ locked: true });
  f.c.selectAllMarks();
  f.c.updateMark({ color: "#112233" });
  let marks = f.c.getSnapshot().plan.steps[0].annotations;
  assert.equal(marks[0].color, "#112233");
  assert.notEqual(marks[2].color, "#112233");
  f.c.removeMark();
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations.map((a) => a.id),
    [c],
  );
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 3);
  f.c.stop();
});
test("Copy/paste duplicates a selected group with new identities and one undo entry", () => {
  const f = markerSet();
  f.c.selectMarks(f.ids.slice(0, 2));
  f.c.copyMarks();
  f.c.pasteMarks();
  const copies = f.c.getSnapshot().selectedMarks;
  assert.equal(copies.length, 2);
  assert.ok(copies.every((id) => !f.ids.includes(id)));
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 5);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 3);
  f.c.stop();
});
test("Alt-drag duplicates without initial offset and undo removes the whole copied gesture", () => {
  const f = markerSet(),
    id = f.ids[0];
  f.c.selectMark(id);
  f.c.beginMarkDrag(id, null, [10, 20, 30], true);
  f.c.receive("point", "[20,25,30]");
  f.c.finishDrawing();
  const marks = f.c.getSnapshot().plan.steps[0].annotations;
  assert.equal(marks.length, 4);
  assert.deepEqual(marks[3].points[0], [20, 25, 30]);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 3);
  f.c.stop();
});
test("Native shape previews replace the endpoint without finishing or growing history", () => {
  const f = fixture(),
    tokens: number[] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    pick_for_annotation: (_x: number, _y: number, t: number) => tokens.push(t),
    preview_annotation: (_x: number, _y: number, t: number) => tokens.push(t),
  } as unknown as Engine;
  f.c.attachEngine(engine);
  f.c.setTool("cone");
  f.c.pick(1, 1);
  const token = tokens[0];
  f.c.receive("plan-point", JSON.stringify({ token, point: [0, 0, 3] }));
  for (const point of [
    [5, 0, 3],
    [10, 5, 3],
    [20, 0, 3],
  ]) {
    f.c.pick(2, 2, false, true);
    f.c.receive("plan-point", JSON.stringify({ token, point, preview: true }));
    assert.equal(f.c.getSnapshot().drawing, true);
  }
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].points.length, 2);
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  f.c.pick(3, 3);
  f.c.finishDrawing();
  f.c.receive("plan-point", JSON.stringify({ token, point: [15, 0, 3] }));
  assert.equal(f.c.getSnapshot().drawing, false);
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].size, 15);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  f.c.stop();
});
test("Attached actor markers follow replay positions without mutating saved anchors or stopping playback", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("marker");
  const actor = f.c
    .getSnapshot()
    .replay!.actors.find((a) => a.type === "Player")!;
  f.c.markActor(actor.key);
  const mark = f.c.getSnapshot().plan.steps[0].annotations[0],
    saved = JSON.stringify(mark.points);
  assert.equal(mark.actor, actor.key);
  assert.equal(mark.actorReport, f.c.getSnapshot().replay!.report.code);
  f.c.seek(5000);
  const displayed = f.c.displayMarks()[0];
  assert.equal(displayed.actor, actor.key);
  assert.equal(
    JSON.stringify(f.c.getSnapshot().plan.steps[0].annotations[0].points),
    saved,
  );
  f.c.save();
  assert.equal(
    JSON.parse(f.memory.get(STORAGE_KEY)!).steps[0].annotations[0].actor,
    actor.key,
  );
  f.c.stop();
});

test("Changing an existing actor icon preserves comments and locked actor markers cannot be replaced", () => {
  const f = fixture(),
    actor = f.c.getSnapshot().replay!.actors.find((a) => a.type === "Player")!;
  f.c.seek(1000);
  f.c.setTool("marker");
  f.c.markActor(actor.key);
  const id = f.c.getSnapshot().selectedMark!;
  f.c.comment("Assigned tank target");
  f.c.setMarkStyle({ icon: "1" });
  f.c.markActor(actor.key);
  let a = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.equal(a.id, id);
  assert.equal(a.icon, "1");
  assert.equal(a.comments.length, 1);
  f.c.updateMark({ locked: true });
  f.c.setMarkStyle({ icon: "2" });
  f.c.markActor(actor.key);
  a = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.equal(a.icon, "1");
  f.c.stop();
});
test("Shift drag constrains the group to its dominant horizontal axis", () => {
  const f = markerSet(),
    [id] = f.ids;
  f.c.selectMark(id);
  f.c.beginMarkDrag(id, null, [10, 20, 30]);
  f.c.pick(100, 100, true);
  f.c.receive("point", "[20,23,30]");
  f.c.finishDrawing();
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [20, 20, 30],
  );
  f.c.stop();
});
test("Cancelled native shape previews discard the draft and ignore final replies", () => {
  const f = fixture(),
    tokens: number[] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplates: () => {},
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    pick_for_annotation: (_x: number, _y: number, t: number) => tokens.push(t),
    preview_annotation: (_x: number, _y: number, t: number) => tokens.push(t),
  } as unknown as Engine;
  f.c.attachEngine(engine);
  f.c.setTool("cone");
  f.c.pick(1, 1);
  const token = tokens[0];
  f.c.receive("plan-point", JSON.stringify({ token, point: [0, 0, 3] }));
  f.c.pick(2, 2, false, true);
  f.c.receive(
    "plan-point",
    JSON.stringify({ token, point: [10, 0, 3], preview: true }),
  );
  f.c.pick(3, 3);
  f.c.cancelDrawing();
  f.c.receive("plan-point", JSON.stringify({ token, point: [20, 0, 3] }));
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  assert.equal(f.c.getSnapshot().drawing, false);
  f.c.stop();
});

test("Friendly and enemy native nameplate visibility can be changed independently", () => {
  const f = fixture(),
    calls: boolean[][] = [];
  const engine = {
    set_annotations: () => {},
    set_replay_nameplate_filters: (friendly: boolean, enemy: boolean) =>
      calls.push([friendly, enemy]),
    set_replay_raid_frames: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
  } as unknown as Engine;
  f.c.attachEngine(engine);
  f.c.setOption("friendlyNameplates", false);
  assert.deepEqual(calls.at(-1), [false, true]);
  f.c.setOption("enemyNameplates", false);
  assert.deepEqual(calls.at(-1), [false, false]);
  f.c.setOption("friendlyNameplates", true);
  assert.deepEqual(calls.at(-1), [true, false]);
  f.c.stop();
});

test("Empty duplicate does not paste an old clipboard and locked no-op edits do not consume history", () => {
  const f = markerSet();
  f.c.selectMark(f.ids[0]);
  f.c.copyMarks();
  f.c.selectMark(null);
  f.c.duplicateMark();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 3);
  f.c.selectMark(f.ids[0]);
  f.c.updateMark({ locked: true });
  f.c.removeMark();
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].locked, false);
  f.c.stop();
});
test("Map nudging follows screen directions and actor marking preserves the running clock", () => {
  const f = markerSet();
  f.c.selectMark(f.ids[0]);
  f.c.setMapView(true);
  f.c.nudgeScreen(1, 0);
  assert.deepEqual(
    f.c.getSnapshot().plan.steps[0].annotations[0].points[0],
    [10, 19, 30],
  );
  f.c.seek(1000);
  f.c.toggle();
  assert.equal(f.c.getSnapshot().playing, true);
  f.c.markActor(
    f.c.getSnapshot().replay!.actors.find((a) => a.type === "Player")!.key,
  );
  assert.equal(f.c.getSnapshot().playing, true);
  f.c.stop();
});

test("A raid chosen before the native client is ready loads on attachment without an import", () => {
  const memory = new Map<string, string>(),
    c = new EditorController({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    }),
    maps: number[] = [];
  c.selectRaid(533);
  assert.equal(c.getSnapshot().replay, null);
  assert.equal(c.getSnapshot().ready, false);
  c.attachEngine({
    load_raid: (map: number) => maps.push(map),
    set_replay_frame: () => {},
    set_annotations: () => {},
  } as unknown as Engine);
  assert.deepEqual(maps, [533]);
  assert.equal(c.getSnapshot().plan.mapId, 533);
  c.rename("Naxx planning");
  c.save();
  c.stop();
  const restored = new EditorController({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  });
  assert.equal(restored.getSnapshot().plan.mapId, 533);
  assert.equal(restored.getSnapshot().plan.name, "Naxx planning");
  assert.equal(restored.getSnapshot().replay, null);
  restored.selectRaid(469);
  assert.equal(restored.getSnapshot().plan.mapId, 469);
  restored.stop();
});
test("Changing raids cancels the result of an in-flight replay import", async () => {
  const f = fixture();
  let complete: (value: unknown) => void = () => {};
  (f.c as unknown as { api: () => Promise<unknown> }).api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  f.c.receive("scene", "409");
  // Supply a report via the same path used by the import dialog.
  const pendingReport = f.c.loadReport("DyN7vF94QR8aj1Lc");
  complete({ code: "DyN7vF94QR8aj1Lc", title: "Run", fights: [raw.fight] });
  await pendingReport;
  (f.c as unknown as { loadCatalogs: () => Promise<void> }).loadCatalogs =
    async () => {};
  const pending = f.c.loadReplay("1");
  assert.equal(f.c.getSnapshot().busy, true);
  f.c.selectRaid(533);
  assert.equal(f.c.getSnapshot().busy, false);
  complete(raw);
  await pending;
  assert.equal(f.c.getSnapshot().plan.mapId, 533);
  assert.equal(f.c.getSnapshot().replay, null);
  f.c.stop();
});

test("Boss-owned pets stay hostile in replay transport and reopened standalone plans", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    actors: [
      ...raw.actors,
      { id: 3, name: "Ward", type: "Pet", petOwner: 2, gameID: 14987 },
      { id: 4, name: "Player pet", type: "Pet", petOwner: 1, gameID: 416 },
    ],
    events: [
      ...raw.events,
      ...[3, 4].flatMap((id) => [
        {
          timestamp: 2000,
          type: "create",
          sourceID: id === 3 ? 2 : 1,
          targetID: id,
          abilityGameID: 24309,
        },
        {
          timestamp: 2100,
          type: "cast",
          sourceID: id,
          abilityGameID: 1,
          resourceActor: 1,
          x: 350,
          y: 250,
        },
      ]),
    ],
  } as unknown as RawReplay);
  f.c.seek(1500);
  assert.equal(f.frame.find((a) => a.key === "3:1")?.friendly, false);
  assert.equal(f.frame.find((a) => a.key === "4:1")?.friendly, true);
  f.c.planFromMoment();
  const saved = parsePlan(JSON.stringify(f.c.getSnapshot().plan));
  const step = saved.steps.find((s) =>
    s.snapshot?.actors.some((a) => a.key === "3:1"),
  )!;
  assert.equal(
    step.snapshot!.actors.find((a) => a.key === "3:1")?.friendly,
    false,
  );
  const standalone = new EditorController();
  standalone.attachEngine(f.engine);
  standalone.editPlan(saved);
  standalone.setWorkspaceMode("plan");
  standalone.setActiveStep(step.id, false);
  standalone.render();
  assert.equal(f.frame.find((a) => a.key === "3:1")?.friendly, false);
  assert.equal(f.frame.find((a) => a.key === "4:1")?.friendly, true);
  standalone.stop();
  f.c.stop();
});

test("Paused replay snapshots keep mob and pet identities, positions and event generation stable", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    actors: [
      ...raw.actors,
      { id: 3, name: "Pet", type: "Pet", petOwner: 1, gameID: 416 },
    ],
    events: [
      ...raw.events,
      {
        timestamp: 2000,
        type: "cast",
        sourceID: 3,
        abilityGameID: 1,
        resourceActor: 1,
        x: 350,
        y: 250,
        hitPoints: 100,
        maxHitPoints: 100,
      },
    ],
  } as unknown as RawReplay);
  f.c.seek(1500);
  f.c.toggle();
  f.c.toggle();
  const paused = JSON.stringify(f.frame),
    resets = f.events.filter((e) => e.reset).length;
  assert.ok(f.frame.some((a) => a.friendly && !a.player));
  assert.ok(f.frame.some((a) => !a.friendly && !a.player));
  for (let i = 0; i < 20; i++) f.c.render();
  assert.equal(f.c.getSnapshot().playing, false);
  assert.equal(JSON.stringify(f.frame), paused);
  assert.ok(f.frame.every((a) => a.speed === 0));
  assert.equal(f.events.filter((e) => e.reset).length, resets);
  f.c.stop();
});

test("Raid camera defaults on, follows current actors and yields to map view and explicit focus", () => {
  const f = fixture();
  assert.equal(f.c.getSnapshot().options.followRaid, true);
  f.c.seek(4500);
  assert.ok(f.cameraSubjects.at(-1)!.includes("1:1"));
  assert.ok(f.cameraSubjects.at(-1)!.includes("2:1"));
  f.c.setMapView(true);
  f.c.seek(4500);
  assert.deepEqual(f.cameraSubjects.at(-1), []);
  f.c.setMapView(false);
  f.c.focus("1:1");
  assert.equal(f.c.getSnapshot().options.followRaid, false);
  assert.deepEqual(f.cameraSubjects.at(-1), []);
  assert.ok(f.focus.length > 0);
});

test("Camera distance is bounded and invalid distance changes are ignored", () => {
  const f = fixture();
  assert.equal(f.c.getSnapshot().cameraMaxDistance, 40);
  f.c.setCameraDistance(100);
  assert.equal(f.c.getSnapshot().cameraMaxDistance, 60);
  f.c.setCameraDistance(0);
  assert.equal(f.c.getSnapshot().cameraMaxDistance, 15);
  f.c.setCameraDistance(NaN);
  assert.equal(f.c.getSnapshot().cameraMaxDistance, 15);
});

test("Selected-player camera lock and distance cross the native bridge", () => {
  const f = fixture();
  f.c.select("1:1");
  f.c.setOption("lockCamera", true);
  f.c.setCameraDistance(30);
  assert.deepEqual(f.cameraSettings.at(-1), [30, "1:1"]);
  f.c.setOption("lockCamera", false);
  assert.deepEqual(f.cameraSettings.at(-1), [30, ""]);
});

test("Era and SoD plans keep independent drafts and saves on the same raid map", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const c = new EditorController(storage);
  c.rename("Era route");
  c.save();
  c.setGameVersion("sod");
  assert.equal(c.getSnapshot().gameVersion, "sod");
  assert.notEqual(c.getSnapshot().plan.name, "Era route");
  c.rename("SoD route");
  c.save();
  c.setGameVersion("vanilla");
  assert.equal(c.getSnapshot().plan.name, "Era route");
  c.setGameVersion("sod");
  assert.equal(c.getSnapshot().plan.name, "SoD route");
  const restored = new EditorController(storage);
  assert.equal(restored.getSnapshot().gameVersion, "sod");
  assert.equal(restored.getSnapshot().plan.name, "SoD route");
});

test("Plan from this moment freezes poses, saves source context and never changes recorded samples", () => {
  const f = fixture();
  f.c.seek(5000);
  const rawBefore = JSON.stringify(
    f.c.getSnapshot().replay!.actors.map((a) => a.samples),
  );
  f.c.planFromMoment();
  const snapshot = f.c.snapshot()!;
  assert.ok(snapshot, f.c.getSnapshot().notice);
  assert.equal(f.c.getSnapshot().workspaceMode, "plan");
  assert.equal(f.c.getSnapshot().playing, false);
  assert.equal(snapshot.time, 5000);
  assert.equal(snapshot.report, raw.report.code);
  assert.ok(snapshot.actors.length);
  const actor = snapshot.actors[0];
  f.c.selectActor(actor.key);
  f.c.nudgeActors(5, 2);
  assert.deepEqual(f.c.snapshot()!.actors[0].position, [
    actor.position[0] + 5,
    actor.position[1] + 2,
    actor.position[2],
  ]);
  assert.deepEqual(f.c.snapshot()!.actors[0].recorded, actor.position);
  assert.equal(
    JSON.stringify(f.c.getSnapshot().replay!.actors.map((a) => a.samples)),
    rawBefore,
  );
  f.c.undo();
  assert.deepEqual(f.c.snapshot()!.actors[0].position, actor.position);
  f.c.redo();
  assert.equal(f.c.snapshot()!.actors[0].position[0], actor.position[0] + 5);
  f.c.save();
  const stored = new EditorController({
    getItem: (k) => f.memory.get(k) ?? null,
    setItem: (k, v) => f.memory.set(k, v),
  });
  assert.deepEqual(stored.snapshot(), f.c.snapshot()); // reopen the first populated step
  const step = stored.getSnapshot().plan.steps.find((s) => s.snapshot)!;
  stored.setActiveStep(step.id, false);
  stored.setWorkspaceMode("plan");
  assert.deepEqual(stored.snapshot(), f.c.snapshot());
  assert.ok(stored.sceneActors().some((a) => a.key === actor.key));
  stored.setCompareRecorded(true);
  assert.deepEqual(
    stored.actorPose(stored.sceneActors()[0])?.pos,
    actor.position,
  );
  f.c.stop();
  stored.stop();
});

test("Actor drag previews make one undo operation; Escape restores all positions", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  const a = f.c.snapshot()!.actors[0],
    before = structuredClone(a.position);
  f.c.selectActor(a.key);
  assert.ok(f.c.beginActorDrag(a.key, before));
  f.c.receive(
    "point",
    JSON.stringify([before[0] + 2, before[1] + 3, before[2]]),
  );
  f.c.receive(
    "point",
    JSON.stringify([before[0] + 9, before[1] + 3, before[2]]),
  );
  f.c.finishDrawing();
  f.c.undo();
  assert.deepEqual(f.c.snapshot()!.actors[0].position, before);
  f.c.redo();
  assert.equal(f.c.snapshot()!.actors[0].position[0], before[0] + 9);
  const committed = structuredClone(f.c.snapshot());
  f.c.beginActorDrag(a.key, f.c.snapshot()!.actors[0].position);
  f.c.receive("point", JSON.stringify([before[0] + 25, before[1], before[2]]));
  f.c.cancelDrawing();
  assert.deepEqual(f.c.snapshot(), committed);
  f.c.stop();
});

test("Attached range follows planned actor and recorded comparison restores its source position", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  const a = f.c.snapshot()!.actors[0];
  f.c.attachRange(a.key, 40);
  const mark = f.c.getSnapshot().selectedMark!;
  assert.equal(f.c.displayMarks().find((m) => m.id === mark)?.size, 40);
  f.c.selectActor(a.key);
  f.c.nudgeActors(10, 0);
  assert.equal(
    f.c.displayMarks().find((m) => m.id === mark)!.points[0][0],
    a.position[0] + 10,
  );
  f.c.setCompareRecorded(true);
  assert.equal(
    f.c.displayMarks().find((m) => m.id === mark)!.points[0][0],
    a.position[0],
  );
  f.c.stop();
});

test("Plan playback and timed steps work without an imported log", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.seek(1500);
  c.addTimedStep();
  const step = c.getSnapshot().plan.steps.at(-1)!;
  assert.equal(step.start, 1500);
  assert.equal(step.end, 31500);
  c.toggle();
  c.advance(1000);
  c.render();
  assert.equal(c.getSnapshot().time, 2500);
  c.seek(Infinity);
  assert.equal(c.getSnapshot().time, 2500);
  c.stop();
});

test("Size snapping works independently from position snapping", () => {
  const f = fixture();
  f.c.setSnap({ size: true, position: false, yards: 5 });
  f.c.setTool("circle");
  f.c.receive("point", JSON.stringify([1.3, 2.4, 30]));
  f.c.receive("point", JSON.stringify([13.3, 2.4, 30]));
  const mark = f.c.getSnapshot().plan.steps[0].annotations.at(-1)!;
  assert.equal(mark.size, 10);
  assert.deepEqual(mark.points[0], [1.3, 2.4, 30]);
  f.c.stop();
});

test("Standalone planning can add player placeholders and restore native model identities", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.addPlanActor("Healer", "Priest");
  assert.equal(c.snapshot()!.actors[0].name, "Healer");
  assert.equal(
    c.sceneActors().find((a) => a.key === c.snapshot()!.actors[0].key)?.class,
    "Priest",
  );
  assert.equal(c.getSnapshot().selectedActors.length, 1);
  c.setSnap({ position: true, yards: 5, mode: "relative" });
  const a = c.snapshot()!.actors[0];
  c.nudgeActors(6, 0);
  assert.equal(c.snapshot()!.actors[0].position[0], a.position[0] + 5);
  c.stop();
});

test("Planned actor drags wait for the last native ground response before committing", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  const a = f.c.snapshot()!.actors[0];
  let token = 0;
  f.c.attachEngine({
    ...{
      set_annotations() {},
      set_replay_frame() {},
      set_replay_nameplates() {},
      set_replay_raid_frames() {},
      replay_events() {},
      select_replay() {},
    },
    pick_for_annotation(_x: number, _y: number, t: number) {
      token = t;
    },
  } as unknown as Engine);
  f.c.selectActor(a.key);
  f.c.beginActorDrag(a.key, a.position);
  f.c.pick(10, 20);
  f.c.finishDrawing();
  assert.equal(f.c.getSnapshot().drawing, true);
  f.c.receive(
    "plan-point",
    JSON.stringify({
      token,
      point: [a.position[0] + 7, a.position[1], a.position[2]],
    }),
  );
  assert.equal(f.c.getSnapshot().drawing, false);
  assert.equal(f.c.snapshot()!.actors[0].position[0], a.position[0] + 7);
  f.c.undo();
  assert.deepEqual(f.c.snapshot()!.actors[0].position, a.position);
  f.c.stop();
});

test("Mixed drawing and actor selection moves as a group and undoes together", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  const actor = f.c.snapshot()!.actors[0];
  f.c.setTool("marker");
  f.c.receive("point", JSON.stringify([10, 20, 30]));
  const id = f.c.getSnapshot().selectedMark!;
  f.c.selectActor(actor.key, true);
  assert.ok(f.c.getSnapshot().selectedMarks.includes(id));
  f.c.beginActorDrag(actor.key, actor.position);
  f.c.receive(
    "point",
    JSON.stringify([
      actor.position[0] + 4,
      actor.position[1] + 2,
      actor.position[2],
    ]),
  );
  f.c.finishDrawing();
  assert.equal(f.c.snapshot()!.actors[0].position[0], actor.position[0] + 4);
  assert.deepEqual(
    f.c.getSnapshot().plan.steps.at(-1)!.annotations[0].points[0],
    [14, 22, 30],
  );
  f.c.undo();
  assert.deepEqual(
    f.c.getSnapshot().plan.steps.at(-1)!.annotations[0].points[0],
    [10, 20, 30],
  );
  assert.deepEqual(f.c.snapshot()!.actors[0].position, actor.position);
  f.c.stop();
});

test("Selecting a drawing tool exits camera navigation and exact actor coordinates bypass the grid", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.addPlanActor("Priest", "Priest");
  c.setNavigationTool("pan");
  assert.equal(c.getSnapshot().navigationTool, "pan");
  c.setTool("circle");
  assert.equal(c.getSnapshot().navigationTool, "select");
  c.setSnap({ position: true, yards: 5 });
  c.positionActors(0, 10.25);
  assert.equal(c.snapshot()!.actors[0].position[0], 10.25);
  c.setTool("explore");
  assert.equal(c.getSnapshot().transformActive, false);
  c.stop();
});

test("Planned actor transform handles constrain movement to the chosen ground axis", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.addPlanActor("Healer", "Priest");
  c.setTransform("move");
  const actor = c.snapshot()!.actors[0],
    gizmo = c.actorGizmo()[0];
  assert.equal(gizmo.handles.length, 3);
  assert.equal(gizmo.type, "gizmo");
  const anchor = gizmo.handles[1];
  c.beginActorDrag(actor.key, anchor, false, 0);
  c.receive("point", JSON.stringify([anchor[0] + 5, anchor[1] + 7, anchor[2]]));
  c.finishDrawing();
  assert.deepEqual(c.snapshot()!.actors[0].position, [
    actor.position[0] + 5,
    actor.position[1],
    actor.position[2],
  ]);
  c.setTool("explore");
  assert.equal(c.actorGizmo().length, 1);
  assert.equal(c.getSnapshot().transformActive, false);
  c.stop();
});

test("Orbit requires a selected player, retargets on player selection and releases WASD capture when disabled", () => {
  const f = fixture(),
    typing: boolean[] = [],
    targets: string[] = [];
  f.c.attachEngine({
    set_annotations() {},
    set_replay_frame() {},
    set_typing(on: boolean) {
      typing.push(on);
    },
    set_replay_nameplates() {},
    set_replay_raid_frames() {},
    replay_events() {},
    select_replay() {},
    focus_replay() {},
    set_editor_orbit_player(key: string) {
      targets.push(key);
    },
  } as unknown as Engine);
  f.c.setSceneFocused(true);
  assert.equal(f.c.getSnapshot().cameraMode, "free");
  assert.equal(typing.at(-1), false);
  f.c.setCameraMode("orbit");
  assert.equal(f.c.getSnapshot().cameraMode, "free");
  f.c.select("1:1");
  f.c.setCameraMode("orbit");
  assert.equal(f.c.getSnapshot().cameraMode, "orbit");
  assert.equal(targets.at(-1), "1:1");
  assert.equal(typing.at(-1), true);
  f.c.setTool("circle");
  assert.equal(
    f.c.getSnapshot().cameraMode,
    "orbit",
    "Editing tools do not silently replace the camera mode",
  );
  f.c.setCameraMode("free");
  assert.equal(targets.at(-1), "");
  assert.equal(typing.at(-1), false);
  f.c.setCameraMode("orbit");
  f.c.select("2:1");
  assert.equal(
    f.c.getSnapshot().cameraMode,
    "free",
    "NPC selection cannot remain an orbit player",
  );
  f.c.select("1:1");
  f.c.setCameraMode("orbit");
  f.c.setMapView(true);
  assert.equal(f.c.getSnapshot().cameraMode, "free");
  assert.equal(typing.at(-1), true);
  f.c.stop();
});

test("Automatic raid follow explicitly exits player orbit", () => {
  const f = fixture();
  f.c.select("1:1");
  f.c.setCameraMode("orbit");
  assert.equal(f.c.getSnapshot().options.followRaid, false);
  f.c.setOption("followRaid", true);
  assert.equal(f.c.getSnapshot().cameraMode, "free");
  assert.equal(f.c.getSnapshot().orbitTarget, null);
  f.c.stop();
});

test("Native player selection retargets orbit and keeps the toggle aligned with its actual target", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    events: [
      ...raw.events,
      {
        timestamp: 6000,
        type: "damage",
        sourceID: 3,
        targetID: 2,
        resourceActor: 3,
        x: 100,
        y: 200,
        hitPoints: 100,
        maxHitPoints: 100,
        abilityGameID: 133,
        amount: 1,
      },
    ],
    actors: [
      ...raw.actors,
      { id: 3, name: "Healer", type: "Player", subType: "Priest" },
    ],
  } as unknown as RawReplay);
  f.c.select("1:1");
  f.c.setCameraMode("orbit");
  f.c.receive(
    "actors",
    JSON.stringify({ selected: "3:1", visualEvents: 0, unsupported: 0 }),
  );
  assert.equal(f.c.getSnapshot().orbitTarget, "3:1");
  assert.equal(f.c.orbitCandidate()?.key, "3:1");
  f.c.receive(
    "actors",
    JSON.stringify({ selected: "2:1", visualEvents: 0, unsupported: 0 }),
  );
  assert.equal(f.c.getSnapshot().cameraMode, "free");
  f.c.stop();
});

test("Layer periods control combined map/native drawing visibility independently of editor selection", () => {
  const f = fixture(),
    base = f.c.getSnapshot().plan.layers[0].id;
  f.c.setPeriod(base, 1000, 5000);
  f.c.setTool("marker");
  f.c.receive("point", "[1,2,3]");
  f.c.addLayer();
  const other = f.c.getSnapshot().plan.layers[1].id;
  f.c.updateLayer(other, { name: "Healing" });
  f.c.setPeriod(other, 3000, 8000);
  f.c.setTool("marker");
  f.c.receive("point", "[4,5,6]");
  const selected = f.c.getSnapshot().activeStep;
  f.c.seek(4000);
  assert.equal(f.c.displayMarks().length, 2);
  assert.equal(f.annotations.at(-1)!.marks.length, 2);
  f.c.seek(6000);
  assert.equal(f.c.displayMarks().length, 1);
  assert.equal(f.annotations.at(-1)!.marks.length, 1);
  f.c.seek(9000);
  assert.equal(f.c.displayMarks().length, 0);
  assert.equal(f.annotations.at(-1)!.marks.length, 0);
  assert.equal(f.c.getSnapshot().activeStep, selected);
  f.c.seek(4000);
  f.c.updateLayer(other, { hidden: true });
  assert.equal(f.c.displayMarks().length, 1);
  f.c.undo();
  assert.equal(f.c.displayMarks().length, 2);
  f.c.stop();
});

test("Layer order controls overlapping actor placements and deleting a layer can be undone", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  const first = structuredClone(f.c.snapshot()!),
    actor = first.actors[0];
  f.c.addLayer();
  const row = f.c.getSnapshot().plan.layers[1].id;
  f.c.updateStep({ snapshot: structuredClone(first), start: 0, end: 10000 });
  f.c.selectActor(actor.key);
  f.c.nudgeActors(5, 0);
  assert.equal(
    f.c.displaySnapshot()!.actors.find((a) => a.key === actor.key)!.position[0],
    actor.position[0] + 5,
  );
  f.c.moveLayer(row, -1);
  assert.equal(
    f.c.displaySnapshot()!.actors.find((a) => a.key === actor.key)!.position[0],
    actor.position[0],
  );
  f.c.deleteLayer(row);
  assert.equal(f.c.getSnapshot().plan.layers.length, 1);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.layers.length, 2);
  f.c.stop();
});

test("Without a log, pages retain explicit step order and can move between named rows", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  const first = c.getSnapshot().activeStep;
  c.addLayer();
  const second = c.getSnapshot().activeStep,
    row = c.getSnapshot().plan.layers[0].id;
  c.stepPage(-1);
  assert.equal(c.getSnapshot().activeStep, first);
  assert.deepEqual(
    c.visiblePages().map((s) => s.id),
    [first],
  );
  c.movePageTo(second, row, 0);
  assert.equal(c.getSnapshot().plan.steps[0].id, second);
  assert.equal(c.getSnapshot().plan.steps[0].layerId, row);
  c.setActiveStep(second, false);
  assert.deepEqual(
    c.visiblePages().map((s) => s.id),
    [second],
  );
  c.undo();
  assert.equal(c.getSnapshot().plan.steps[0].id, first);
  c.stop();
});

test("CAD dimensions set an exact radius and commit as one reversible edit", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.setTool("circle");
  c.receive("point", JSON.stringify([10, 20, 5]));
  assert.equal(c.numericDrawingAvailable(), true);
  c.setDrawingDimension("20");
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  c.confirmDrawingDimension();
  assert.equal(c.getSnapshot().drawing, false);
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].name, "Circle 1");
  c.undo();
  assert.equal(c.getSnapshot().plan.steps[0].annotations.length, 0);
  c.redo();
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  c.stop();
});
test("Cancelling numeric input restores the draft before numeric sizing", () => {
  const c = new EditorController();
  c.setTool("cone");
  c.receive("point", JSON.stringify([0, 0, 0]));
  const before = structuredClone(c.getSnapshot().plan);
  c.setDrawingDimension("30");
  c.cancelDrawingDimension();
  assert.deepEqual(c.getSnapshot().plan, before);
  c.cancelDrawing();
  c.stop();
});
test("Raid dimensions cross the native bridge and persist independently from the plan", () => {
  const memory = new Map<string, string>(),
    sizes: number[][] = [];
  const c = new EditorController({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  });
  c.attachEngine({
    set_raid_frame_size: (w: number, h: number) => sizes.push([w, h]),
    set_replay_frame: () => {},
    set_annotations: () => {},
    load_raid: () => {},
  } as unknown as Engine);
  c.setRaidFrameSize(300, 700);
  assert.deepEqual(sizes.at(-1), [300, 700]);
  assert.deepEqual(JSON.parse(memory.get("pullfiction.raidFrames.size.v1")!), {
    width: 300,
    height: 700,
  });
  c.setRaidFrameSize(NaN, 40);
  assert.deepEqual(sizes.at(-1), [300, 700]);
  c.stop();
});
test("Marker release resolves fresh hit coordinates instead of a stale hovered actor", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("marker");
  const actor = f.c.getSnapshot().replay!.actors[0];
  const requests: unknown[] = [];
  f.engine.hover_annotation = (...args) => requests.push(args);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [10, 20], actor: actor.key, point: [1, 2, 3] }),
  );
  f.c.placeSceneMarkerAt(30, 40);
  assert.deepEqual(requests, [[30, 40, true, 1]]);
  assert.equal(f.c.displayMarks().length, 0);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [10, 20], actor: actor.key, point: [1, 2, 3] }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      request: 1,
      pixel: [30, 40],
      actor: null,
      point: [9, 8, 7],
    }),
  );
  const mark = f.c.displayMarks()[0];
  assert.equal(mark.actor, undefined);
  assert.deepEqual(mark.points, [[9, 8, 7]]);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: 1, pixel: [30, 40], point: [9, 8, 7] }),
  );
  assert.equal(f.c.displayMarks().length, 1);
  f.c.stop();
});

test("Marker release attaches to the actor at release rather than the actor at press", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.setTool("marker");
  const [before, after] = f.c.getSnapshot().replay!.actors;
  f.engine.hover_annotation = () => {};
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [10, 20], actor: before.key }),
  );
  f.c.placeSceneMarkerAt(30, 40);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: 1, pixel: [30, 40], actor: after.key }),
  );
  assert.equal(f.c.displayMarks()[0].actor, after.key);
  f.c.stop();
});

test("Label drawing retains the captured unselected actor and its name", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("label");
  const actor = f.c.getSnapshot().replay!.actors[0];
  assert.equal(f.c.selectedActorForDrawing(), null);
  assert.equal(f.c.startActorDrawing(actor.key), true);
  f.c.finishDrawing();
  const label = f.c.displayMarks()[0];
  assert.equal(label.type, "label");
  assert.equal(label.actor, actor.key);
  assert.equal(label.label, actor.name);
  f.c.stop();
});

test("Marker release preserves explicit actor selection after validating the release hit", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("marker");
  const actor = f.c.getSnapshot().replay!.actors[0];
  f.c.selectActor(actor.key);
  const requests: unknown[] = [];
  f.engine.hover_annotation = (...args) => requests.push(args);
  f.c.placeSceneMarkerAt(30, 40);
  assert.equal(f.c.displayMarks().length, 0);
  assert.deepEqual(requests, [[30, 40, true, 1]]);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      request: 1,
      pixel: [30, 40],
      actor: null,
      point: [9, 8, 7],
    }),
  );
  assert.equal(f.c.displayMarks()[0].actor, actor.key);
  f.c.stop();
});

test("Selected-actor marker release over native UI cannot attach a marker", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("marker");
  const actor = f.c.getSnapshot().replay!.actors[0];
  f.c.selectActor(actor.key);
  f.engine.hover_annotation = () => {};
  f.c.placeSceneMarkerAt(30, 40);
  assert.equal(f.c.displayMarks().length, 0);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      request: 1,
      pixel: [30, 40],
      nativeUI: true,
      actor: actor.key,
    }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.stop();
});

test("Reduced engines retain explicit actor attachment without a hover API", () => {
  const f = fixture();
  f.c.seek(1000);
  f.c.setTool("marker");
  const actor = f.c.getSnapshot().replay!.actors[0];
  f.c.selectActor(actor.key);
  assert.equal(f.engine.hover_annotation, undefined);
  f.c.placeSceneMarkerAt(30, 40);
  assert.equal(f.c.displayMarks()[0].actor, actor.key);
  f.c.stop();
});

test("Cancelled marker release hits cannot place after a tool change or over native UI", () => {
  const f = fixture();
  f.c.setTool("marker");
  f.engine.hover_annotation = () => {};
  f.c.placeSceneMarkerAt(30, 40);
  f.c.setTool("label");
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: 1, pixel: [30, 40], point: [9, 8, 7] }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.setTool("marker");
  f.c.placeSceneMarkerAt(30, 40);
  f.c.cancelDrawing();
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: 1, pixel: [30, 40], point: [9, 8, 7] }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.placeSceneMarkerAt(30, 40);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      request: 3,
      pixel: [30, 40],
      nativeUI: true,
      point: [9, 8, 7],
    }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.stop();
});

test("Same-pixel hover and cancelled marker callbacks cannot complete a newer release", () => {
  const f = fixture();
  f.c.setTool("marker");
  const requests: number[] = [];
  f.engine.hover_annotation = (_x, _y, _placing, request) => {
    if (request !== undefined) requests.push(request);
  };
  f.c.placeSceneMarkerAt(30, 40);
  f.c.cancelDrawing();
  f.c.placeSceneMarkerAt(30, 40);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [30, 40], point: [1, 2, 3] }),
  );
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: requests[0], pixel: [30, 40], point: [1, 2, 3] }),
  );
  assert.equal(f.c.displayMarks().length, 0);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ request: requests[1], pixel: [30, 40], point: [9, 8, 7] }),
  );
  assert.deepEqual(f.c.displayMarks()[0].points, [[9, 8, 7]]);
  f.c.stop();
});

test("Exact click coordinates select actors in Analyse and obey selection filters", () => {
  const f = fixture(),
    actor = f.c.getSnapshot().replay!.actors[0];
  f.c.setWorkspaceMode("analyse");
  f.c.selectSceneAt(10, 20);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [11, 20], actor: actor.key }),
  );
  assert.equal(f.c.getSnapshot().selected, null);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [10, 20], actor: actor.key }),
  );
  assert.equal(f.c.getSnapshot().selected, actor.key);
  assert.equal(f.c.getSnapshot().workspaceMode, "analyse");
  f.c.setSelectionFilter("drawings");
  f.c.selectSceneAt(30, 40);
  f.c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [30, 40], actor: actor.key }),
  );
  assert.equal(f.c.getSnapshot().selected, null);
  f.c.stop();
});
test("An edit can attach to a planned actor, follow it, and detach at its displayed location", () => {
  const f = fixture();
  f.c.planFromMoment();
  const actor = f.c.snapshot()!.actors[0];
  f.c.setTool("circle");
  f.c.receive("point", JSON.stringify([0, 0, 0]));
  f.c.finishDrawing();
  const edit = f.c.getSnapshot().plan.steps.at(-1)!.annotations[0];
  assert.ok(edit);
  f.c.attachEdit(edit.id, actor.key);
  assert.deepEqual(
    f.c.displayMarks().find((a) => a.id === edit.id)!.points[0],
    actor.position,
  );
  f.c.selectActor(actor.key);
  f.c.positionActors(0, actor.position[0] + 10);
  const displayed = structuredClone(
    f.c.displayMarks().find((a) => a.id === edit.id)!.points,
  );
  f.c.attachEdit(edit.id, null);
  const detached = f.c
    .getSnapshot()
    .plan.steps.flatMap((s) => s.annotations)
    .find((a) => a.id === edit.id)!;
  assert.equal(detached.actor, undefined);
  assert.deepEqual(detached.points, displayed);
  f.c.stop();
});

test("Modifier selections keep the chosen drawing tool in map and native selection paths", () => {
  const c = new EditorController();
  c.setTool("circle");
  c.receive("point", "[0,0,0]");
  c.receive("point", "[5,0,0]");
  const id = c.getSnapshot().selectedMark!;
  c.setTool("arrow");
  c.selectMarks([id]);
  assert.equal(c.getSnapshot().tool, "arrow");
  c.selectSceneAt(20, 30);
  c.receive(
    "plan-hover",
    JSON.stringify({ pixel: [20, 30], id, handle: null, point: [0, 0, 0] }),
  );
  assert.equal(c.getSnapshot().tool, "arrow");
  assert.equal(c.getSnapshot().selectedMark, id);
  c.stop();
});
test("Default edit grips are visible without choosing a transform tool and resize as one undo", () => {
  const c = new EditorController();
  c.setTool("circle");
  c.receive("point", "[0,0,0]");
  c.receive("point", "[5,0,0]");
  const mark = c.displayMarks()[0],
    geometry = c.markGeometry(mark);
  assert.equal(c.getSnapshot().transformActive, false);
  assert.equal(geometry.handles.length, 9);
  c.beginMarkDrag(mark.id, 5, [-5, 0, 0]);
  c.receive("point", "[-20,0,0]");
  c.finishDrawing();
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  c.undo();
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 5);
  c.stop();
});
test("Automatic rotation and size handles work independently of the active drawing tool", () => {
  const c = new EditorController();
  c.setTool("arrow");
  c.receive("point", "[0,0,0]");
  c.receive("point", "[10,0,0]");
  c.finishDrawing();
  let edit = c.displayMarks()[0],
    g = c.markGeometry(edit);
  const rotate = g.handleKinds!.indexOf("rotate");
  const start = g.handles[rotate];
  assert.ok(c.beginMarkDrag(edit.id, rotate, start));
  c.receive("point", JSON.stringify([-start[1], start[0], 0]));
  c.finishDrawing();
  let point = c.getSnapshot().plan.steps[0].annotations[0].points[1];
  assert.ok(Math.abs(point[0]) < 1e-5);
  assert.ok(Math.abs(point[1] - 10) < 1e-5);
  c.undo();
  edit = c.displayMarks()[0];
  g = c.markGeometry(edit);
  const scale = g.handleKinds!.indexOf("scale"),
    p = g.handles[scale];
  c.beginMarkDrag(edit.id, scale, p);
  c.receive("point", JSON.stringify([p[0] * 2, p[1] * 2, 0]));
  c.finishDrawing();
  point = c.getSnapshot().plan.steps[0].annotations[0].points[1];
  assert.ok(Math.abs(point[0] - 20) < 1e-5);
  c.stop();
});

test("Attached ranges keep their actor anchor while resizing through a visible grip", () => {
  const f = fixture();
  f.c.planFromMoment();
  const actor = f.c.snapshot()!.actors[0];
  f.c.attachRange(actor.key);
  const edit = f.c.displayMarks().find((a) => a.actor === actor.key)!;
  const grips = f.c.markGeometry(edit);
  assert.ok(grips.handles.length >= 8);
  assert.equal(grips.handleKinds![0], "resize");
  const start = grips.handles[0],
    anchor = edit.points[0];
  f.c.beginMarkDrag(edit.id, 0, start);
  f.c.receive("point", JSON.stringify([anchor[0] + 25, anchor[1], anchor[2]]));
  f.c.finishDrawing();
  const saved = f.c
    .getSnapshot()
    .plan.steps.flatMap((s) => s.annotations)
    .find((a) => a.id === edit.id)!;
  assert.equal(saved.actor, actor.key);
  assert.equal(saved.size, 25);
  f.c.stop();
});

test("Selecting a recorded actor shows move grips and only dragging creates the planned arrangement", () => {
  const f = fixture();
  f.c.seek(5000);
  const actor = f.c.getSnapshot().replay!.actors[0],
    pose = f.c.actorPose(actor)!;
  const original = structuredClone(f.c.getSnapshot().replay!.raw),
    pages = f.c.getSnapshot().plan.steps.length;
  f.c.selectActor(actor.key);
  assert.equal(f.c.getSnapshot().workspaceMode, "analyse");
  assert.equal(f.c.getSnapshot().plan.steps.length, pages);
  assert.equal(f.c.actorGizmo().length, 1);
  const anchor: [number, number, number] = [
    pose.pos[0],
    pose.pos[1],
    pose.pos[2] ?? 0,
  ];
  assert.ok(f.c.beginActorDrag(actor.key, anchor));
  assert.equal(f.c.getSnapshot().workspaceMode, "plan");
  const captured = structuredClone(
    f.c.snapshot()!.actors.find((a) => a.key === actor.key)!,
  );
  f.c.receive(
    "point",
    JSON.stringify([anchor[0] + 8, anchor[1] + 3, anchor[2]]),
  );
  f.c.finishDrawing();
  const moved = f.c.snapshot()!.actors.find((a) => a.key === actor.key)!;
  assert.equal(moved.position[0], captured.position[0] + 8);
  f.c.undo();
  assert.deepEqual(
    f.c.snapshot()!.actors.find((a) => a.key === actor.key)!.position,
    captured.position,
  );
  assert.deepEqual(f.c.getSnapshot().replay!.raw, original);
  f.c.stop();
});
test("Dragging a marking with an actor selected starts at that actor's exact centre", () => {
  const f = fixture();
  f.c.seek(5000);
  const actor = f.c.getSnapshot().replay!.actors[0];
  f.c.selectActor(actor.key);
  f.c.setTool("circle");
  const pose = f.c.actorPose(actor)!;
  assert.equal(f.c.selectedActorForDrawing(), actor.key);
  assert.ok(f.c.startActorDrawing(f.c.selectedActorForDrawing()!));
  f.c.receive(
    "point",
    JSON.stringify([pose.pos[0] + 20, pose.pos[1], pose.pos[2] ?? 0]),
  );
  f.c.finishDrawing();
  const circle = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.equal(circle.actor, actor.key);
  assert.equal(circle.points[0][0], pose.pos[0]);
  assert.equal(circle.points[0][1], pose.pos[1]);
  assert.equal(circle.size, 20);
  f.c.stop();
});
test("A marker palette click marks the selected enemy and never overwrites an attached range", () => {
  const f = fixture();
  f.c.seek(5000);
  const enemy = f.c.getSnapshot().replay!.actors.find((a) => a.type === "NPC")!;
  f.c.setWorkspaceMode("plan");
  f.c.attachRange(enemy.key, 30);
  f.c.selectActor(enemy.key);
  f.c.applyMarker("8");
  let edits = f.c.getSnapshot().plan.steps[0].annotations;
  assert.equal(edits.find((a) => a.type === "circle")!.size, 30);
  assert.equal(edits.find((a) => a.type === "marker")!.actor, enemy.key);
  assert.equal(edits.find((a) => a.type === "marker")!.icon, "8");
  f.c.selectActor(enemy.key);
  f.c.applyMarker("1");
  edits = f.c.getSnapshot().plan.steps[0].annotations;
  assert.equal(edits.filter((a) => a.type === "marker").length, 1);
  assert.equal(edits.find((a) => a.type === "marker")!.icon, "1");
  f.c.stop();
});

test("Unit clicks win over area fills underneath, while an explicit edit grip stays selectable", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.setTool("circle");
  f.c.receive("point", "[0,0,0]");
  f.c.receive("point", "[20,0,0]");
  const circle = f.c.getSnapshot().selectedMark!,
    actor = f.c.getSnapshot().replay!.actors[0];
  f.c.selectSceneAt(100, 100);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      pixel: [100, 100],
      id: circle,
      actor: actor.key,
      handle: null,
    }),
  );
  assert.equal(f.c.getSnapshot().selected, actor.key);
  assert.equal(f.c.getSnapshot().selectedMark, null);
  f.c.selectSceneAt(101, 101);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      pixel: [101, 101],
      id: circle,
      actor: actor.key,
      handle: 1,
    }),
  );
  assert.equal(f.c.getSnapshot().selectedMark, circle);
  f.c.stop();
});

test("2D actor moves capture large Warcraft Logs identities from paused or playing replay without changing the recording", () => {
  for (const playing of [false, true]) {
    const f = fixture(),
      replay = structuredClone(raw);
    (replay.actors[0] as { gameID: number }).gameID = 77_753_361;
    f.c.installReplay(replay);
    f.c.seek(4500);
    f.c.setMapView(true);
    if (playing) f.c.toggle();
    const recording = structuredClone(f.c.getSnapshot().replay!.raw),
      actor = f.c.sceneActors().find((a) => a.key === "1:1")!,
      pose = f.c.actorPose(actor)!,
      anchor: [number, number, number] = [
        pose.pos[0],
        pose.pos[1],
        pose.pos[2] ?? -108,
      ];
    f.c.selectActor(actor.key);
    assert.ok(f.c.beginActorDrag(actor.key, anchor));
    assert.equal(f.c.getSnapshot().playing, false);
    assert.equal(f.c.getSnapshot().workspaceMode, "plan");
    assert.equal(f.c.snapshot()!.time, 4500);
    const captured = structuredClone(
      f.c.snapshot()!.actors.find((a) => a.key === actor.key)!,
    );
    assert.equal(captured.gameID, 77_753_361);
    f.c.pickMap(anchor[0] + 6, anchor[1] + 4, anchor[2]);
    assert.deepEqual(f.mapPicks.at(-1), [
      anchor[0] + 6,
      anchor[1] + 4,
      anchor[2],
    ]);
    f.c.receive(
      "point",
      JSON.stringify([anchor[0] + 6, anchor[1] + 4, anchor[2]]),
    );
    f.c.finishDrawing();
    const moved = f.c.snapshot()!.actors.find((a) => a.key === actor.key)!;
    assert.equal(moved.position[0], captured.position[0] + 6);
    assert.equal(moved.position[1], captured.position[1] + 4);
    assert.deepEqual(moved.recorded, captured.recorded);
    assert.equal(moved.gameID, captured.gameID);
    f.c.undo();
    assert.deepEqual(
      f.c.snapshot()!.actors.find((a) => a.key === actor.key)!.position,
      captured.position,
    );
    assert.deepEqual(f.c.getSnapshot().replay!.raw, recording);
    f.c.stop();
  }
});

test("Native UI clicks preserve actor focus instead of selecting the empty scene behind raid frames", () => {
  const f = fixture();
  f.c.select("1:1");
  f.c.selectSceneAt(20, 20);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      nativeUI: true,
      pixel: [20, 20],
      actor: null,
      id: null,
      handle: null,
      point: null,
      locked: false,
    }),
  );
  assert.equal(f.c.getSnapshot().selected, "1:1");
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      pixel: [20, 20],
      actor: null,
      id: null,
      handle: null,
      point: null,
      locked: false,
    }),
  );
  assert.equal(
    f.c.getSnapshot().selected,
    "1:1",
    "the consumed raid click must not leave a pending world selection",
  );
  f.c.selectSceneAt(400, 400);
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      nativeUI: true,
      pixel: [20, 20],
      actor: null,
      id: null,
      handle: null,
      point: null,
      locked: false,
    }),
  );
  f.c.receive(
    "plan-hover",
    JSON.stringify({
      pixel: [400, 400],
      actor: "2:1",
      id: null,
      handle: null,
      point: null,
      locked: false,
    }),
  );
  assert.equal(f.c.getSnapshot().selected, "2:1");
  f.c.stop();
});

test("Raid-frame focus uses normal framing and preserves and retargets Free, Follow and Orbit", () => {
  for (const mode of ["free", "follow", "orbit"] as const) {
    const f = fixture();
    f.c.installReplay({
      ...raw,
      actors: [
        ...raw.actors,
        { id: 3, name: "Healer", type: "Player", subType: "Priest" },
      ],
      events: [
        ...raw.events,
        {
          timestamp: 2000,
          type: "damage",
          sourceID: 3,
          targetID: 2,
          resourceActor: 1,
          x: 500,
          y: 600,
          abilityGameID: 133,
          amount: 1,
        },
      ],
    } as RawReplay);
    f.c.seek(4500);
    if (mode === "free") f.c.setOption("followRaid", false);
    if (mode === "orbit") {
      f.c.select("1:1");
      f.c.setCameraMode("orbit");
    }
    const before = f.focus.length;
    f.c.receive("focus-actor", "3:1");
    assert.equal(f.c.getSnapshot().selected, "3:1");
    assert.ok(f.focus.length > before);
    assert.equal(f.c.getSnapshot().options.followRaid, mode === "follow");
    assert.equal(
      f.c.getSnapshot().cameraMode,
      mode === "orbit" ? "orbit" : "free",
    );
    if (mode === "orbit") assert.equal(f.c.getSnapshot().orbitTarget, "3:1");
    if (mode === "follow") {
      assert.deepEqual(f.cameraSettings.at(-1), [40, "3:1"]);
      assert.ok(f.cameraSubjects.at(-1)!.includes("3:1"));
    }
    f.c.stop();
  }
});

test("Player class identities stay fixed across recorded positions, estimated gaps, wisps and returning samples", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    fight: {
      ...raw.fight,
      chapters: [
        { id: 1, name: "First pull", startTime: 1000, endTime: 2500 },
        { id: 2, name: "Next pull", startTime: 9000, endTime: 12000 },
      ],
    },
    actors: [
      { id: 1, name: "Warrior", type: "Player", subType: "Warrior" },
      raw.actors[1],
      { id: 3, name: "Priest", type: "Player", subType: "Priest" },
    ],
    events: [
      {
        timestamp: 2000,
        type: "damage",
        sourceID: 1,
        targetID: 2,
        resourceActor: 1,
        x: 100,
        y: 200,
        hitPoints: 100,
        maxHitPoints: 100,
      },
      {
        timestamp: 2000,
        type: "heal",
        sourceID: 3,
        targetID: 1,
        resourceActor: 1,
        x: 200,
        y: 300,
        hitPoints: 100,
        maxHitPoints: 100,
      },
      {
        timestamp: 9000,
        type: "damage",
        sourceID: 1,
        targetID: 2,
        resourceActor: 1,
        x: 300,
        y: 700,
        hitPoints: 100,
        maxHitPoints: 100,
      },
      {
        timestamp: 9000,
        type: "heal",
        sourceID: 3,
        targetID: 1,
        resourceActor: 1,
        x: 400,
        y: 800,
        hitPoints: 100,
        maxHitPoints: 100,
      },
    ],
  } as RawReplay);
  for (const time of [1000, 3000, 6500, 8000]) {
    f.c.seek(time);
    const warrior = f.frame.find((a) => a.key === "1:1")!,
      priest = f.frame.find((a) => a.key === "3:1")!;
    assert.equal(warrior.class, 1);
    assert.equal(priest.class, 5);
    if (time === 3000) assert.equal(warrior.estimated, true);
    if (time === 6500) {
      assert.equal(warrior.wisp, true);
      assert.equal(priest.wisp, true);
    }
    if (time === 8000) assert.equal(warrior.wisp, false);
  }
  f.c.stop();
});

test("Revealing an actor edit preserves a visible paused moment and additive selection", () => {
  const f = fixture();
  f.c.seek(5000);
  f.c.planFromMoment();
  f.c.updateStep({ start: 0, end: 11000 });
  const page = f.c.getSnapshot().activeStep;
  const actors = f.c.snapshot()!.actors;
  assert.ok(actors.length >= 2);
  f.c.seek(8000);
  f.c.revealActorEdit(actors[0].key, page);
  assert.equal(f.c.getSnapshot().time, 8000);
  f.c.revealActorEdit(actors[1].key, page, true);
  assert.equal(f.c.getSnapshot().time, 8000);
  assert.deepEqual(f.c.getSnapshot().selectedActors, [
    actors[0].key,
    actors[1].key,
  ]);
  f.c.revealActorEdit(actors[0].key, "missing-page");
  assert.equal(f.c.getSnapshot().time, 8000);
  f.c.stop();
});

test("Existing range handles never expose new-drawing CAD controls", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.setTool("circle");
  c.receive("point", JSON.stringify([0, 0, 0]));
  assert.equal(c.numericDrawingAvailable(), true);
  c.setDrawingDimension("20");
  c.confirmDrawingDimension();
  const mark = c.getSnapshot().plan.steps[0].annotations[0];
  assert.ok(c.beginMarkDrag(mark.id, 1, [20, 0, 0]));
  assert.equal(c.numericDrawingAvailable(), false);
  c.receive("point", JSON.stringify([30, 0, 0]));
  c.finishDrawing();
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 30);
  c.undo();
  assert.equal(c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  c.stop();
});

test("2D edits use resolved local floors without depending on visible native collision cells", () => {
  const f = fixture();
  f.c.setWorkspaceMode("plan");
  f.c.setTool("circle");
  f.c.pickMap(10, 20, 37, false, false, true);
  f.c.pickMap(30, 20, 37, false, true, true);
  f.c.finishDrawing();
  const mark = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.equal(mark.size, 20);
  assert.equal(mark.points[0][2], 37);
  assert.equal(f.mapPicks.length, 0);
  assert.ok(f.c.beginMarkDrag(mark.id, 1, [30, 20, 37]));
  f.c.pickMap(40, 20, 999, false, false);
  assert.equal(f.mapPicks.length, 0);
  f.c.finishDrawing();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].size, 30);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations[0].size, 20);
  f.c.pickMap(NaN, 20, 37, false, false, true);
  assert.equal(f.mapPicks.length, 0);
  f.c.stop();
});

test("Local map floors cannot overtake native picks and cancelled queues cannot leak into another page", () => {
  const f = fixture();
  const requests: { x: number; token: number }[] = [];
  f.c.attachEngine({
    ...f.engine,
    pick_map_for_annotation: (
      x: number,
      _y: number,
      _z: number,
      token: number,
    ) => requests.push({ x, token }),
  } as unknown as Engine);
  f.c.setTool("circle");
  f.c.pickMap(10, 20, 37);
  f.c.pickMap(30, 20, 37, false, true, true);
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  f.c.finishDrawing();
  f.c.receive(
    "plan-point",
    JSON.stringify({ token: requests[0].token, point: [10, 20, 37] }),
  );
  const mark = f.c.getSnapshot().plan.steps[0].annotations[0];
  assert.deepEqual(mark.points[0], [10, 20, 37]);
  assert.equal(mark.size, 20);
  assert.equal(f.c.getSnapshot().drawing, false);
  f.c.undo();
  assert.equal(f.c.getSnapshot().plan.steps[0].annotations.length, 0);
  f.c.setTool("circle");
  f.c.pickMap(40, 20, 37);
  f.c.pickMap(60, 20, 37, false, true, true);
  const stale = requests.at(-1)!.token;
  f.c.addStep();
  f.c.receive(
    "plan-point",
    JSON.stringify({ token: stale, point: [40, 20, 37] }),
  );
  assert.equal(f.c.getSnapshot().plan.steps[1].annotations.length, 0);
  f.c.stop();
});

test("Paused RAF skips unchanged replay publication and native frames while preserving invalidation and playback", () => {
  const f = fixture();
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  let callback: FrameRequestCallback | undefined;
  let id = 0;
  globalThis.requestAnimationFrame = (next) => {
    callback = next;
    return ++id;
  };
  globalThis.cancelAnimationFrame = () => {};
  let frames = 0;
  const send = f.engine.set_replay_frame;
  f.engine.set_replay_frame = (json) => {
    frames++;
    send(json);
  };
  const step = (time: number) => {
    assert.ok(callback);
    callback(time);
  };
  let publications = 0;
  const unsubscribe = f.c.subscribe(() => publications++);
  try {
    f.c.seek(5000);
    const paused = f.c.getSnapshot();
    frames = 0;
    publications = 0;
    f.c.start();
    step(100);
    step(160);
    step(220);
    assert.equal(frames, 0);
    assert.equal(publications, 0);
    assert.equal(f.c.getSnapshot(), paused);
    f.c.receive(
      "actors",
      JSON.stringify({ selected: null, visualEvents: 0, unsupported: 0 }),
    );
    step(280);
    assert.equal(frames, 0);
    assert.equal(publications, 0);
    f.c.setMapView(true);
    step(340);
    assert.equal(frames, 1);
    f.c.setOption("auras", false);
    assert.equal(frames, 2);
    step(400);
    assert.equal(frames, 2);
    f.c.setAppearance(f.c.getSnapshot().replay!.actors[0], "race", 2);
    assert.equal(frames, 3);
    f.c.toggle();
    const playingTime = f.c.getSnapshot().time;
    const playingFrames = frames;
    step(460);
    step(476);
    assert.ok(frames > playingFrames);
    assert.ok(f.c.getSnapshot().time > playingTime);
    f.c.seek(1000);
    const rewound = f.c.getSnapshot();
    const seekFrames = frames;
    step(540);
    step(600);
    assert.equal(frames, seekFrames);
    assert.equal(f.c.getSnapshot(), rewound);
    assert.equal(rewound.time, 1000);
  } finally {
    f.c.stop();
    unsubscribe();
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
  }
});

test("Paused scheduling retains state changes from synchronous native frame callbacks", () => {
  const f = fixture();
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  let callback: FrameRequestCallback | undefined;
  globalThis.requestAnimationFrame = (next) => {
    callback = next;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  let frames = 0;
  let echo = true;
  const send = f.engine.set_replay_frame;
  f.engine.set_replay_frame = (json) => {
    frames++;
    send(json);
    if (echo) {
      echo = false;
      f.c.receive(
        "actors",
        JSON.stringify({ selected: "1:1", visualEvents: 0, unsupported: 0 }),
      );
    }
  };
  try {
    f.c.seek(5000);
    assert.equal(f.c.getSnapshot().selected, "1:1");
    const before = frames;
    f.c.start();
    callback!(100);
    assert.equal(frames, before + 1);
    callback!(160);
    assert.equal(frames, before + 1);
  } finally {
    f.c.stop();
    globalThis.requestAnimationFrame = request;
    globalThis.cancelAnimationFrame = cancel;
  }
});

test("Analyse ranges update on paused seek, never become plan edits, and clear in Plan", () => {
  const f = fixture();
  const plan = f.c.getSnapshot().plan;
  const lastRanges = () =>
    (
      f.annotations.at(-1) as unknown as {
        ranges: { key: string; radius: number; status: string }[];
      }
    ).ranges;
  f.c.seek(2000);
  f.c.setRangeCheck({ enabled: true, radius: 20 });
  assert.equal(f.c.getSnapshot().playing, false);
  assert.deepEqual(lastRanges(), [{ key: "1:1", radius: 20, status: "clear" }]);
  f.c.setRangeCheck({ group: "individuals", players: [] });
  assert.deepEqual(lastRanges(), []);
  f.c.setRangeCheck({ players: ["1:1"] });
  assert.equal(lastRanges()[0].key, "1:1");
  f.c.seek(3000);
  assert.equal(lastRanges()[0].radius, 20);
  assert.equal(f.c.getSnapshot().plan, plan);
  f.c.setWorkspaceMode("plan");
  assert.deepEqual(lastRanges(), []);
  f.c.setWorkspaceMode("analyse");
  assert.equal(lastRanges()[0].radius, 20);
  f.c.setOption("actors", false);
  assert.deepEqual(lastRanges(), []);
  f.c.setOption("actors", true);
  f.c.setRangeCheck({ enabled: false });
  assert.deepEqual(lastRanges(), []);
  f.c.stop();
});

test("Range individuals belong to their report and persist only within that report", () => {
  const f = fixture();
  f.c.setRangeCheck({
    enabled: true,
    group: "individuals",
    players: ["1:1"],
    radius: 8,
  });
  f.c.installReplay(structuredClone(raw));
  assert.deepEqual(f.c.getSnapshot().rangeCheck.players, ["1:1"]);
  const different = structuredClone(raw);
  different.report.code = "OtherReport";
  f.c.installReplay(different);
  assert.deepEqual(f.c.getSnapshot().rangeCheck.players, []);
  assert.equal(f.c.getSnapshot().rangeCheck.radius, 8);
  assert.equal(f.c.getSnapshot().rangeCheck.enabled, true);
  f.c.stop();
});

test("Cached project switching retains Individuals for the same report and clears them for other sources", async () => {
  const store = new IndexedProjectStore(new IDBFactory());
  const sources = [
    structuredClone(raw),
    structuredClone(raw),
    structuredClone(raw),
  ];
  sources[1].fight.id = 2;
  sources[2].report.code = "KYTDxtWk6qLvrG1Q";
  const projects = [];
  for (const source of sources) {
    const project = newProject(emptyPlan(409), replaySource(source, 409));
    project.mode = "analyse";
    await store.putReplay(project.source!.cacheKey, source);
    await store.put(project);
    projects.push(project);
  }
  const c = new EditorController(undefined, {
    projectStore: store,
    clientCache: null,
    clientFolders: null,
  });
  assert.equal(await c.openProject(projects[0].id), true);
  c.setRangeCheck({
    enabled: true,
    group: "individuals",
    players: ["1:1"],
    radius: 8,
  });
  assert.equal(await c.openProject(projects[1].id), true);
  assert.deepEqual(c.getSnapshot().rangeCheck.players, ["1:1"]);
  assert.equal(await c.openProject(projects[2].id), true);
  assert.deepEqual(c.getSnapshot().rangeCheck.players, []);
  c.setRangeCheck({ players: ["1:1"] });
  c.installReplay({ ...sources[2], gameVersion: "sod" });
  assert.deepEqual(c.getSnapshot().rangeCheck.players, []);
  assert.equal(c.getSnapshot().rangeCheck.radius, 8);
  c.stop();
});

test("short playback segments reach native routing, including paused seeks, but plan snapshots do not", () => {
  const f = fixture();
  f.c.installReplay({
    ...raw,
    events: [
      {
        timestamp: 1000,
        type: "cast",
        sourceID: 1,
        resourceActor: 1,
        x: 100,
        y: 200,
      },
      {
        timestamp: 2000,
        type: "cast",
        sourceID: 1,
        resourceActor: 1,
        x: 100,
        y: 800,
      },
    ],
  } as unknown as RawReplay);
  for (const sample of f.c
    .getSnapshot()
    .replay!.actors.find((a) => a.key === "1:1")!.samples)
    sample[3] = 37;
  f.c.seek(500);
  const player = f.frame.find((a) => a.key === "1:1") as unknown as {
    speed: number;
    movement: { from: number[]; to: number[]; fraction: number; rate: number };
  };
  assert.ok(player.movement);
  assert.deepEqual(player.movement.from.slice(0, 2), [2, -1]);
  assert.deepEqual(player.movement.to.slice(0, 2), [8, -1]);
  assert.equal(player.movement.fraction, 0.5);
  assert.equal(player.speed, 0);
  assert.ok(player.movement.rate > 0);
  f.c.seek(900);
  f.c.seek(500);
  assert.deepEqual(
    (f.frame.find((a) => a.key === "1:1") as unknown as typeof player).movement,
    player.movement,
  );
  f.c.setWorkspaceMode("plan");
  assert.ok(
    (f.frame.find((a) => a.key === "1:1") as unknown as typeof player).movement,
  );
  f.c.planFromMoment();
  assert.ok(f.c.displaySnapshot());
  assert.ok(
    f.frame.every((a) => !(a as unknown as { movement?: unknown }).movement),
  );
  f.c.stop();
});

test("native movement requires a known height for each endpoint and keeps grounded fallback", () => {
  const cases: [number | null, number | null, number | undefined, boolean][] = [
    [null, null, undefined, false],
    [10, null, undefined, false],
    [null, 11, undefined, false],
    [10, 11, undefined, true],
    [0, 0, undefined, true],
    [null, null, 0, true],
    [10, null, 12, true],
    [null, 11, 12, true],
  ];
  for (const [from, to, hint, enabled] of cases) {
    const f = fixture();
    const actor = f.c
      .getSnapshot()
      .replay!.actors.find((a) => a.key === "1:1")!;
    actor.samples = [
      [0, 2, -1, from],
      [1000, 8, -1, to],
    ];
    // Control the floor service independently of the position observations.
    const floors = f.c as unknown as {
      replayFloors: () => Map<string, number>;
    };
    floors.replayFloors = () =>
      hint === undefined ? new Map() : new Map([[actor.key, hint]]);
    f.c.seek(500);
    const player = f.frame.find((a) => a.key === actor.key) as unknown as {
      position: number[];
      ground: boolean;
      movement: {
        from: number[];
        to: number[];
        from_inferred: boolean;
        to_inferred: boolean;
        floor_candidates: unknown[];
      } | null;
    };
    assert.ok(player.position);
    if (enabled) {
      assert.ok(player.movement);
      assert.equal(player.movement.from[2], from ?? hint);
      assert.equal(player.movement.to[2], to ?? hint);
      assert.equal(player.movement.from_inferred, from === null);
      assert.equal(player.movement.to_inferred, to === null);
      assert.deepEqual(player.movement.floor_candidates, []);
    } else {
      assert.equal(player.movement, null);
      assert.equal(player.ground, true);
      assert.deepEqual(player.position.slice(0, 2), [2, -1]);
    }
    f.c.stop();
  }
});

test("log mode places Vanilla and SoD NPCs at their first log position without reference actors", () => {
  for (const gameVersion of ["vanilla", "sod"] as const) {
    const f = fixture();
    f.c.installReplay({ ...structuredClone(raw), gameVersion });
    f.c.seek(0);
    const npcs = f.c.sceneActors().filter((a) => a.type === "NPC");
    assert.equal(npcs.length, 1);
    assert.equal(npcs[0].spawn, undefined);
    assert.deepEqual(
      f.frame.find((a) => a.key === npcs[0].key)?.position,
      [3, -2, 0],
    );
    f.c.seek(10000);
    assert.equal(
      f.frame.some((a) => a.key === npcs[0].key),
      false,
    );
    f.c.seek(0);
    assert.deepEqual(f.c.actorPose(npcs[0])?.pos, [3, -2, null]);
    f.c.stop();
  }
});

test("no-log reference spawns reach native frames, obey visibility and do not leak across maps or rulesets", () => {
  const c = new EditorController();
  let frame: NativeFrame[] = [];
  c.attachEngine({
    set_replay_frame: (json: string) => {
      frame = JSON.parse(json);
    },
    load_raid: () => {},
    replay_events: () => {},
    set_annotations: () => {},
  } as unknown as Engine);
  assert.equal(c.sceneActors().length, 233);
  assert.equal(frame.length, 233);
  const first = c.sceneActors()[0];
  assert.deepEqual(frame[0].position, first.spawn?.position);
  assert.equal(frame[0].friendly, false);
  c.setOption("actors", false);
  assert.equal(frame.length, 0);
  c.setOption("actors", true);
  assert.equal(frame.length, 233);
  c.selectRaid(469);
  c.render();
  assert.equal(frame.length, 311);
  assert.ok(frame.every((a) => a.key.startsWith("spawn:vanilla:469:")));
  c.setGameVersion("sod");
  c.render();
  assert.equal(frame.length, 311);
  assert.ok(frame.every((a) => a.key.startsWith("spawn:sod:469:")));
  assert.match(c.referenceSpawnNotice()!, /Classic baseline/);
  c.stop();
});

test("default NPC can be edited in a no-log plan without duplicating its reference slot", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  const actor = c.sceneActors()[0],
    pos = c.actorPose(actor)!.pos as [number, number, number];
  assert.equal(c.beginActorDrag(actor.key, pos), true);
  c.finishDrawing();
  assert.equal(c.snapshot()?.actors[0].key, actor.key);
  assert.equal(c.sceneActors().length, 233);
  c.setSnapBypass(true);
  c.selectActor(actor.key);
  c.nudgeActors(10, 0);
  assert.deepEqual(
    c.actorPose(c.sceneActors().find((a) => a.key === actor.key)!)?.pos,
    [pos[0] + 10, pos[1], pos[2]],
  );
  c.stop();
});

test("untouched reference NPC selection supports group nudges, coordinates, rotation and attached ranges", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.setSnapBypass(true);
  const actors = c.sceneActors().slice(0, 2),
    keys = actors.map((a) => a.key),
    positions = actors.map((a) => c.actorPose(a)!.pos);
  c.selectActors(keys);
  c.nudgeActors(10, 0);
  assert.deepEqual(c.getSnapshot().selectedActors, keys);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(c.snapshot()!.actors[i].position, [
      positions[i][0] + 10,
      positions[i][1],
      positions[i][2],
    ]);
  c.positionActors(0, positions[0][0] + 20);
  assert.equal(c.snapshot()!.actors[0].position[0], positions[0][0] + 20);
  c.transformSelection(90);
  assert.equal(
    c.snapshot()!.actors[0].facing,
    actors[0].spawn!.facing + Math.PI / 2,
  );
  const untouched = c.sceneActors().find((a) => !keys.includes(a.key))!;
  c.attachRange(untouched.key, 30);
  assert.equal(
    c.getSnapshot().plan.steps[0].annotations.at(-1)?.actor,
    untouched.key,
  );
  c.stop();
});

test("group drag moves both edited and untouched reference NPCs together", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.setSnapBypass(true);
  const [a, b] = c.sceneActors();
  c.selectActors([a.key]);
  c.nudgeActors(1, 0);
  c.selectActors([a.key, b.key]);
  const p = c.actorPose(a)!.pos as [number, number, number],
    q = c.actorPose(b)!.pos;
  assert.equal(c.beginActorDrag(a.key, p), true);
  c.receive("point", JSON.stringify([p[0] + 10, p[1] + 20, p[2]]));
  c.finishDrawing();
  assert.deepEqual(c.getSnapshot().selectedActors, [a.key, b.key]);
  assert.deepEqual(
    c.snapshot()!.actors.find((v) => v.key === b.key)!.position,
    [q[0] + 10, q[1] + 20, q[2]],
  );
  assert.equal(c.sceneActors().length, 233);
  c.stop();
});

test("Select All includes untouched and edited reference NPCs with drawings and respects selection filters", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  const keys = c.sceneActors().map((a) => a.key);
  assert.equal(c.snapshot(), undefined);
  c.selectAllMarks();
  assert.deepEqual(c.getSnapshot().selectedActors, keys);
  assert.equal(c.snapshot(), undefined);
  c.selectActors([keys[0]]);
  c.setSnapBypass(true);
  c.nudgeActors(5, 0);
  c.attachRange(keys[1], 30);
  const mark = c.getSnapshot().selectedMark!;
  c.selectAllMarks();
  assert.deepEqual(new Set(c.getSnapshot().selectedActors), new Set(keys));
  assert.deepEqual(c.getSnapshot().selectedMarks, [mark]);
  c.selectMark(null);
  c.clearActorSelection();
  c.setSelectionFilter("actors");
  c.selectAllMarks();
  assert.deepEqual(new Set(c.getSnapshot().selectedActors), new Set(keys));
  assert.deepEqual(c.getSnapshot().selectedMarks, []);
  c.clearActorSelection();
  c.setSelectionFilter("drawings");
  c.selectAllMarks();
  assert.deepEqual(c.getSnapshot().selectedActors, []);
  assert.deepEqual(c.getSnapshot().selectedMarks, [mark]);
  c.stop();
});

test("range attachment to an untouched reference NPC survives materialization and follows edits", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.setSnapBypass(true);
  const actor = c.sceneActors()[0],
    start = c.actorPose(actor)!.pos;
  c.attachRange(actor.key, 30);
  const id = c.getSnapshot().selectedMark!,
    displayed = () => c.displayMarks().find((m) => m.id === id)!;
  assert.equal(c.snapshot(), undefined);
  assert.equal(displayed().actor, actor.key);
  assert.deepEqual(displayed().points[0], start);
  c.selectActor(actor.key);
  c.nudgeActors(10, 0);
  assert.equal(displayed().actor, actor.key);
  assert.deepEqual(displayed().points[0], [start[0] + 10, start[1], start[2]]);
  c.setCompareRecorded(true);
  assert.deepEqual(displayed().points[0], start);
  c.setCompareRecorded(false);
  c.attachEdit(id, null);
  assert.equal(displayed().actor, undefined);
  assert.deepEqual(displayed().points[0], [start[0] + 10, start[1], start[2]]);
  c.selectActor(actor.key);
  c.nudgeActors(10, 0);
  assert.deepEqual(displayed().points[0], [start[0] + 10, start[1], start[2]]);
  c.stop();
});

test("standalone reference comparison sends recorded poses to native frames and restores unchanged planned edits", () => {
  const f = fixture(),
    c = f.c;
  c.selectRaid(469);
  c.setWorkspaceMode("plan");
  c.setSnapBypass(true);
  const actor = c.sceneActors()[0],
    original = c.actorPose(actor)!;
  c.selectActor(actor.key);
  c.nudgeActors(10, 0);
  c.transformSelection(90);
  c.render();
  const planned = structuredClone(
    c.snapshot()!.actors.find((a) => a.key === actor.key)!,
  );
  const snapshot = structuredClone(c.snapshot());
  const native = () => f.frame.find((a) => a.key === actor.key)!;
  assert.notDeepEqual(planned.position, original.pos);
  assert.notEqual(planned.facing, original.facing);
  assert.deepEqual(native().position, planned.position);
  assert.equal(native().facing, planned.facing);
  c.setCompareRecorded(true);
  assert.deepEqual(native().position, original.pos);
  assert.equal(native().facing, original.facing);
  assert.deepEqual(c.actorPose(actor)!.pos, native().position);
  assert.deepEqual(c.snapshot(), snapshot);
  c.setCompareRecorded(false);
  assert.deepEqual(native().position, planned.position);
  assert.equal(native().facing, planned.facing);
  assert.deepEqual(c.snapshot(), snapshot);
  c.stop();
});

test("SoD reference XY reaches native frames and local geometry supplies missing height before editing", () => {
  const f = fixture(),
    c = f.c;
  c.selectRaid(90, true, "sod");
  c.setWorkspaceMode("plan");
  const actor = c.sceneActors()[0],
    original = actor.spawn!.position;
  assert.equal(c.sceneActors().length, 292);
  assert.equal(original[2], null);
  const [x, y] = original;
  const geometry = new ReplayFloorGeometry([
    {
      area: "test-floor",
      interior: true,
      vertices: [
        [x - 2, y - 2, 12.5],
        [x + 2, y - 2, 12.5],
        [x + 2, y + 2, 12.5],
        [x - 2, y + 2, 12.5],
      ],
      indices: [0, 1, 2, 0, 2, 3],
    },
  ]);
  (
    c as unknown as { loadedFloors: Map<number, ReplayFloorGeometry> }
  ).loadedFloors.set(90, geometry);
  c.render();
  assert.deepEqual(f.frame.find((a) => a.key === actor.key)?.position, [
    x,
    y,
    12.5,
  ]);
  c.selectActor(actor.key);
  c.setSnapBypass(true);
  c.nudgeActors(1, 0);
  const planned = c.snapshot()!.actors.find((a) => a.key === actor.key)!;
  assert.deepEqual(planned.recorded, [x, y, 12.5]);
  assert.deepEqual(planned.position, [x + 1, y, 12.5]);
  c.setCompareRecorded(true);
  assert.deepEqual(f.frame.find((a) => a.key === actor.key)?.position, [
    x,
    y,
    12.5,
  ]);
  assert.equal(actor.spawn!.position[2], null);
  c.stop();
});

test("native movement resolves both ramp endpoint heights independently of the current actor floor", () => {
  const f = fixture();
  const replay = f.c.getSnapshot().replay!;
  const actor = replay.actors.find((a) => a.key === "1:1")!;
  actor.samples = [
    [0, 0, 1, null],
    [1000, 6, 1, null],
  ];
  const g = new ReplayFloorGeometry(
    [
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 0],
          [10, 0, 0],
          [0, 10, 0],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 10],
          [10, 0, 20],
          [0, 10, 10],
        ],
        indices: [0, 1, 2],
      },
      {
        area: "room",
        interior: true,
        vertices: [
          [0, 0, 30],
          [10, 0, 30],
          [0, 10, 30],
        ],
        indices: [0, 1, 2],
      },
    ],
    [{ id: "room", name: "stage", height: 25 }],
    [{ entry: 999, point: [0, 1, 10] }],
  );
  (
    f.c as unknown as { loadedFloors: Map<number, ReplayFloorGeometry> }
  ).loadedFloors.set(replay.map, g);
  for (const t of [500, 100, 900, 500]) {
    f.c.seek(t);
    const p = f.frame.find((u) => u.key === actor.key) as unknown as {
      movement: { from: number[]; to: number[] };
    };
    assert.equal(p.movement.from[2], 10);
    assert.equal(p.movement.to[2], 16);
  }
  f.c.stop();
});

test("nearby NPC floor hints do not pin both route endpoints to the current level", () => {
  const f = fixture();
  const replay = f.c.getSnapshot().replay!;
  const player = replay.actors.find((a) => a.key === "1:1")!;
  const npc = replay.actors.find((a) => a.key === "2:1")!;
  npc.samples = [[0, 1, 1, null]];
  const internals = f.c as unknown as {
    models: Record<string, unknown>;
    loadedFloors: Map<number, ReplayFloorGeometry>;
  };
  internals.models = { [npc.gameID]: { floorSeeds: [[replay.map, 1, 1, 0]] } };
  internals.loadedFloors.set(
    replay.map,
    new ReplayFloorGeometry(
      [
        {
          area: "room",
          interior: true,
          vertices: [
            [0, 0, 0],
            [20, 0, 0],
            [0, 20, 0],
          ],
          indices: [0, 1, 2],
        },
        {
          area: "room",
          interior: true,
          vertices: [
            [1, 0, 0],
            [5, 0, 5],
            [1, 10, 0],
            [5, 10, 5],
          ],
          indices: [0, 1, 2, 1, 3, 2],
        },
        {
          area: "room",
          interior: true,
          vertices: [
            [5, 0, 5],
            [15, 0, 5],
            [5, 10, 5],
          ],
          indices: [0, 1, 2],
        },
      ],
      [{ id: "room", name: "ramp and stage", height: 8 }],
      [{ entry: npc.gameID, point: [1, 1, 0] }],
    ),
  );
  for (const explicit of [null, 0, 12]) {
    player.samples = [
      [0, 1, 1, null],
      [1000, 7, 1, explicit],
    ];
    for (const t of [100, 900, 100]) {
      f.c.seek(t);
      const frame = f.frame.find((u) => u.key === player.key) as unknown as {
        movement: { from: number[]; to: number[] };
      };
      assert.equal(frame.movement.from[2], 0);
      assert.equal(frame.movement.to[2], explicit ?? 5);
    }
  }
  f.c.stop();
});

test("paused floor hints follow the effective presence filter in both workspace directions", () => {
  for (const firstMode of ["analyse", "plan"] as const) {
    const f = fixture();
    const replay = f.c.getSnapshot().replay!;
    const npc = replay.actors.find((a) => a.key === "2:1")!;
    npc.samples = [[0, 2, 2, null]];
    npc.deaths = [[0, true]];
    npc.runLifetime = false;
    delete npc.spawn;
    replay.actors = [...replay.actors];
    const internals = f.c as unknown as {
      loadedFloors: Map<number, ReplayFloorGeometry>;
      replayFloors: (value: typeof replay) => Map<string, number>;
    };
    internals.loadedFloors.set(
      replay.map,
      new ReplayFloorGeometry(
        [
          {
            area: "room",
            interior: true,
            vertices: [
              [0, 0, 37],
              [10, 0, 37],
              [0, 10, 37],
            ],
            indices: [0, 1, 2],
          },
        ],
        [],
        [],
      ),
    );
    f.c.seek(500);
    const modes =
      firstMode === "analyse"
        ? (["analyse", "plan", "analyse"] as const)
        : (["plan", "analyse", "plan"] as const);
    for (const mode of modes) {
      f.c.setWorkspaceMode(mode);
      f.c.render();
      assert.equal(f.c.getSnapshot().time, 500);
      assert.equal(f.c.getSnapshot().playing, false);
      const hints = internals.replayFloors(replay);
      assert.equal(
        hints.has(npc.key),
        mode === "plan",
        `${firstMode} -> ${mode}`,
      );
      if (mode === "plan") {
        assert.equal(hints.get(npc.key), 37);
      } else
        assert.equal(
          f.frame.some((a) => a.key === npc.key),
          false,
        );
      assert.equal(
        internals.replayFloors(replay),
        hints,
        "unchanged context keeps its cached map",
      );
    }
    f.c.stop();
  }
});

test("standalone SoD reference grounding respects its own level hint in stacked rooms", () => {
  const f = fixture(),
    c = f.c;
  c.selectRaid(90, true, "sod");
  const actor = c.sceneActors()[0],
    [x, y] = actor.spawn!.position;
  actor.spawn!.floorHint = 30;
  const floors = [10, 30].map((z) => ({
    area: "stacked-room",
    interior: true,
    vertices: [
      [x - 2, y - 2, z],
      [x + 2, y - 2, z],
      [x + 2, y + 2, z],
      [x - 2, y + 2, z],
    ] as [number, number, number][],
    indices: [0, 1, 2, 0, 2, 3],
  }));
  const geometry = new ReplayFloorGeometry(floors, [
    { id: "stacked-room", name: "stacked room", height: 20 },
  ]);
  (
    c as unknown as { loadedFloors: Map<number, ReplayFloorGeometry> }
  ).loadedFloors.set(90, geometry);
  c.render();
  assert.equal(c.actorPose(actor)?.pos[2], 30);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.position?.[2], 30);
  delete actor.spawn!.floorHint;
  c.render();
  assert.equal(c.actorPose(actor)?.pos[2], 10);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.position?.[2], 10);
  assert.equal(actor.spawn!.position[2], null);
  c.stop();
});

test("approximate room pins keep authored XY and nearby floor height through native frames and plan edits", () => {
  const f = fixture(),
    c = f.c;
  c.selectRaid(2856, true, "sod");
  c.setWorkspaceMode("plan");
  const actor = c
    .sceneActors()
    .find((a) => a.spawn?.referenceKind === "map-registered-reference")!;
  const [x, y] = actor.spawn!.position;
  const setGeometry = (edge: number) => {
    const rectangle = (z: number, left: number, room: boolean) => ({
      area: room ? "room" : "terrain",
      interior: room,
      vertices: [
        [left, y - 5, z],
        [x + 10, y - 5, z],
        [x + 10, y + 5, z],
        [left, y + 5, z],
      ] as [number, number, number][],
      indices: [0, 1, 2, 0, 2, 3],
    });
    (c as any).loadedFloors.set(
      2856,
      new ReplayFloorGeometry(
        [rectangle(330, x - 10, false), rectangle(185, x + edge, true)],
        [{ id: "room", name: "chapel", height: 186 }],
      ),
    );
    c.render();
  };
  setGeometry(1);
  assert.deepEqual(c.actorPose(actor)?.pos, [x, y, 185]);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.ground, false);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.position?.[2], 185);
  assert.deepEqual(actor.spawn!.position, [x, y, null]);
  actor.spawn!.referenceKind = "sod-reference";
  c.render();
  assert.equal(c.actorPose(actor)?.pos[2], 330);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.ground, true);
  actor.spawn!.referenceKind = "map-registered-reference";
  setGeometry(4);
  assert.equal(c.actorPose(actor)?.pos[2], 330);
  setGeometry(-1);
  assert.equal(c.actorPose(actor)?.pos[2], 185);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.ground, true);
  setGeometry(1);
  c.setSnapBypass(true);
  assert.equal(c.beginActorDrag(actor.key, [x, y, 185]), true);
  c.finishDrawing();
  c.selectActor(actor.key);
  c.nudgeActors(0, 0.1);
  assert.deepEqual(c.actorPose(actor)?.pos, [x, y + 0.1, 185]);
  assert.equal(f.frame.find((a) => a.key === actor.key)?.ground, false);
  assert.deepEqual(actor.spawn!.position, [x, y, null]);
  c.stop();
});

test("nearby reference scans cache misses and invalidate for actor identity, hints and geometry", () => {
  const c = new EditorController();
  c.selectRaid(2856, true, "sod");
  const actor = c
    .sceneActors()
    .find((a) => a.spawn?.referenceKind === "map-registered-reference")!;
  let calls = 0;
  const geometry = (answer: number | undefined) => {
    const value = new ReplayFloorGeometry([]);
    value.nearbyStructureHeight = () => {
      calls++;
      return answer;
    };
    return value;
  };
  (c as any).loadedFloors.set(2856, geometry(undefined));
  for (let i = 0; i < 20; i++) c.actorPose(actor);
  assert.equal(calls, 1, "undefined is a cached answer");
  c.actorPose({ ...actor });
  assert.equal(calls, 2, "same key on a different actor is independent");
  actor.spawn!.floorHint = 180;
  c.actorPose(actor);
  c.actorPose(actor);
  assert.equal(calls, 3);
  (c as any).loadedFloors.set(2856, geometry(185));
  for (let i = 0; i < 20; i++) assert.equal(c.actorPose(actor)?.pos[2], 185);
  assert.equal(calls, 4, "a new geometry instance invalidates the old answer");
  c.stop();
});

test("planned and recorded reference poses share the edge cache and invalidate moved coordinates", () => {
  const c = new EditorController();
  c.selectRaid(2856, true, "sod");
  c.setWorkspaceMode("plan");
  c.setSnapBypass(true);
  const actor = c
    .sceneActors()
    .find((a) => a.spawn?.referenceKind === "map-registered-reference")!;
  const [x, y] = actor.spawn!.position;
  let calls = 0;
  const geometry = new ReplayFloorGeometry([]);
  geometry.nearbyStructureHeight = (_x, queryY) => {
    calls++;
    return queryY === y ? 185 : undefined;
  };
  (c as any).loadedFloors.set(2856, geometry);
  assert.equal(c.actorPose(actor)?.pos[2], 185);
  assert.equal(c.beginActorDrag(actor.key, [x, y, 185]), true);
  c.finishDrawing();
  c.selectActor(actor.key);
  const held = (position: number[], nearby: boolean) => {
    const pose = c.actorPose(actor)!;
    assert.deepEqual(pose.pos, position);
    assert.ok("nearbyGround" in pose);
    assert.equal(pose.nearbyGround, nearby);
    const before = calls;
    for (let i = 0; i < 20; i++) c.actorPose(actor);
    assert.equal(
      calls,
      before,
      "held planned poses reuse positive and negative answers",
    );
  };
  held([x, y, 185], true);
  const beforeMove = calls;
  c.nudgeActors(0, 1);
  held([x, y + 1, 185], false);
  assert.equal(calls, beforeMove + 1);
  const beforeCompare = calls;
  c.setCompareRecorded(true);
  held([x, y, 185], true);
  assert.equal(calls, beforeCompare + 1);
  c.setCompareRecorded(false);
  held([x, y + 1, 185], false);
  assert.equal(calls, beforeCompare + 2);
  c.nudgeActors(1, 0);
  held([x + 1, y + 1, 185], false);
  assert.equal(calls, beforeCompare + 3);
  c.stop();
});

test("missing optional presentation cues preserve replay preparation but cancellation still aborts", async () => {
  for (const aborted of [false, true]) {
    const f = fixture();
    const error = new Error(
      aborted ? "Cancelled" : "Client effect is unavailable",
    );
    error.name = aborted ? "AbortError" : "NotFoundError";
    const internals = f.c as unknown as {
      localFiles: unknown;
      browserBridge: unknown;
      prepareReplayForInstall: (
        input: RawReplay,
      ) => Promise<{ replay: { actors: unknown[] } }>;
    };
    internals.localFiles = { prepare: async () => {} };
    internals.browserBridge = {
      map: async () => ({ floors: [], areas: [] }),
      catalog: async (kind: string) => {
        if (kind === "spells") throw error;
        return {};
      },
    };
    const input = {
      ...raw,
      actors: [],
      events: [],
      abilities: [{ gameID: 440802, name: "Frozen Orb" }],
    };
    if (aborted)
      await assert.rejects(
        internals.prepareReplayForInstall(input),
        (e: unknown) => e === error,
      );
    else {
      const prepared = await internals.prepareReplayForInstall(input);
      assert.equal(prepared.replay.actors.length, 0);
      assert.match(
        f.c.getSnapshot().notice,
        /Some spell effects are unavailable/,
      );
    }
    f.c.stop();
  }
});

test("Appearance edits prepare before publishing and merge pending fields without stale commits", async () => {
  const f = fixture();
  const actor = f.c.getSnapshot().replay!.actors[0];
  const requests: { resources: string[]; release: () => void }[] = [];
  const internals = f.c as unknown as {
    localFiles: unknown;
    browserBridge: unknown;
  };
  internals.localFiles = {
    prepare: async (resources: string[]) =>
      new Promise<void>((release) => requests.push({ resources, release })),
  };
  internals.browserBridge = {
    catalog: async (kind: string) =>
      kind === "characters"
        ? {
            sectionTextureTypes: [0, 1].map((sex) => ({
              race: 2,
              sex,
              types: [],
            })),
          }
        : { displays: {} },
  };
  const before = f.frame;
  const first = f.c.setAppearance(actor, "race", 2);
  while (requests.length < 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(requests[0].resources[0], /^__classic\/appearance\/2-0-/);
  assert.notEqual(f.c.appearance(actor).race, 2);
  assert.equal(f.frame, before);
  const second = f.c.setAppearance(actor, "sex", 1);
  while (requests.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 0));
  requests[1].release();
  await second;
  assert.equal(f.c.appearance(actor).race, 2);
  assert.equal(f.c.appearance(actor).sex, 1);
  requests[0].release();
  await first;
  assert.equal(f.c.appearance(actor).race, 2);
  assert.equal(f.c.appearance(actor).sex, 1);
  assert.equal(f.frame.find((row) => row.key === actor.key)?.race, 2);
  assert.equal(f.frame.find((row) => row.key === actor.key)?.sex, 1);
});

// Opt in only these tests to canonical transport; the shared fixture stays legacy.
function canonicalTransportFixture(
  samples: import("./types").Actor["samples"],
) {
  const f = fixture();
  const actor = f.c.getSnapshot().replay!.actors.find((a) => a.key === "1:1")!;
  actor.samples = samples;
  actor.deaths = [];
  actor.casts = [];
  const packets: import("./replay-trajectory-packets").TrajectoryComponentPacket[] =
    [];
  const sources: string[] = [];
  f.engine.submit_replay_trajectory = (json) => packets.push(JSON.parse(json));
  f.engine.set_replay_trajectory_source = (source) => sources.push(source);
  const player = () =>
    f.frame.find((unit) => unit.key === actor.key) as NativeFrame & {
      movement?: { unrestricted?: boolean };
      trajectory?: import("./types").NativeTrajectoryReference;
      trajectory_bridge?: {
        from: import("./types").NativeTrajectoryReference;
        to: import("./types").NativeTrajectoryReference;
      };
    };
  return { f, actor, packets, sources, player };
}

function trajectoryRetryTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
}

test("paused Missing then resend then capacity error retries without another Missing", async (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
  ]);
  f.c.seek(500);
  const identity = { ...player().trajectory!, actor: actor.key };
  f.c.receive("trajectoryMissing", JSON.stringify([identity]));
  await Promise.resolve();
  assert.equal(packets.length, 2);
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...identity,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  t.mock.timers.tick(99);
  assert.equal(packets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(
    packets.length,
    3,
    "capacity can recover without a changed missing set",
  );
  assert.deepEqual(packets[2], packets[0]);
  t.mock.timers.tick(10000);
  assert.equal(packets.length, 3, "success stops retries");
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.stop();
});

test("trajectory capacity retries coalesce and stop at a bounded failure budget", (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
  ]);
  let attempts = 0;
  f.engine.submit_replay_trajectory = () => {
    attempts++;
    throw new Error("Too many queued trajectory components");
  };
  f.c.seek(500);
  const identity = { ...player().trajectory!, actor: actor.key };
  for (let i = 0; i < 10; i++)
    f.c.receive(
      "trajectoryError",
      JSON.stringify({
        ...identity,
        message: "Canonical active cache capacity exceeded",
      }),
    );
  t.mock.timers.tick(99);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(attempts, 2);
  t.mock.timers.tick(199);
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  assert.equal(attempts, 3);
  for (let i = 0; i < 15; i++) t.mock.timers.tick(2000);
  assert.equal(attempts, 8);
  t.mock.timers.tick(100000);
  assert.equal(attempts, 8);
  f.engine.submit_replay_trajectory = () => {
    attempts++;
  };
  f.c.seek(600);
  assert.equal(
    attempts,
    9,
    "explicit seek can recover exhausted transient input",
  );
  t.mock.timers.tick(10000);
  f.c.seek(650);
  assert.equal(attempts, 9, "successful recovery stays deduplicated");
  f.c.stop();
});

test("trajectory retry timers cancel on seek, source replacement, engine replacement and stop", (t) => {
  trajectoryRetryTimers(t);
  for (const action of ["seek", "source", "engine", "hide", "stop"]) {
    const { f, actor, packets, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    f.c.seek(500);
    const identity = { ...player().trajectory!, actor: actor.key };
    f.c.receive(
      "trajectoryError",
      JSON.stringify({
        ...identity,
        message: "Canonical active cache capacity exceeded",
      }),
    );
    if (action === "seek") f.c.seek(600);
    if (action === "source") f.c.installReplay(raw);
    if (action === "engine") f.c.attachEngine({ ...f.engine });
    if (action === "hide") f.c.setOption("actors", false);
    if (action === "stop") f.c.stop();
    const before = packets.length;
    t.mock.timers.tick(10000);
    assert.equal(packets.length, before, action + " must cancel old timer");
    f.c.stop();
  }
});

test("late capacity errors for prior seek and engine demands do not restart retries", (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player, sources } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
    [10000, 10, -1, 0],
    [11000, 12, -1, null],
  ]);
  f.c.seek(500);
  const old = { ...player().trajectory!, actor: actor.key };
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...old,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  f.c.seek(10500);
  assert.notEqual(player().trajectory!.component, old.component);
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...old,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  const before = packets.length;
  t.mock.timers.tick(10000);
  assert.equal(packets.length, before);
  const current = { ...player().trajectory!, actor: actor.key };
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...current,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  f.c.attachEngine({ ...f.engine });
  assert.notEqual(sources.at(-1), current.source);
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...current,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  const replaced = packets.length;
  t.mock.timers.tick(10000);
  assert.equal(packets.length, replaced);
  f.c.stop();
});

test("queued missing recovery is cancelled before a seek changes demand", async (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
    [10000, 10, -1, 0],
    [11000, 12, -1, null],
  ]);
  f.c.seek(500);
  const old = { ...player().trajectory!, actor: actor.key };
  f.c.receive("trajectoryMissing", JSON.stringify([old]));
  f.c.seek(10500);
  const before = packets.length;
  await Promise.resolve();
  t.mock.timers.tick(10000);
  assert.equal(packets.length, before);
  assert.equal(packets.at(-1)!.component, player().trajectory!.component);
  f.c.stop();
});

test("permanent validation rejection cancels an already queued capacity retry", (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
  ]);
  f.c.seek(500);
  const identity = { ...player().trajectory!, actor: actor.key };
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...identity,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  f.c.receive(
    "trajectoryError",
    JSON.stringify({ ...identity, message: "Invalid canonical sample" }),
  );
  t.mock.timers.tick(10000);
  f.c.seek(600);
  assert.equal(packets.length, 1);
  f.c.stop();
});

test("transient native queue pressure recovers on the renderer missing notification while paused", async (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
  ]);
  let attempts = 0;
  f.engine.submit_replay_trajectory = (json) => {
    attempts++;
    if (attempts === 1)
      throw new Error("Too many queued trajectory components");
    packets.push(JSON.parse(json));
  };
  f.c.seek(500);
  assert.equal(attempts, 1);
  assert.equal(packets.length, 0);
  const identity = { ...player().trajectory!, actor: actor.key };
  f.c.receive("trajectoryMissing", JSON.stringify([identity]));
  await Promise.resolve();
  assert.equal(
    attempts,
    1,
    "missing notification cannot bypass capacity backoff",
  );
  t.mock.timers.tick(100);
  assert.equal(attempts, 2);
  assert.equal(packets.length, 1);
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.seek(600);
  assert.equal(attempts, 2, "successful content stays deduplicated");
  f.c.stop();
});

test("transient active-cache pressure recovers when an already-unsent missing key is reported", async (t) => {
  trajectoryRetryTimers(t);
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
  ]);
  f.c.seek(500);
  const identity = { ...player().trajectory!, actor: actor.key };
  f.c.receive(
    "trajectoryError",
    JSON.stringify({
      ...identity,
      message: "Canonical active cache capacity exceeded",
    }),
  );
  f.c.receive("trajectoryMissing", JSON.stringify([identity]));
  await Promise.resolve();
  assert.equal(packets.length, 1, "missing notification respects backoff");
  t.mock.timers.tick(100);
  assert.equal(packets.length, 2, "retry after capacity becomes available");
  assert.deepEqual(
    packets[1],
    packets[0],
    "retry preserves immutable source content",
  );
  f.c.seek(600);
  assert.equal(packets.length, 2);
  f.c.stop();
});

test("permanent trajectory errors remain rejected for synchronous and asynchronous failures", async () => {
  for (const kind of ["sync", "async"]) {
    const { f, actor, packets, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    let attempts = 0;
    f.engine.submit_replay_trajectory = (json) => {
      attempts++;
      if (kind === "sync") throw new Error("Canonical input capacity exceeded");
      packets.push(JSON.parse(json));
    };
    f.c.seek(500);
    const identity = { ...player().trajectory!, actor: actor.key };
    if (kind === "async")
      f.c.receive(
        "trajectoryError",
        JSON.stringify({ ...identity, message: "Invalid canonical sample" }),
      );
    f.c.receive("trajectoryMissing", JSON.stringify([identity]));
    await Promise.resolve();
    f.c.seek(600);
    assert.equal(
      attempts,
      1,
      `${kind} malformed or oversized content must not loop`,
    );
    f.c.stop();
  }
});

test("same-component Play retries recover transient pressure before accepting current native readiness", (t) => {
  trajectoryRetryTimers(t);
  for (const pressure of ["queue", "active-cache"] as const) {
    const { f, actor, packets, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    const requests: number[] = [];
    const submissions: unknown[] = [];
    f.engine.prepare_replay_playback = (token) => requests.push(token);
    f.engine.submit_replay_trajectory = (json) => {
      submissions.push(JSON.parse(json));
      if (pressure === "queue" && submissions.length === 1)
        throw Error("Too many queued trajectory components");
      packets.push(JSON.parse(json));
    };
    f.c.seek(500);
    const identity = { ...player().trajectory!, actor: actor.key };
    if (pressure === "active-cache")
      f.c.receive(
        "trajectoryError",
        JSON.stringify({
          ...identity,
          message: "Canonical active cache capacity exceeded",
        }),
      );
    f.c.toggle();
    const first = requests.at(-1)!;
    assert.ok(first > 0);
    assert.equal(f.c.getSnapshot().playPreparing, true, pressure);
    t.mock.timers.tick(99);
    assert.equal(submissions.length, 1);
    assert.equal(f.c.getSnapshot().playing, false);
    t.mock.timers.tick(1);
    assert.equal(submissions.length, 2);
    assert.deepEqual(
      submissions[1],
      submissions[0],
      "recovery resubmits the identical required component",
    );
    assert.equal(
      f.c.getSnapshot().playing,
      false,
      "submission alone cannot start the clock",
    );
    f.c.receive(
      "movementPreparation",
      JSON.stringify({ ready: 1, pending: 0, conflict: 0 }),
    );
    assert.equal(
      f.c.getSnapshot().playing,
      false,
      "status alone cannot acknowledge Play",
    );
    f.c.receive("playbackPrepared", JSON.stringify({ token: first }));
    assert.equal(f.c.getSnapshot().playing, true);

    f.c.seek(600);
    assert.equal(player().trajectory!.content, identity.content);
    assert.equal(
      submissions.length,
      2,
      "accepted content remains deduplicated across the same-component seek",
    );
    f.c.receive(
      "trajectoryError",
      JSON.stringify({
        ...identity,
        source: "stale-installation",
        message: "Invalid canonical sample",
      }),
    );
    f.c.toggle();
    const second = requests.at(-1)!;
    assert.notEqual(second, first);
    assert.equal(f.c.getSnapshot().playPreparing, true);
    f.c.receive("playbackPrepared", JSON.stringify({ token: first }));
    assert.equal(
      f.c.getSnapshot().playing,
      false,
      "old acknowledgements cannot start a new attempt",
    );
    f.c.receive("playbackPrepared", JSON.stringify({ token: second }));
    assert.equal(f.c.getSnapshot().playing, true);
    f.c.stop();
  }
});

test("permanent required content remains terminal across Play retries and same-component seeks", async () => {
  for (const reason of [
    "Canonical input capacity exceeded",
    "Invalid canonical sample",
  ]) {
    const { f, actor, packets, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    const requests: number[] = [];
    f.engine.prepare_replay_playback = (token) => requests.push(token);
    f.c.seek(500);
    const identity = { ...player().trajectory!, actor: actor.key };
    f.c.toggle();
    const stale = requests.at(-1)!;
    f.c.receive(
      "trajectoryError",
      JSON.stringify({ ...identity, message: reason }),
    );
    const submitted = packets.length;
    for (const time of [600, 500, 600]) {
      f.c.seek(time);
      assert.equal(player().trajectory!.content, identity.content);
      f.c.receive("trajectoryMissing", JSON.stringify([identity]));
      await Promise.resolve();
      f.c.toggle();
      assert.equal(f.c.getSnapshot().playPreparing, false, reason);
      assert.equal(f.c.getSnapshot().playing, false, reason);
      assert.equal(requests.at(-1), 0);
      assert.match(f.c.getSnapshot().notice, /Movement could not be prepared/);
      assert.equal(
        packets.length,
        submitted,
        "immutable rejected content is not silently resubmitted",
      );
      f.c.receive("playbackPrepared", JSON.stringify({ token: stale }));
      assert.equal(f.c.getSnapshot().playing, false);
    }
    f.c.stop();
  }
});

test("canonical transport sends one immutable dense packet across forward, backward and repeated seeks", () => {
  const { f, actor, packets, sources, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
    [2000, 9, -1, -10],
  ]);
  const rawSamples = structuredClone(actor.samples);
  const bindings = [];
  for (const time of [500, 1500, 100, 1500, 500]) {
    f.c.seek(time);
    bindings.push(player().trajectory);
  }
  assert.equal(packets.length, 1);
  assert.equal(sources.length, 1);
  assert.deepEqual(packets[0].samples, rawSamples);
  assert.deepEqual(packets[0].initial_heights, [0]);
  assert.deepEqual(actor.samples, rawSamples);
  for (const binding of bindings) {
    assert.ok(binding);
    assert.equal(binding.source, sources[0]);
    assert.equal(binding.component, packets[0].component);
    assert.equal(binding.content, packets[0].content);
    assert.equal(binding.at, undefined);
  }
  f.c.seek(2000);
  assert.equal(player().trajectory?.at, 2000);
  assert.equal(packets.length, 1);
  f.c.stop();
});

test("canonical source installation namespace changes on reinstall, while seek generation does not", () => {
  const { f, packets, sources } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, 0],
  ]);
  f.c.seek(500);
  const original = sources[0];
  f.c.seek(100);
  f.c.seek(900);
  assert.deepEqual(sources, [original]);
  const replay = f.c.getSnapshot().replay!;
  f.c.installReplay(replay.raw, { replay, models: {} });
  f.c.seek(500);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[1], original);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].content, packets[1].content);
  assert.equal(packets[0].component, packets[1].component);
  f.c.stop();
});

test("authored snapshots opt out of canonical transport while unedited Plan playback remains bound", () => {
  const { f, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, 0],
  ]);
  f.c.seek(500);
  f.c.setWorkspaceMode("plan");
  assert.ok(player().trajectory);
  const count = packets.length;
  f.c.planFromMoment();
  assert.ok(f.c.displaySnapshot());
  assert.equal(player().trajectory, undefined);
  assert.equal(player().trajectory_bridge, undefined);
  f.c.seek(700);
  assert.equal(packets.length, count);
  assert.equal(player().trajectory, undefined);
  f.c.stop();
});

test("long sparse wisps use collision navigation without requiring historical canonical endpoints", () => {
  const { f, packets, sources, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [7000, 10, -1, 5],
    [8000, 12, -1, 5],
  ]);
  for (const time of [1000, 4000, 2500, 1000]) {
    f.c.seek(time);
    assert.equal(player().trajectory, undefined);
    assert.equal(player().trajectory_bridge, undefined);
    assert.equal(player().movement?.unrestricted, true);
  }
  assert.equal(packets.length, 0);
  assert.equal(sources.length, 1);
  f.c.stop();
});

test("zero-distance Blink chooses its component at recorded completion rather than observed displacement", () => {
  const { f, actor, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 2, -1, 10],
    [2000, 3, -1, 10],
  ]);
  actor.casts = [
    { spell: 1953, end: 500, outcome: "completed", timingSource: "recorded" },
  ] as import("./types").Actor["casts"];
  (
    actor as unknown as {
      movement: { profile: number[][]; blinks: number[][] };
    }
  ).movement = { profile: [[0, 1, 0]], blinks: [[500]] };
  f.c.seek(499);
  const before = player().trajectory!;
  assert.equal(before.at, 0);
  assert.equal(before.hold, true);
  f.c.seek(500);
  const after = player().trajectory!;
  assert.equal(after.at, 1000);
  assert.equal(after.hold, true);
  assert.notEqual(after.component, before.component);
  f.c.seek(750);
  assert.deepEqual(player().trajectory, after);
  f.c.seek(499);
  assert.deepEqual(player().trajectory, before);
  assert.equal(packets.length, 2);
  f.c.stop();
});

test("coverage updates preserve canonical source/origin/seeds and coalesce missing-prefix requests", async () => {
  const { f, actor, packets, sources, player } = canonicalTransportFixture([
    [0, 2, -1, null],
    [1000, 8, -1, null],
  ]);
  actor.bufferedRanges = [
    [0, 400],
    [600, 1000],
  ];
  const calls: number[][] = [];
  const internals = f.c as unknown as {
    replayBuffer: { active: boolean; close(): void };
    loadedFloors: Map<number, ReplayFloorGeometry>;
    patch(update: { replay: import("./types").Replay }): void;
  };
  internals.loadedFloors.set(
    f.c.getSnapshot().replay!.map,
    new ReplayFloorGeometry([
      {
        area: "test-room",
        interior: true,
        vertices: [
          [0, -5, 20],
          [20, -5, 20],
          [20, 5, 20],
          [0, 5, 20],
        ],
        indices: [0, 1, 2, 0, 2, 3],
      },
    ]),
  );
  internals.replayBuffer = { active: false, close() {} };
  f.c.loadReplayRange = async (start, end) => {
    calls.push([start, end]);
  };
  f.c.seek(200);
  f.c.render();
  f.c.render();
  await Promise.resolve();
  assert.deepEqual(calls, [[0, 1000]]);
  assert.equal(
    packets.length,
    0,
    "incomplete coverage is never submitted to physics",
  );
  const previous = player().trajectory!;
  assert.ok(previous);
  const replay = f.c.getSnapshot().replay!;
  // refreshBuffered installs a new normalized replay object without reinstalling source.
  internals.patch({
    replay: {
      ...replay,
      actors: replay.actors.map((a) =>
        a.key === actor.key ? { ...a, bufferedRanges: [[0, 1000]] } : a,
      ),
    },
  });
  f.c.seek(700);
  assert.equal(sources.length, 1);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].coverage_complete, true);
  assert.equal(packets[0].component, previous.component);
  assert.equal(packets[0].source, previous.source);
  assert.deepEqual(packets[0].initial_heights, [20]);
  assert.deepEqual(packets[0].samples, actor.samples);
  assert.equal(player().trajectory?.component, previous.component);
  f.c.stop();
});

test("native Missing retries only its reported component without activating a new source", async () => {
  const { f, packets, sources, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 3, -1, 0],
    [8000, 10, -1, 5],
    [9000, 12, -1, 5],
  ]);
  f.c.seek(500);
  f.c.seek(8500);
  assert.ok(player().trajectory);
  assert.equal(packets.length, 2);
  const missing = packets[1];
  f.c.receive(
    "trajectoryMissing",
    JSON.stringify([
      {
        source: missing.source,
        actor: missing.actor,
        component: missing.component,
        content: missing.content,
      },
    ]),
  );
  await Promise.resolve();
  assert.equal(packets.length, 3);
  assert.deepEqual(packets[2], missing);
  assert.equal(sources.length, 1);
  f.c.receive(
    "trajectoryMissing",
    JSON.stringify([{ ...missing, source: "old-source" }]),
  );
  await Promise.resolve();
  assert.equal(packets.length, 3);
  f.c.stop();
});

test("malformed native preparation status is ignored and unchanged status does not republish state", () => {
  const f = fixture();
  let updates = 0;
  const unsubscribe = f.c.subscribe(() => updates++);
  const pending = JSON.stringify({ ready: 0, pending: 2, conflict: 0 });
  f.c.receive("movementPreparation", pending);
  assert.equal(f.c.getSnapshot().movementPreparing, true);
  assert.equal(f.c.getSnapshot().movementConflicted, false);
  const changed = updates;
  assert.ok(changed > 0);
  f.c.receive("movementPreparation", pending);
  f.c.receive(
    "movementPreparation",
    JSON.stringify({ ready: 3, pending: 1, conflict: 0 }),
  );
  for (const bad of [
    "{",
    "null",
    "[]",
    '{"ready":0,"pending":-1,"conflict":0}',
    '{"ready":0,"pending":1.5,"conflict":0}',
    '{"ready":0,"pending":0,"conflict":8193}',
  ])
    f.c.receive("movementPreparation", bad);
  assert.equal(updates, changed);
  assert.equal(f.c.getSnapshot().movementPreparing, true);
  f.c.receive(
    "movementPreparation",
    JSON.stringify({ ready: 1, pending: 0, conflict: 1 }),
  );
  assert.equal(updates, changed + 1);
  assert.equal(f.c.getSnapshot().movementPreparing, false);
  assert.equal(f.c.getSnapshot().movementConflicted, true);
  unsubscribe();
  f.c.stop();
});

test("late loaded chunks request their missing chronological prefix instead of submitting a fresh physical origin", async () => {
  const { f, actor, packets, sources, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 3, -1, null],
    [10000, 12, -1, null],
    [11000, 13, -1, null],
  ]);
  actor.bufferedRanges = [
    [0, 1000],
    [10000, 11000],
  ];
  const requests: number[][] = [];
  const internals = f.c as unknown as {
    replayBuffer: { active: boolean; close(): void };
  };
  internals.replayBuffer = { active: false, close() {} };
  f.c.loadReplayRange = async (start, end) => {
    requests.push([start, end]);
  };
  f.c.seek(10500);
  const late = player().trajectory!;
  assert.ok(late);
  assert.equal(player().trajectory_bridge, undefined);
  f.c.seek(500);
  assert.equal(player().trajectory?.component, late.component);
  f.c.seek(10500);
  await Promise.resolve();
  assert.equal(
    packets.length,
    0,
    "no independently seeded late-component packet",
  );
  assert.equal(sources.length, 1);
  assert.deepEqual(requests, [[0, 11000]]);
  f.c.stop();
});

test("canonical post-last-sample references hold the recorded endpoint and stationary facing", () => {
  const { f, actor, player } = canonicalTransportFixture([
    [0, 0, 0, 0],
    [1000, 7, 0, 0],
  ]);
  actor.facings = [[1500, 1.57]];
  f.c.seek(2000);
  const frame = player();
  assert.equal(frame.trajectory?.at, 1000);
  assert.equal(frame.trajectory?.hold, true);
  assert.equal(frame.facing, 1.57);
  assert.equal(frame.speed, 0);
  f.c.stop();
});

test("recorded life and zone discontinuities hold endpoint references", () => {
  for (const kind of ["life", "zone"] as const) {
    const { f, actor, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, 10],
    ]);
    if (kind === "life")
      actor.deaths = [
        [-100, true],
        [500, false],
      ];
    else
      (
        actor as import("./types").Actor & { positionBreaks: number[] }
      ).positionBreaks = [500];
    f.c.seek(600);
    assert.equal(player().trajectory?.at, 0, kind);
    assert.equal(player().trajectory?.hold, true, kind);
    assert.equal(player().trajectory_bridge, undefined, kind);
    f.c.stop();
  }
});

test("short sparse playback keeps one canonical reference across the shared endpoint", () => {
  const { f, packets, player } = canonicalTransportFixture([
    [0, 2, -1, 0],
    [1000, 8, -1, null],
    [3068, 24, -1, null],
  ]);
  const refs = [];
  for (const time of [999, 1000, 1001, 2500, 1000]) {
    f.c.seek(time);
    assert.equal(player().trajectory_bridge, undefined);
    refs.push(player().trajectory);
  }
  assert.ok(refs[0]);
  for (const ref of refs) assert.deepEqual(ref, refs[0]);
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].samples, [
    [0, 2, -1, 0],
    [1000, 8, -1, null],
    [3068, 24, -1, null],
  ]);
  assert.equal(packets[0].profiles[1].unrestricted, true);
  f.c.stop();
});

test("unloaded future context does not block a covered source window or request unrelated future chunks", async () => {
  const samples: import("./types").Actor["samples"] = [
    ...Array.from(
      { length: 13 },
      (_, n) =>
        [n * 1000, n * 3, 0, n === 0 ? 0 : null] as [
          number,
          number,
          number,
          number | null,
        ],
    ),
    [20000, 50, 0, null],
  ];
  const { f, actor, packets, player } = canonicalTransportFixture(samples);
  actor.bufferedRanges = [
    [0, 12000],
    [20000, 20000],
  ];
  const internals = f.c as unknown as { replayBuffer: unknown };
  internals.replayBuffer = { active: false, close() {} };
  const requests: number[][] = [];
  f.c.loadReplayRange = async (start, end) => {
    requests.push([start, end]);
  };
  // Avoid a separate foreground buffer operation; exercise the movement request itself.
  const clock = f.c as unknown as { clockTime: number };
  clock.clockTime = 1000;
  f.c.render();
  await Promise.resolve();
  assert.equal(packets.length, 1);
  assert.equal(packets[0].coverage_complete, true);
  assert.equal(packets[0].samples.at(-1)![0], 12000);
  assert.deepEqual(requests, []);
  const reference = player().trajectory!;
  assert.ok(reference);
  assert.notEqual(reference.content, "coverage-pending");
  clock.clockTime = 8000;
  f.c.render();
  await Promise.resolve();
  assert.notEqual(player().trajectory?.content, "coverage-pending");
  assert.deepEqual(requests, []);
  clock.clockTime = 11000;
  f.c.render();
  await Promise.resolve();
  assert.equal(player().trajectory?.content, "coverage-pending");
  assert.deepEqual(requests, [[0, 20000]]);
  assert.equal(packets.length, 1);
  f.c.stop();
});

test(
  "finishing a download resumes paused movement coverage requested while that download was active",
  { timeout: 2000 },
  async () => {
    const { f, actor, packets } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    actor.bufferedRanges = [
      [0, 400],
      [600, 1000],
    ];
    f.c.seek(200);
    const internals = f.c as unknown as {
      replayBuffer: unknown;
      refreshBuffered(buffer: unknown): Promise<void>;
      patch(update: { replay: import("./types").Replay }): void;
    };
    let ensures = 0;
    internals.replayBuffer = {
      active: false,
      duration: 1000,
      ensure: async () => {
        ensures++;
      },
      flush: async () => {},
      close() {},
    };
    internals.refreshBuffered = async () => {
      if (ensures >= 2) {
        const replay = f.c.getSnapshot().replay!;
        internals.patch({
          replay: {
            ...replay,
            actors: replay.actors.map((a) =>
              a.key === actor.key ? { ...a, bufferedRanges: [[0, 1000]] } : a,
            ),
          },
        });
      }
      f.c.render();
    };
    const original = f.c.loadReplayRange.bind(f.c),
      requests: number[][] = [];
    let done!: () => void;
    const resumed = new Promise<void>((resolve) => {
      done = resolve;
    });
    f.c.loadReplayRange = async (start, end) => {
      requests.push([start, end]);
      await original(start, end);
      if (requests.length >= 2) done();
    };
    await f.c.loadReplayRange(0, 400);
    await resumed;
    assert.deepEqual(requests, [
      [0, 400],
      [0, 1000],
    ]);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].coverage_complete, true);
    f.c.stop();
  },
);

test("canonical transport includes recorded feather fall and evidence-derived paired transfers", () => {
  const { f, actor, packets } = canonicalTransportFixture([
    [0, 0, 0, 0],
    [1000, 0, 0, null],
    [2000, 30, 0, null],
    [3000, 60, 0, null],
    [4000, 70, 0, null],
    [5000, 77, 0, null],
  ]);
  actor.auras = [
    [500, { spell: 1706, remove: false }],
  ] as import("./types").Actor["auras"];
  const replay = f.c.getSnapshot().replay!,
    npc = replay.actors.find((a) => a.type === "NPC")!;
  const peer = {
    ...actor,
    id: 3,
    key: "3:1",
    auras: [],
    samples: actor.samples.map(
      (s) =>
        [s[0], 60 - s[1], s[2], s[3]] as [
          number,
          number,
          number,
          number | null,
        ],
    ),
  };
  const cast = (spell: number) => ({
    id: spell,
    spell,
    gameID: spell,
    name: "Transfer",
    start: 1000,
    end: 1000,
    instant: true,
    target: null,
    timingSource: "recorded" as const,
    outcome: "completed" as const,
  });
  const casters = [
    { ...npc, casts: [cast(28338)] },
    { ...npc, id: 4, key: "4:1", casts: [cast(28339)] },
  ];
  const damage = (source: string, target: string, id: number) => ({
    ...replay.combat[0],
    id,
    t: 900,
    kind: "damage" as const,
    source,
    target,
    spell: 1,
    melee: true,
  });
  (
    f.c as unknown as {
      patch(update: { replay: import("./types").Replay }): void;
    }
  ).patch({
    replay: {
      ...replay,
      actors: [actor, peer, ...casters],
      combat: [damage(npc.key, actor.key, 901), damage("4:1", "3:1", 902)],
    },
  });
  f.c.seek(1500);
  const p = packets.find((p) => p.actor === actor.key)!;
  assert.ok(p);
  assert.deepEqual(p.transfers, [[1000, 3000]]);
  assert.deepEqual(p.slow_fall, [
    [0, false],
    [500, true],
  ]);
  assert.deepEqual(p.hover_launches, [500]);
  assert.deepEqual(p.samples, actor.samples);
  f.c.stop();
});

test("buffering a known transfer holds its ordinary interpretation until completion evidence arrives", async () => {
  const prefix: import("./types").Actor["samples"] = [
    [0, 0, 0, 0],
    [1000, 0, 0, null],
    [2000, 30, 0, null],
  ];
  const { f, actor, packets } = canonicalTransportFixture(prefix);
  actor.bufferedRanges = [[0, 2000]];
  const replay = f.c.getSnapshot().replay!,
    npc = replay.actors.find((a) => a.type === "NPC")!;
  const peer = {
    ...actor,
    id: 3,
    key: "3:1",
    samples: prefix.map(
      (s) =>
        [s[0], 60 - s[1], 0, s[3]] as [number, number, number, number | null],
    ),
  };
  const cast = (spell: number) => ({
    id: spell,
    spell,
    gameID: spell,
    name: "Transfer",
    start: 1000,
    end: 1000,
    instant: true,
    target: null,
    timingSource: "recorded" as const,
    outcome: "completed" as const,
  });
  const casters = [
    { ...npc, casts: [cast(28338)] },
    { ...npc, id: 4, key: "4:1", casts: [cast(28339)] },
  ];
  const damage = (source: string, target: string, id: number) => ({
    ...replay.combat[0],
    id,
    t: 900,
    kind: "damage" as const,
    source,
    target,
    spell: 1,
    melee: true,
  });
  const internals = f.c as unknown as {
    clockTime: number;
    replayBuffer: unknown;
    patch(update: { replay: import("./types").Replay }): void;
  };
  internals.patch({
    replay: {
      ...replay,
      actors: [actor, peer, ...casters],
      combat: [damage(npc.key, actor.key, 901), damage("4:1", "3:1", 902)],
    },
  });
  internals.replayBuffer = { active: false, close() {} };
  const requests: number[][] = [];
  f.c.loadReplayRange = async (start, end) => {
    requests.push([start, end]);
  };
  internals.clockTime = 1500;
  f.c.render();
  await Promise.resolve();
  const before = packets.filter((p) => p.actor === actor.key).at(-1)!;
  assert.deepEqual(before.unresolved_transfers, [[1000, false]]);
  assert.equal(before.transfers, undefined);
  assert.deepEqual(requests, [[0, 7000]]);
  const full: import("./types").Actor["samples"] = [
    ...prefix,
    [3000, 60, 0, null],
    [4000, 67, 0, null],
  ];
  const current = f.c.getSnapshot().replay!;
  internals.patch({
    replay: {
      ...current,
      actors: current.actors.map((a) =>
        a.key === actor.key
          ? { ...a, samples: full, bufferedRanges: [[0, 7000]] }
          : a.key === peer.key
            ? {
                ...a,
                samples: full.map(
                  (s) =>
                    [s[0], 60 - s[1], 0, s[3]] as [
                      number,
                      number,
                      number,
                      number | null,
                    ],
                ),
                bufferedRanges: [[0, 7000]],
              }
            : a,
      ),
    },
  });
  f.c.render();
  await Promise.resolve();
  const after = packets.filter((p) => p.actor === actor.key).at(-1)!;
  assert.deepEqual(after.transfers, [[1000, 3000]]);
  assert.equal(after.unresolved_transfers, undefined);
  assert.equal(after.component, before.component);
  assert.equal(after.source, before.source);
  assert.notEqual(after.content, before.content);
  f.c.stop();
});

test("delta publication reconstructs the same complete frames through seeks and source reinstalls", () => {
  const f = fixture();
  const expected = new Map<number, unknown>();
  for (const time of [1000, 6000, 9500, 1000]) {
    f.c.seek(time);
    expected.set(time, structuredClone(f.frame));
  }
  let rows = new Map<string, Record<string, unknown>>();
  let reconstructed: unknown[] = [];
  const payloads: any[] = [];
  f.engine.set_replay_frame_delta = (json) => {
    const packet = JSON.parse(json);
    payloads.push(packet);
    if (packet.reset) rows.clear();
    for (const actor of packet.updates)
      rows.set(actor.key, { ...rows.get(actor.key), ...actor });
    rows = new Map(packet.order.map((key: string) => [key, rows.get(key)!]));
    reconstructed = [...rows.values()];
  };
  for (const time of [1000, 6000, 9500, 1000]) {
    f.c.seek(time);
    assert.deepEqual(reconstructed, expected.get(time));
  }
  assert.equal(payloads[0].reset, true);
  assert.ok(payloads.slice(1).every((packet) => !packet.reset));
  f.c.installReplay(structuredClone(raw) as RawReplay);
  assert.equal(payloads.at(-1).reset, true);
});

test("playback waits for native preparation and ignores cancelled or stale acknowledgements", async () => {
  const f = fixture();
  const requests: number[] = [];
  f.engine.prepare_replay_playback = (token) => requests.push(token);
  f.c.toggle();
  assert.equal(f.c.getSnapshot().playing, false);
  assert.equal(f.c.getSnapshot().playPreparing, true);
  await Promise.resolve();
  const first = requests.at(-1)!;
  assert.ok(first > 0);
  f.c.seek(1000);
  f.c.receive("playbackPrepared", JSON.stringify({ token: first }));
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.toggle();
  await Promise.resolve();
  const second = requests.at(-1)!;
  assert.notEqual(first, second);
  f.c.receive("playbackPrepared", JSON.stringify({ token: second }));
  assert.equal(f.c.getSnapshot().playing, true);
  assert.equal(f.c.getSnapshot().playPreparing, false);
  f.c.toggle();
  f.c.toggle();
  await Promise.resolve();
  f.c.toggle();
  assert.equal(f.c.getSnapshot().playPreparing, false);
  assert.equal(requests.at(-1), 0);
});

test("speculative asset warming cannot block native playback preparation", () => {
  const f = fixture();
  const requests: number[] = [];
  // A model/spell prefetch may be slow or unavailable while current-scene collision is ready.
  (f.c as any).warmEncounter = () => new Promise<void>(() => {});
  f.engine.prepare_replay_playback = (token) => requests.push(token);
  f.c.toggle();
  assert.equal(f.c.getSnapshot().playing, false);
  assert.ok(requests.at(-1)! > 0);
  f.c.receive("playbackPrepared", JSON.stringify({ token: requests.at(-1) }));
  assert.equal(f.c.getSnapshot().playing, true);
});

test("initial scene deadline cancels playback preparation and a healthy retry can complete", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const requests: number[] = [];
  f.engine.prepare_replay_playback = (token) => requests.push(token);
  assert.equal(f.c.getSnapshot().sceneReady, false);
  f.c.toggle();
  const expired = requests.at(-1)!;
  t.mock.timers.tick(89999);
  assert.equal(f.c.getSnapshot().playPreparing, true);
  assert.equal(f.c.getSnapshot().playing, false);
  t.mock.timers.tick(1);
  assert.equal(f.c.getSnapshot().playPreparing, false);
  assert.equal(f.c.getSnapshot().playing, false);
  assert.match(f.c.getSnapshot().error!, /did not finish loading/);
  assert.equal(requests.at(-1), 0);
  f.c.receive("playbackPrepared", JSON.stringify({ token: expired }));
  assert.equal(f.c.getSnapshot().playing, false);

  f.c.toggle();
  const retry = requests.at(-1)!;
  assert.notEqual(retry, expired);
  assert.equal(f.c.getSnapshot().error, null);
  t.mock.timers.tick(89999);
  assert.equal(f.c.getSnapshot().playPreparing, true);
  f.c.receive("playbackPrepared", JSON.stringify({ token: expired }));
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.receive("scene", "409");
  f.c.receive("playbackPrepared", JSON.stringify({ token: retry }));
  assert.equal(f.c.getSnapshot().playing, true);
  assert.equal(f.c.getSnapshot().playPreparing, false);
  t.mock.timers.tick(100000);
  assert.equal(f.c.getSnapshot().error, null);
  assert.equal(f.c.getSnapshot().playing, true);
  f.c.stop();
});

test("scene failure cancels native preparation and invalidates late readiness", () => {
  const f = fixture();
  const requests: number[] = [];
  f.engine.prepare_replay_playback = (token) => requests.push(token);
  f.c.toggle();
  const token = requests.at(-1)!;
  f.c.fail("Required scene load failed");
  assert.equal(requests.at(-1), 0);
  assert.equal(f.c.getSnapshot().playPreparing, false);
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.receive("playbackPrepared", JSON.stringify({ token }));
  assert.equal(f.c.getSnapshot().playing, false);
  f.c.stop();
});

test("Play preserves an existing boot or raid-load scene deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const load of ["boot", "raid"] as const) {
    const f = fixture();
    const requests: number[] = [];
    f.engine.prepare_replay_playback = (token) => requests.push(token);
    if (load === "boot")
      (f.c as unknown as { waitForScene: () => void }).waitForScene();
    else f.c.selectRaid(469, false);
    t.mock.timers.tick(89000);
    f.c.toggle();
    const token = requests.at(-1)!;
    t.mock.timers.tick(999);
    assert.equal(f.c.getSnapshot().playPreparing, true, load);
    t.mock.timers.tick(1);
    assert.equal(f.c.getSnapshot().playPreparing, false, load);
    assert.equal(f.c.getSnapshot().playing, false, load);
    assert.match(f.c.getSnapshot().error!, /did not finish loading/);
    assert.equal(requests.at(-1), 0, load);
    f.c.receive("playbackPrepared", JSON.stringify({ token }));
    assert.equal(f.c.getSnapshot().playing, false, load);
    f.c.stop();
  }
});

test("playback target changes invalidate pending native acknowledgements", () => {
  for (const change of [
    "plan",
    "reset",
    "raid",
    "retained-replay-raid",
    "pending-switch",
  ] as const) {
    const f = fixture();
    const requests: number[] = [];
    f.engine.prepare_replay_playback = (token) => requests.push(token);
    f.c.toggle();
    const token = requests.at(-1)!;
    assert.equal(f.c.getSnapshot().playPreparing, true);
    if (change === "plan") f.c.setWorkspaceMode("plan");
    else if (change === "reset") (f.c as any).resetProject(null);
    else {
      if (change === "pending-switch") {
        (f.c as any).projectStore = {};
        (f.c as any).activeProject = { id: "pending" };
        (f.c as any).flushProject = () => new Promise<void>(() => {});
      }
      f.c.selectRaid(469, change !== "retained-replay-raid");
    }
    assert.equal(f.c.getSnapshot().playPreparing, false, change);
    assert.equal(requests.at(-1), 0, change);
    f.c.receive("playbackPrepared", JSON.stringify({ token }));
    assert.equal(f.c.getSnapshot().playing, false, change);
    f.c.stop();
  }
});

test("native preparation still completes when started with a replay in plan mode", () => {
  const f = fixture();
  const requests: number[] = [];
  f.engine.prepare_replay_playback = (token) => requests.push(token);
  f.c.setWorkspaceMode("plan");
  f.c.toggle();
  const token = requests.at(-1)!;
  assert.equal(f.c.getSnapshot().playPreparing, true);
  f.c.receive("playbackPrepared", JSON.stringify({ token }));
  assert.equal(f.c.getSnapshot().playing, true);
  f.c.stop();
});

test("rejected selected trajectories terminate preparation and invalidate late readiness", () => {
  for (const timing of ["before", "during", "sync"] as const) {
    const { f, actor, player } = canonicalTransportFixture([
      [0, 2, -1, 0],
      [1000, 8, -1, null],
    ]);
    const requests: number[] = [];
    f.engine.prepare_replay_playback = (token) => requests.push(token);
    if (timing === "sync") {
      f.engine.submit_replay_trajectory = () => {
        throw Error("Invalid canonical sample");
      };
      f.c.toggle();
    } else {
      f.c.seek(500);
      const identity = { ...player().trajectory!, actor: actor.key };
      if (timing === "during") f.c.toggle();
      f.c.receive(
        "trajectoryError",
        JSON.stringify({ ...identity, message: "Invalid canonical sample" }),
      );
      if (timing === "before") f.c.toggle();
    }
    const token = requests.find((v) => v > 0);
    assert.equal(f.c.getSnapshot().playPreparing, false, timing);
    assert.equal(f.c.getSnapshot().playing, false, timing);
    assert.equal(requests.at(-1), 0, timing);
    assert.match(f.c.getSnapshot().notice, /Movement could not be prepared/);
    if (token !== undefined) {
      f.c.receive("playbackPrepared", JSON.stringify({ token }));
      assert.equal(f.c.getSnapshot().playing, false, timing);
    }
    f.c.stop();
  }
});
