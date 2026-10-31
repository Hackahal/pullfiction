import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorController } from "./controller";
import type { Engine, NativeFrame, RawReplay } from "./types";
import { STORAGE_KEY } from "./domain";
import luaparse from "luaparse";
import { IDBFactory } from "fake-indexeddb";
import { IndexedProjectStore, newProject, replaySource } from "./project-store";
import { emptyPlan } from "./domain";
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
      movement: { from: number[]; to: number[] } | null;
    };
    assert.ok(player.position);
    if (enabled) {
      assert.ok(player.movement);
      assert.equal(player.movement.from[2], from ?? hint);
      assert.equal(player.movement.to[2], to ?? hint);
    } else {
      assert.equal(player.movement, null);
      assert.equal(player.ground, true);
      assert.deepEqual(player.position, [5, -1, 0]);
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
  assert.deepEqual(frame, []);
  assert.match(c.referenceSpawnNotice()!, /not yet available/);
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
