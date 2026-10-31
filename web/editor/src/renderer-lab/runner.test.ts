import test from "node:test";
import assert from "node:assert/strict";
import {
  cameraEye,
  clearPreviousActors,
  resolveFixtureEquipment,
  RendererRunner,
  validateBatch,
  labError,
  smokeCases,
  resolveStage,
  readyReplayBodyCount,
} from "./runner";

test("a cold frozen batch advances the production teardown fade before waiting for zero actors", async () => {
  let frames = 0;
  const order: string[] = [];
  await clearPreviousActors(
    async () => {
      order.push("status");
      return { resources: { replayBodies: frames >= 30 ? 0 : 1 } };
    },
    async (count) => {
      order.push("advance");
      frames += count;
    },
    new AbortController().signal,
  );
  assert.equal(order[0], "advance");
  assert.equal(frames, 30);
  assert.ok(order.includes("status"));
  const abort = new AbortController();
  abort.abort(new Error("cancelled fixture"));
  await assert.rejects(
    clearPreviousActors(
      async () => {
        throw new Error("unexpected status");
      },
      async () => {
        throw new Error("unexpected advance");
      },
      abort.signal,
    ),
    /cancelled fixture/,
  );
});
test("actor readiness admits loaded emitter-only models before particle simulation starts", () => {
  assert.equal(
    readyReplayBodyCount({
      resources: {
        replayBodies: 2,
        replayBodiesWithLoadedMeshes: 1,
        replayBodiesWithReadyVisuals: 2,
      },
      actorDiagnostics: [{ visual: { liveEmitters: 4, liveParticles: 0 } }],
    }),
    2,
  );
  assert.equal(
    readyReplayBodyCount({
      resources: {
        replayBodiesWithLoadedMeshes: 2,
        replayBodiesWithReadyVisuals: 0,
      },
    }),
    0,
    "meshes do not override a pending or failed production visual",
  );
  assert.equal(
    readyReplayBodyCount({ resources: { replayBodiesWithLoadedMeshes: 1 } }),
    1,
    "older diagnostic runtimes retain their mesh-based readiness",
  );
});
test("isolated fixtures translate together without mutating authored coordinates", () => {
  const source = smokeCases()[2],
    before = structuredClone(source);
  source.mapId = null;
  const staged = resolveStage(source, { mapId: 409, origin: [10, 20, 30] });
  assert.equal(staged.mapId, 409);
  assert.deepEqual(
    staged.camera.target,
    source.camera.target.map((v, i) => v + [10, 20, 30][i]),
  );
  assert.deepEqual(
    staged.actors[0].position,
    source.actors[0].position.map((v, i) => v + [10, 20, 30][i]),
  );
  assert.deepEqual(source.actors, before.actors);
  const world = smokeCases()[3];
  assert.deepEqual(resolveStage(world), world);
});
import { EditorController } from "../controller";
test("fixture validation bounds batches and rejects duplicates before native calls", () => {
  const cases = smokeCases();
  assert.equal(validateBatch(cases).length, 4);
  assert.throws(() => validateBatch([]));
  assert.throws(() => validateBatch([cases[0], cases[0]]), /Duplicate/);
  assert.throws(() =>
    validateBatch([
      { ...cases[0], camera: { ...cases[0].camera, distance: NaN } },
    ]),
  );
});
test("camera places a known diagnostic viewpoint in native world units", () => {
  const c = smokeCases()[0];
  c.camera = { target: [10, 20, 30], yaw: 0, pitch: 0, distance: 5 };
  assert.deepEqual(cameraEye(c), [15, 20, 30]);
});
test("appearance fixtures retain non-default dials and reject malformed byte tuples", () => {
  const c = smokeCases()[2];
  c.actors[0].look = [1, 2, 3, 4, 0];
  assert.deepEqual(validateBatch([c])[0].actors[0].look, [1, 2, 3, 4, 0]);
  for (const look of [
    [1, 2],
    [0, 0, -1, 0, 0],
    [0, 0, 0, 256, 0],
    [0, 0, 1.5, 0, 0],
  ]) {
    assert.throws(
      () => validateBatch([{ ...c, actors: [{ ...c.actors[0], look }] }]),
      /appearance dials/,
    );
  }
});
test("unsupported and unavailable assets remain distinct from renderer failures", () => {
  const e = new Error("capability");
  e.name = "ClientUnsupportedError";
  assert.equal(labError(e), "unsupported");
  e.name = "NotFoundError";
  assert.equal(labError(e), "unavailable");
  e.name = "Error";
  assert.equal(labError(e), "failed");
});
test("renderer workbench boot does not initialize project or WCL services", async () => {
  let touched = false;
  const store = {
    list: async () => {
      touched = true;
      throw Error("must not touch projects");
    },
  };
  const c = new EditorController(undefined, {
    rendererLab: true,
    browserAssets: true,
    projectStore: store as any,
    clientCache: null,
    clientFolders: null,
  });
  await c.boot();
  assert.equal(touched, false);
  assert.equal(c.getSnapshot().wclConnected, false);
  assert.equal(c.getSnapshot().projects.length, 0);
  assert.equal(c.rendererLabResources().engine, null);
  c.stop();
  const normal = new EditorController();
  assert.throws(() => normal.rendererLabResources(), /not enabled/);
  normal.stop();
});

