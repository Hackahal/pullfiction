import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { EditorController } from "./controller";
import { IndexedProjectStore, newProject } from "./project-store";
import { emptyPlan, STORAGE_KEY } from "./domain";
import type { Engine, RawReplay } from "./types";
const raw = {
  gameVersion: "vanilla",
  report: { code: "DyN7vF94QR8aj1Lc", title: "MC run" },
  fight: {
    id: 4,
    name: "Lucifron",
    startTime: 1000,
    endTime: 12000,
    gameZone: { id: 409, name: "Molten Core" },
    friendlyPlayers: [1],
  },
  actors: [{ id: 1, name: "Mage", type: "Player", subType: "Mage" }],
  events: [
    {
      timestamp: 1000,
      type: "damage",
      sourceID: 1,
      resourceActor: 1,
      x: 100,
      y: 200,
      amount: 2,
      abilityGameID: 133,
    },
  ],
} as unknown as RawReplay;
function setup() {
  const memory = new Map<string, string>();
  const store = new IndexedProjectStore(new IDBFactory());
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
  };
  const controller = new EditorController(storage, {
    browserAssets: false,
    projectStore: store,
  });
  return { controller, store, memory, storage };
}
for (const extra of ["none", "report-free", "no-snapshot"] as const) {
  test(`opening a project prepares reference textures only for pages that need them: ${extra}`, async () => {
    const { controller: c, store } = setup();
    const plan = emptyPlan(249);
    plan.steps[0].snapshot = {
      report: "DyN7vF94QR8aj1Lc",
      time: 0,
      actors: [
        {
          key: "saved",
          name: "Recorded NPC",
          class: "NPC",
          type: "NPC",
          displayID: 22222,
          position: [1, 2, 3],
          facing: 0,
        },
      ],
    };
    if (extra !== "none") {
      plan.steps.push({ ...plan.steps[0], id: "blank", name: "Blank page" });
      plan.steps[1].snapshot =
        extra === "report-free"
          ? { report: "", time: 0, actors: [] }
          : undefined;
    }
    const project = newProject(plan);
    await store.put(project);
    const prepared: string[] = [];
    const referenceTexture = "__classic/991.blp";
    (c as any).referenceModels.vanilla = { 10184: { displayID: 11111 } };
    (c as any).localFiles = {
      close() {},
      async prepare(resources: string[]) {
        prepared.push(...resources);
        if (extra === "none" && resources.includes(referenceTexture))
          throw new Error("Missing unused reference texture");
      },
    };
    (c as any).browserBridge = {
      async map() {
        return { floors: [], areas: [] };
      },
      async catalog(kind: string) {
        return kind === "creatures"
          ? {
              displays: {
                11111: { textures: [991] },
                22222: { textures: [992] },
              },
            }
          : {};
      },
    };
    try {
      assert.equal(
        await c.openProject(project.id),
        true,
        c.getSnapshot().error ?? "",
      );
      assert.ok(prepared.includes("__classic/992.blp"));
      assert.equal(prepared.includes(referenceTexture), extra !== "none");
      assert.equal(c.getSnapshot().projectId, project.id);
      assert.equal(
        c.getSnapshot().plan.steps[0].snapshot?.actors[0].key,
        "saved",
      );
    } finally {
      c.stop();
    }
  });
}
test("projects on one map keep independent edits, undo and local source context", async () => {
  const { controller: c, store } = setup();
  await c.initializeLibrary();
  assert.equal(await c.createProject(409, "vanilla", "Safe route"), true);
  const first = c.getSnapshot().projectId!;
  c.updateStep({ notes: "Wait for mana" });
  await c.saveProject();
  await c.createProject(409, "vanilla", "Fast route");
  const second = c.getSnapshot().projectId!;
  c.updateStep({ notes: "Chain pull" });
  await c.saveProject();
  assert.notEqual(first, second);
  assert.equal((await store.list()).length, 2);
  await c.openProject(first);
  assert.equal(c.getSnapshot().plan.steps[0].notes, "Wait for mana");
  assert.equal(c.getSnapshot().canUndo, false);
  assert.equal((await store.get(second))?.plan.steps[0].notes, "Chain pull");
  const copy = await c.duplicateProject(first);
  assert.ok(copy);
  assert.equal((await store.get(copy!))?.plan.steps[0].notes, "Wait for mana");
  await c.trashProject(copy!);
  assert.ok((await store.get(copy!))?.deletedAt);
  await c.trashProject(copy!, true);
  assert.equal((await store.get(copy!))?.deletedAt, null);
  c.stop();
});
test("committed edits autosave and are recovered by a fresh controller", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  await f.controller.createProject(409, "vanilla", "Draft");
  const id = f.controller.getSnapshot().projectId!;
  f.controller.rename("Autosaved route");
  assert.equal(f.controller.getSnapshot().saveStatus, "pending");
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(f.controller.getSnapshot().saveStatus, "saved");
  const fresh = new EditorController(f.storage, {
    browserAssets: false,
    projectStore: f.store,
  });
  await fresh.initializeLibrary();
  await fresh.openProject(id);
  assert.equal(fresh.getSnapshot().plan.name, "Autosaved route");
  f.controller.stop();
  fresh.stop();
});
test("a replay-backed plan reopens its exact cached events and paused position offline", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  f.controller.installReplay(raw);
  f.controller.seek(5000);
  f.controller.planFromMoment();
  await f.controller.saveProject();
  const id = f.controller.getSnapshot().projectId!;
  const fresh = new EditorController(f.storage, {
    browserAssets: false,
    projectStore: f.store,
  });
  await fresh.initializeLibrary();
  assert.equal(await fresh.openProject(id), true);
  assert.deepEqual(fresh.getSnapshot().replay?.raw.events, raw.events);
  assert.equal(fresh.getSnapshot().time, 5000);
  assert.equal(fresh.getSnapshot().workspaceMode, "plan");
  assert.equal(fresh.getSnapshot().sourceStatus, "cached");
  f.controller.stop();
  fresh.stop();
});
test("a failed local write retains dirty edits and prevents switching to another project", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  await f.controller.createProject(409, "vanilla", "Keep this");
  const id = f.controller.getSnapshot().projectId!;
  f.store.put = async () => {
    throw new Error("Quota exceeded");
  };
  f.controller.rename("Must not disappear");
  await f.controller.saveProject();
  assert.equal(f.controller.getSnapshot().saveStatus, "error");
  assert.equal(f.controller.getSnapshot().dirty, true);
  assert.equal(
    await f.controller.createProject(409, "vanilla", "Other"),
    false,
  );
  assert.equal(f.controller.getSnapshot().projectId, id);
  assert.equal(f.controller.getSnapshot().plan.name, "Must not disappear");
  assert.match(f.controller.getSnapshot().libraryError!, /Export a backup/);
  f.controller.stop();
});
test("legacy per-map saves migrate idempotently without modifying the old storage", async () => {
  const f = setup();
  const original = JSON.stringify({
    ...emptyPlan(409, "vanilla"),
    name: "Old MC route",
  });
  f.memory.set(STORAGE_KEY, original);
  await f.controller.initializeLibrary();
  const fresh = new EditorController(f.storage, {
    projectStore: f.store,
    browserAssets: false,
  });
  await fresh.initializeLibrary();
  assert.equal(
    (await f.store.list()).filter((p) => p.id === "legacy-vanilla-409").length,
    1,
  );
  assert.equal(f.memory.get(STORAGE_KEY), original);
  assert.equal(
    (await f.store.get("legacy-vanilla-409"))?.plan.name,
    "Old MC route",
  );
  f.controller.stop();
  fresh.stop();
});