test("editor callbacks do not inject plan actors or annotations into diagnostic fixtures", async () => {
  const { EditorController } = await import("../controller");
  const controller = new EditorController(undefined, {
    rendererLab: true,
    projectStore: null,
    clientFolders: null,
  });
  const calls: string[] = [];
  (controller as any).engine = {
    set_annotations: () => calls.push("annotations"),
    set_replay_frame: () => calls.push("actors"),
    set_replay_nameplate_filters: () => calls.push("plates"),
    set_replay_raid_frames: () => calls.push("raidframes"),
  };
  (controller as any).sceneActors = () => [
    { key: "reference", type: "Player", class: "Mage", name: "Reference" },
  ];
  (controller as any).actorPose = () => ({
    pos: [1, 2, 3],
    facing: 0,
    dead: false,
  });
  controller.render();
  (controller as any).sendPositions();
  (controller as any).sendAnnotations();
  assert.deepEqual(calls, []);
});

test("case preparation failures are recorded and later cases still run", async () => {
  const graph = {
    source: {},
    spells: { 1: { visuals: [{ id: 1 }] } },
    visuals: { 1: { events: [{ kit: 1 }] } },
    kits: { 1: { effects: [{ effect: 1 }] } },
    effects: { 1: { type: 0, fileDataID: 1 } },
  };
  let preparations = 0;
  const engine = {
    renderer_lab_configure() {},
    renderer_lab_advance() {},
    set_replay_nameplates() {},
    set_replay_raid_frames() {},
    set_annotations() {},
  };
  const files = {
    readSync: () => new TextEncoder().encode(JSON.stringify(graph)),
    prepare: async () => {
      preparations++;
      throw Object.assign(new Error("Unsupported model feature"), {
        name: "ClientUnsupportedError",
      });
    },
  };
  const controller = {
    rendererLabResources: () => ({
      engine,
      files,
      bridge: {
        catalog: async (kind: string) => (kind === "spells" ? graph : {}),
      },
    }),
  } as unknown as EditorController;
  const first = smokeCases()[0];
  first.id = "preparation-failure";
  first.effects = [
    { id: "cast", spellId: 1, stage: "cast", startMs: 0, durationMs: 1000 },
  ];
  const next = smokeCases()[0];
  next.id = "later-case";
  next.seed = 2;
  const samples: any[] = [];
  const previous = (globalThis as any).window;
  (globalThis as any).window = {};
  const runner = new RendererRunner(controller);
  try {
    await runner.run([first, next], new AbortController().signal, (s) =>
      samples.push(s),
    );
    assert.equal(preparations, 1);
    assert.deepEqual(
      samples.map((s) => [s.caseId, s.status]),
      [
        ["preparation-failure", "unsupported"],
        ["later-case", "unverified"],
      ],
    );
    assert.match(samples[0].error, /Unsupported model feature/);
    assert.match(samples[1].error, /unimplemented seed/);
  } finally {
    runner.dispose();
    (globalThis as any).window = previous;
  }
});

test("equipment fixtures preserve intrinsic display joins and both enchant slots", () => {
  const catalog = {
    items: { 42: { display: 20, inventory: 13, enchant: 999 } },
  };
  const gear = resolveFixtureEquipment(
    [{ slot: 15, itemId: 42, enchant: 7, temporary: 8 }],
    catalog,
  );
  assert.equal(gear[0].display, 20);
  assert.equal(gear[0].enchant, 7);
  assert.equal(gear[0].temporary, 8);
  assert.equal(
    resolveFixtureEquipment([{ slot: 15, itemId: 42 }], catalog)[0].enchant,
    0,
  );
  assert.equal(
    resolveFixtureEquipment(
      [{ slot: 15, itemId: 42, displayId: 21 }],
      catalog,
    )[0].display,
    21,
  );
  assert.throws(
    () => resolveFixtureEquipment([{ slot: 15, itemId: 99 }], catalog),
    /No local item\/display join/,
  );
  const c = smokeCases()[0];
  c.actors[0].equipment = [{ slot: 15, itemId: 42, enchant: 0x100000000 }];
  assert.throws(() => validateBatch([c]), /invalid equipment/);
});

test("display-directed equipment uses unambiguous source metadata instead of requiring an item ID", () => {
  const row = {
    display: 21,
    class: 2,
    subclass: 7,
    inventory: 13,
    material: 1,
    sheath: 3,
  };
  const catalog = { items: { 42: row, 43: { ...row } }, displays: { 21: {} } };
  const gear = resolveFixtureEquipment(
    [{ slot: 15, displayId: 21, enchant: 7 }],
    catalog,
  )[0];
  assert.equal(gear.id, 42);
  assert.equal(gear.display, 21);
  assert.equal(gear.class, 2);
  assert.equal(gear.subclass, 7);
  assert.equal(gear.enchant, 7);
  assert.throws(
    () =>
      resolveFixtureEquipment([{ slot: 15, displayId: 21 }], {
        ...catalog,
        items: { ...catalog.items, 44: { ...row, subclass: 15 } },
      }),
    /No local item\/display join/,
  );
  assert.equal(
    resolveFixtureEquipment([{ slot: 15, itemId: 44, displayId: 21 }], {
      items: {},
      unresolvedItems: { 44: { ...row, display: 0 } },
    })[0].class,
    2,
  );
});