test("starting an empty plan on the same map clears the previous recorded run", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  f.controller.installReplay(raw);
  await f.controller.saveProject();
  const old = f.controller.getSnapshot().projectId!;
  await f.controller.createProject(409, "vanilla", "Blank route");
  assert.equal(f.controller.getSnapshot().replay, null);
  assert.equal(f.controller.getSnapshot().sourceStatus, "none");
  assert.notEqual(f.controller.getSnapshot().projectId, old);
  assert.ok((await f.store.get(old))?.source);
  f.controller.stop();
});
test("project backup exports current dirty edits even when device storage is full", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  await f.controller.createProject(409, "vanilla", "Backup me");
  const id = f.controller.getSnapshot().projectId!;
  f.store.put = async () => {
    throw new Error("Quota exceeded");
  };
  f.controller.updateStep({ notes: "Do not lose these edits" });
  await f.controller.saveProject();
  let backup: any;
  (
    f.controller as unknown as {
      download: (value: unknown, name: string) => void;
    }
  ).download = (value) => {
    backup = value;
  };
  await f.controller.exportProject(id);
  assert.equal(backup.project.plan.steps[0].notes, "Do not lose these edits");
  assert.equal(backup.format, "pullfiction.project");
  f.controller.stop();
});

test("import keeps plan edits when its much larger source replay cannot be cached", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  f.controller.installReplay(raw);
  f.controller.updateStep({ notes: "Preserve this plan" });
  await f.controller.saveProject();
  const project = (await f.store.list())[0];
  f.store.putReplay = async () => {
    throw new Error("Source cache quota exceeded");
  };
  const file = new File(
    [
      JSON.stringify({
        format: "pullfiction.project",
        version: 1,
        project,
        replay: raw,
      }),
    ],
    "backup.json",
  );
  const id = await f.controller.importProject(file);
  assert.ok(id);
  assert.equal(
    (await f.store.get(id!))?.plan.steps[0].notes,
    "Preserve this plan",
  );
  assert.match(f.controller.getSnapshot().notice, /could not be cached/);
  assert.equal(
    f.controller
      .getSnapshot()
      .cachedSources.includes((await f.store.get(id!))!.source!.cacheKey),
    false,
  );
  f.controller.stop();
});

test("a failed autosave also blocks switching maps through the normal selector", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  await f.controller.createProject(409, "vanilla", "Keep this");
  f.store.put = async () => {
    throw new Error("Quota exceeded");
  };
  f.controller.updateStep({ notes: "Unsaved arrangement" });
  f.controller.selectRaid(533);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.controller.getSnapshot().plan.mapId, 409);
  assert.equal(
    f.controller.getSnapshot().plan.steps[0].notes,
    "Unsaved arrangement",
  );
  assert.equal(f.controller.getSnapshot().saveStatus, "error");
  f.controller.stop();
});
test("reloading an unavailable source preserves the existing plan and project identity", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  f.controller.installReplay(raw);
  f.controller.updateStep({ notes: "Keep the healer assignments" });
  await f.controller.saveProject();
  const id = f.controller.getSnapshot().projectId!;
  const read = f.store.getReplay.bind(f.store);
  f.store.getReplay = async () => null;
  await f.controller.openProject(id);
  assert.equal(f.controller.getSnapshot().sourceStatus, "missing");
  (f.controller as unknown as { api: () => Promise<RawReplay> }).api =
    async () => raw;
  assert.equal(await f.controller.reloadProjectSource(id), true);
  f.store.getReplay = read;
  assert.equal(f.controller.getSnapshot().projectId, id);
  assert.equal(
    f.controller.getSnapshot().plan.steps[0].notes,
    "Keep the healer assignments",
  );
  assert.deepEqual(f.controller.getSnapshot().replay?.raw.events, raw.events);
  f.controller.stop();
});

test("a report URL switches its ruleset only after protecting the current saved project", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  await f.controller.createProject(409, "sod", "SoD route");
  f.controller.updateStep({ notes: "Keep my SoD changes" });
  (f.controller as unknown as { api: () => Promise<unknown> }).api =
    async () => ({ title: "Era report", fights: [raw.fight] });
  await f.controller.loadReport(
    "https://vanilla.warcraftlogs.com/reports/DyN7vF94QR8aj1Lc",
  );
  assert.equal(f.controller.getSnapshot().gameVersion, "vanilla");
  assert.equal(f.controller.getSnapshot().report?.title, "Era report");
  assert.equal(
    (await f.store.list()).find((p) => p.plan.gameVersion === "sod")?.plan
      .steps[0].notes,
    "Keep my SoD changes",
  );
  f.controller.stop();
});

test("a paused seek is checkpointed without changing the plan or rewriting its source", async () => {
  const f = setup();
  await f.controller.initializeLibrary();
  f.controller.installReplay(raw);
  await f.controller.saveProject();
  const id = f.controller.getSnapshot().projectId!;
  const initial = (await f.store.get(id))!;
  f.controller.seek(4000);
  await new Promise((r) => setTimeout(r, 800));
  const saved = (await f.store.get(id))!;
  assert.equal(saved.time, 4000);
  assert.deepEqual(saved.plan, initial.plan);
  assert.equal(saved.source?.cacheKey, initial.source?.cacheKey);
  f.controller.stop();
});

test("Trashing the active project rejects marker hits queued before the reset", async () => {
  const { controller: c, store } = setup();
  await c.initializeLibrary();
  await c.createProject(409, "vanilla", "Pending marker");
  const id = c.getSnapshot().projectId!;
  const requests: number[] = [];
  c.attachEngine({
    set_annotations: () => {},
    set_replay_frame: () => {},
    replay_events: () => {},
    set_typing: () => {},
    load_raid: () => {},
    hover_annotation: (
      _x: number,
      _y: number,
      _placing: boolean,
      request?: number,
    ) => {
      if (request !== undefined) requests.push(request);
    },
  } as unknown as Engine);
  c.setTool("marker");
  c.placeSceneMarkerAt(30, 40);
  assert.equal(requests.length, 1);
  await c.trashProject(id);
  assert.equal(c.getSnapshot().projectId, null);
  const planAfterReset = JSON.stringify(c.getSnapshot().plan);
  c.receive(
    "plan-hover",
    JSON.stringify({ request: requests[0], pixel: [30, 40], point: [9, 8, 7] }),
  );
  assert.equal(JSON.stringify(c.getSnapshot().plan), planAfterReset);
  assert.ok((await store.get(id))?.deletedAt);
  assert.equal(
    (await store.list()).filter((project) => !project.deletedAt).length,
    0,
  );
  c.stop();
});

test("library metadata persists independently of autosave and opening records a real view", async () => {
  const { controller: c, store } = setup();
  const p = {
    ...newProject(emptyPlan(469)),
    kind: "replay" as const,
    lastViewedAt: 1,
  };
  await store.put(p);
  await c.initializeLibrary();
  await c.updateProjectMetadata(p.id, { savedRun: false, pinned: true });
  assert.equal((await store.get(p.id))?.lastViewedAt, 1);
  assert.equal((await store.get(p.id))?.savedRun, false);
  assert(await c.openProject(p.id));
  assert((await store.get(p.id))!.lastViewedAt! > 1);
  await c.updateProjectMetadata(p.id, { name: "Renamed" });
  await c.saveProject();
  const saved = await store.get(p.id);
  assert.equal(saved?.plan.name, "Renamed");
  assert.equal(saved?.savedRun, false);
  assert.equal(saved?.pinned, true);
  c.stop();
});
