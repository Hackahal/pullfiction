import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { Library } from "./Library";
import { BrowserNameplates } from "./BrowserNameplates";
import { parseBrowserPlates } from "./browser-plates";
import { BrowserRaidFrames, resourcePercent } from "./BrowserRaidFrames";
import { EditorController } from "./controller";
import {
  assetBridge,
  removeAssetBridge,
  type CatalogKind,
  type ClientReader,
} from "./browser-assets";
import {
  clearWclCallback,
  isWclCallback,
  createBrowserLogs,
} from "./browser-wcl";
import type { Engine, RawReplay } from "./types";
import { IndexedClientAssetCache } from "./client-cache";
import { IDBFactory } from "fake-indexeddb";

afterEach(() => {
  // Mock engines have no running WASM instance retaining the provider after controller.stop().
  const files = (globalThis as any).__pullfiction_local_files;
  files?.close();
  Reflect.deleteProperty(globalThis, "__pullfiction_local_files");
});

function readerFixture() {
  const calls: string[] = [];
  const catalogs = {
    creatures: {
      displays: {
        "13031": { modelID: 1, scale: 2 },
        "13032": { modelID: 1, scale: 3 },
      },
      models: { "1": { fileDataID: 123, scale: 1.5 } },
    },
    items: { items: { 7: { display: 90, iconFile: 12 } } },
    spells: { spells: { 133: { castMs: 3000 } } },
    world: { schema: 1 },
    lighting: { schema: 1 },
    characters: {
      schema: 1,
      sectionTextureTypes: [{ race: 1, sex: 0, types: [1, 6] }],
    },
    talents: { schema: 1, readable: true, partial: false, trees: [] },
  };
  const reader: ClientReader = {
    build: {
      version: "1.15.9.70003",
      product: "wow_classic_era",
      buildKey: "local",
    },
    async read(resource) {
      calls.push(`read:${resource}`);
      return { bytes: new Uint8Array([1, 2]).buffer };
    },
    async model(resource) {
      calls.push(`model:${resource}`);
      return { bytes: new Uint8Array([3, 4]).buffer };
    },
    async catalog(kind) {
      calls.push(`catalog:${kind}`);
      return catalogs[kind];
    },
    async appearance(request) {
      return {
        recipe: request,
        textures: [1, 6].map((type) => ({
          type,
          width: 1,
          height: 1,
          pixels: new Uint8Array([1, 2, 3, 255]).buffer,
        })),
      };
    },
    close() {
      calls.push("close");
    },
  };
  return { reader, calls, catalogs };
}
const raw: RawReplay = {
  report: { code: "DyN7vF94QR8aj1Lc", title: "Local replay" },
  fight: {
    id: 1,
    name: "Lucifron",
    startTime: 1000,
    endTime: 12000,
    gameZone: { name: "Molten Core" },
    friendlyPlayers: [1],
  },
  actors: [{ id: 1, name: "Mage", type: "Player", subType: "Mage" }],
  abilities: [{ gameID: 133, name: "Fireball" }],
  events: [
    { timestamp: 1000, type: "combatantinfo", sourceID: 1 },
    {
      timestamp: 2000,
      type: "damage",
      sourceID: 1,
      resourceActor: 1,
      x: 100,
      y: 200,
      hitPoints: 50,
      maxHitPoints: 100,
      classResources: [{ type: 0, amount: 60, max: 100 }],
      abilityGameID: 133,
    },
  ],
} as unknown as RawReplay;
function engineFixture(onStart: () => void = () => {}) {
  const frames: any[][] = [];
  const raids: number[] = [];
  const engine = new Proxy(
    {
      default: async () => {},
      start: onStart,
      set_replay_frame: (json: string) => frames.push(JSON.parse(json)),
      load_raid: (map: number) => raids.push(map),
    },
    {
      get: (target, key) =>
        key === "then"
          ? undefined
          : (target[key as keyof typeof target] ?? (() => {})),
    },
  ) as unknown as Engine;
  return { engine, frames, raids };
}

test("Classic icon aliases fall back only after a confirmed missing local asset", async () => {
  const { reader } = readerFixture();
  const calls: string[] = [];
  reader.read = async (name) => {
    calls.push(name);
    if (name.includes("classic_"))
      throw new DOMException("Absent", "NotFoundError");
    return { bytes: new Uint8Array([8, 9]).buffer };
  };
  const bridge = assetBridge(reader);
  assert.deepEqual(
    await bridge.read("interface/icons/classic_temp.blp"),
    new Uint8Array([8, 9]),
  );
  assert.deepEqual(calls, [
    "interface/icons/classic_temp.blp",
    "interface/icons/temp.blp",
  ]);
  reader.read = async () => {
    throw new Error("Archive offline");
  };
  await assert.rejects(
    bridge.read("interface/icons/classic_temp.blp"),
    /Archive offline/,
  );
  reader.read = async (name) => {
    calls.push(name);
    return { bytes: new Uint8Array([7]).buffer };
  };
  assert.deepEqual(
    await bridge.read("interface/icons/classic_temp.blp"),
    new Uint8Array([7]),
  );
  assert.equal(calls.at(-1), "interface/icons/classic_temp.blp");
});

test("Browser bridge converts model resources, reads raw textures and preserves appearance buffers", async () => {
  const { reader, calls } = readerFixture();
  const bridge = assetBridge(reader);
  assert.deepEqual(
    await bridge.read("__classic/123.m2"),
    new Uint8Array([3, 4]),
  );
  assert.deepEqual(
    await bridge.read("__classic/456.blp"),
    new Uint8Array([1, 2]),
  );
  await bridge.read("creature/ragnaros/ragnaros.m2");
  await bridge.read("interface/icons/ability.blp");
  await bridge.read("Interface/Icons/pf_789.blp");
  assert.deepEqual(calls, [
    "model:id:123",
    "read:id:456",
    "model:creature/ragnaros/ragnaros.m2",
    "read:interface/icons/ability.blp",
    "read:id:789",
  ]);
  const request = { race: 1, sex: 0 };
  assert.equal((await bridge.appearance(request)).recipe, request);
});

test("Browser catalogs deduplicate in-flight requests and retry a failed preparation", async () => {
  const { reader, calls } = readerFixture();
  const original = reader.catalog;
  let fails = true;
  reader.catalog = async (kind: CatalogKind) => {
    if (fails) {
      fails = false;
      throw new Error("incomplete client");
    }
    return original(kind);
  };
  const bridge = assetBridge(reader);
  await assert.rejects(bridge.catalog("items"), /incomplete client/);
  const [a, b] = await Promise.all([
    bridge.catalog("items"),
    bridge.catalog("items"),
  ]);
  assert.equal(a, b);
  assert.deepEqual(calls, ["catalog:items"]);
});

test("Browser bridge converts world formats and preserves virtual WMO group references", async () => {
  const { reader, calls } = readerFixture();
  reader.world = async (resource) => {
    calls.push(`world:${resource}`);
    return { bytes: new Uint8Array([5, 6]).buffer };
  };
  const map = {
    map: 409,
    bounds: [0, 0, 1, 1],
    areas: [],
    tiles: [],
    floors: [],
  } as const;
  reader.map = async (mapId, directory) => {
    calls.push(`map:${mapId}:${directory}`);
    return map as unknown as Awaited<
      ReturnType<NonNullable<ClientReader["map"]>>
    >;
  };
  const bridge = assetBridge(reader);
  for (const resource of [
    "World/Maps/MoltenCore/MoltenCore.wdt",
    "world/maps/azeroth/azeroth_32_32.adt",
    "__classic/123.wmo",
    "__classic/123_007.wmo",
  ])
    assert.deepEqual(await bridge.read(resource), new Uint8Array([5, 6]));
  assert.equal(await bridge.map(409, "MoltenCore"), map);
  assert.deepEqual(calls, [
    "world:World/Maps/MoltenCore/MoltenCore.wdt",
    "world:world/maps/azeroth/azeroth_32_32.adt",
    "world:__classic/123.wmo",
    "world:__classic/123_007.wmo",
    "map:409:MoltenCore",
  ]);
  const unsupported = assetBridge(readerFixture().reader);
  await assert.rejects(
    unsupported.read("__classic/123_007.wmo"),
    /raid environments/,
  );
  await assert.rejects(unsupported.map(409, "MoltenCore"), /tactical maps/);
});

test("Browser boot waits for file selection and all modern catalogs without fetching local endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request");
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const { reader, calls } = readerFixture();
  const { engine } = engineFixture(() => {
    assert.deepEqual(calls.slice(0, 3), [
      "catalog:creatures",
      "catalog:items",
      "catalog:spells",
    ]);
    assert.ok(calls.includes("catalog:world"));
    assert.ok(calls.includes("catalog:lighting"));
    assert.ok((globalThis as any).__pullfiction_local_files);
    assert.ok(!calls.some((call) => /\.dbc$/i.test(call)));
  });
  const c = new EditorController(undefined, {
    browserAssets: true,
    openClient: async () => reader,
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  try {
    await c.boot();
    assert.equal(c.getSnapshot().ready, false);
    assert.equal(c.getSnapshot().clientStatus, "select");
    const markup = renderToString(createElement(App, { controller: c }));
    assert.match(markup, /Retry download/);
    assert.doesNotMatch(markup, /World of Warcraft client folder/);
    assert.doesNotMatch(markup, /webkitdirectory/);
    assert.doesNotMatch(markup, /Native raid frame bounds/);
    await c.openClient([]);
    assert.equal(c.getSnapshot().ready, true);
    assert.equal(c.getSnapshot().clientBuild, "1.15.9.70003");
    const bridge = (globalThis as any).__pullfiction_assets;
    assert.ok(bridge);
    await bridge.catalog("spells");
    assert.equal(calls.filter((x) => x === "catalog:spells").length, 1);
    await c.importFile(
      { size: 1, text: async () => JSON.stringify(raw) } as File,
      "replay",
    );
    assert.equal(c.getSnapshot().replay?.report.title, "Local replay");
    c.seek(1000);
    const frames = renderToString(
      createElement(BrowserRaidFrames, {
        state: c.getSnapshot(),
        controller: c,
      }),
    );
    assert.match(frames, /Mage, Mage, 50% health/);
    assert.match(frames, /Mana 60%/);
    assert.doesNotMatch(frames, /\/game-ui/);
    removeAssetBridge(bridge);
  } finally {
    c.stop();
    reader.close();
    globalThis.fetch = originalFetch;
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("Cancellation terminates preparation and a failed folder remains selectable", async () => {
  const c = new EditorController(undefined, {
    browserAssets: true,
    openClient: async (_files, _progress, { signal }) => {
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const opening = c.openClient([]);
  assert.equal(c.getSnapshot().clientStatus, "opening");
  c.cancelClient();
  await opening;
  assert.equal(c.getSnapshot().clientStatus, "select");
  assert.equal(c.getSnapshot().error, null);
  c.stop();
  const failure = new EditorController(undefined, {
    browserAssets: true,
    openClient: async () => {
      throw new Error("Missing .build.info");
    },
  });
  await failure.openClient([]);
  assert.equal(failure.getSnapshot().clientStatus, "error");
  assert.match(failure.getSnapshot().error ?? "", /Missing .build.info/);
  failure.stop();
});

test("OAuth callback cleanup preserves unrelated URL state and removes authorization parameters", () => {
  const callback = new URL(
    "https://example.org/editor?view=plan&code=private&state=random#panel",
  );
  assert.equal(isWclCallback(callback), true);
  assert.equal(clearWclCallback(callback), "/editor?view=plan#panel");
  assert.equal(
    isWclCallback(new URL("https://example.org/editor?code=a")),
    true,
  );
  assert.equal(
    isWclCallback(new URL("https://example.org/editor?view=plan")),
    false,
  );
  assert.equal(
    clearWclCallback(
      new URL("https://example.org/?error=denied&error_description=no&state=s"),
    ),
    "/",
  );
});

test("Unknown raid resources stay unknown and finite values clamp safely", () => {
  assert.equal(resourcePercent(null, 100), null);
  assert.equal(resourcePercent(1, 0), null);
  assert.equal(resourcePercent(NaN, 100), null);
  assert.equal(resourcePercent(120, 100), 100);
  assert.equal(resourcePercent(-1, 100), 0);
});

test("Browser nameplates bind projected units, class colors, health and independent filters", () => {
  const c = new EditorController(undefined, { browserAssets: true });
  c.installReplay(raw);
  const plates = [
    {
      key: "1:1",
      name: "Mage",
      x: 120,
      y: 80,
      class: 8,
      friendly: false,
      health: 50,
      maxHealth: 100,
    },
    {
      key: "2:1",
      name: "Enemy",
      x: 200,
      y: 140,
      class: 1,
      friendly: false,
      health: null,
      maxHealth: null,
    },
  ];
  c.receive("plates", JSON.stringify(plates));
  assert.equal(c.getSnapshot().browserPlates.length, 2);
  const markup = () =>
    renderToString(
      createElement(BrowserNameplates, {
        state: c.getSnapshot(),
        controller: c,
      }),
    );
  assert.match(markup(), /left:120px;top:80px/);
  assert.match(markup(), /color:#69ccf0/);
  assert.match(markup(), /aria-valuenow="50"/);
  assert.match(markup(), /Enemy, health unavailable/);
  c.select("1:1");
  assert.match(markup(), /aria-label="Select Mage" aria-pressed="true"/);
  c.setOption("friendlyNameplates", false);
  assert.match(markup(), /Select Mage/);
  assert.match(markup(), /browser-nameplate-name-only/);
  assert.doesNotMatch(markup(), /Mage health/);
  assert.match(markup(), /Select Enemy/);
  c.setOption("friendlyNameplates", true);
  c.setOption("enemyNameplates", false);
  assert.match(markup(), /Select Mage/);
  assert.doesNotMatch(markup(), /Select Enemy/);
  c.setOption("nameplates", false);
  assert.match(markup(), /Select Mage/);
  assert.doesNotMatch(markup(), /Select Enemy|role="meter"/);
  c.receive("plates", "not JSON");
  assert.deepEqual(c.getSnapshot().browserPlates, []);
  assert.deepEqual(
    parseBrowserPlates(JSON.stringify([{ ...plates[0], x: null }])),
    [],
  );
  c.stop();
});

test("Cancelling while WASM initializes prevents a renderer from starting with a closed reader", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const { reader, calls } = readerFixture();
  let started = 0;
  let finishWasm!: () => void;
  let enteredWasm!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredWasm = resolve;
  });
  const wasm = new Promise<void>((resolve) => {
    finishWasm = resolve;
  });
  const { engine } = engineFixture(() => {
    started++;
  });
  engine.default = async () => {
    enteredWasm();
    await wasm;
  };
  const c = new EditorController(undefined, {
    browserAssets: true,
    openClient: async () => reader,
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  try {
    const opening = c.openClient([]);
    await entered;
    c.cancelClient();
    finishWasm();
    await opening;
    assert.equal(started, 0);
    assert.equal(c.getSnapshot().clientStatus, "select");
    assert.equal(c.getSnapshot().error, null);
    assert.ok(calls.includes("close"));
  } finally {
    c.stop();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("An expired or missing browser session returns the import UI to Connect", async () => {
  let disconnected = 0;
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage;
  const { logs } = createBrowserLogs(
    { clientId: "public-client", redirectUri: "https://example.org/" },
    storage,
    () => {
      disconnected++;
    },
  );
  await assert.rejects(
    logs.report("DyN7vF94QR8aj1Lc"),
    /Connect Warcraft Logs/,
  );
  assert.equal(disconnected, 1);
});

test("Browser controller resolves bundled NPCs, preserves raw overrides and never borrows Era display IDs for SoD", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const { reader } = readerFixture();
  const { engine } = engineFixture();
  const index = {
    schema: 1,
    provider: "Wowhead",
    versions: {
      vanilla: {
        creatures: {
          "12118": {
            name: "Lucifron",
            displayID: 13031,
            displayIDs: [13031],
            templateScale: 0,
            sourceURL: "https://www.wowhead.com/classic/npc=12118",
            sourceSHA256: "a".repeat(64),
          },
        },
      },
      sod: { creatures: {} },
    },
  };
  const c = new EditorController(undefined, {
    browserAssets: true,
    openClient: async () => reader,
    loadNpcIndex: async () => index,
    loadEngine: async () => engine,
  });
  const replay: RawReplay = {
    ...raw,
    actors: [
      ...raw.actors,
      { id: 2, name: "Lucifron", type: "NPC", gameID: 12118 },
    ],
    events: [
      ...raw.events,
      {
        timestamp: 2001,
        type: "damage",
        sourceID: 1,
        targetID: 2,
        abilityGameID: 133,
        amount: 1,
      },
    ],
  };
  try {
    await c.openClient([]);
    assert.equal(c.getSnapshot().ready, true);
    c.installReplay(replay);
    assert.equal(
      c.getSnapshot().replay?.actors.find((actor) => actor.gameID === 12118)
        ?.displayID,
      13031,
    );
    c.installReplay({
      ...replay,
      gameVersion: "sod",
      report: { ...raw.report, gameVersion: "sod" },
    });
    assert.equal(
      c.getSnapshot().replay?.actors.find((actor) => actor.gameID === 12118)
        ?.displayID,
      null,
    );
    const supplied = {
      ...replay,
      models: { "12118": { displayID: 13032, scale: 6 } },
    };
    c.installReplay(supplied);
    const npc = c
      .getSnapshot()
      .replay?.actors.find((actor) => actor.gameID === 12118);
    assert.equal(npc?.displayID, 13032);
    assert.equal(npc?.scale, 6);
    assert.equal(supplied.models["12118"].scale, 6);
    assert.equal(c.getSnapshot().replay?.raw, supplied);
  } finally {
    c.stop();
    reader.close();
    const bridge = (globalThis as any).__pullfiction_assets;
    if (bridge) removeAssetBridge(bridge);
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a cached project checkpoint survives selecting the client after reopening", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { IndexedProjectStore, newProject, replaySource } =
    await import("./project-store");
  const { emptyPlan } = await import("./domain");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const store = new IndexedProjectStore(new IDBFactory());
  const source = replaySource(raw, 409);
  await store.putReplay(source.cacheKey, raw);
  const project = {
    ...newProject(emptyPlan(409, "vanilla"), source),
    time: 5000,
    mode: "analyse" as const,
    kind: "replay" as const,
  };
  await store.put(project);
  const { reader } = readerFixture();
  const { engine } = engineFixture();
  const c = new EditorController(undefined, {
    browserAssets: true,
    projectStore: store,
    openClient: async () => reader,
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  try {
    await c.initializeLibrary();
    await c.openProject(project.id);
    await c.openClient([]);
    assert.equal(c.getSnapshot().clientStatus, "ready");
    assert.equal(c.getSnapshot().time, 5000);
    assert.equal(c.getSnapshot().workspaceMode, "analyse");
  } finally {
    c.stop();
    reader.close();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a source replay failure does not close an already booted local client", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { IndexedProjectStore, newProject, replaySource } =
    await import("./project-store");
  const { emptyPlan } = await import("./domain");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const store = new IndexedProjectStore(new IDBFactory()),
    source = replaySource(raw, 409);
  await store.putReplay(source.cacheKey, raw);
  const project = {
    ...newProject(emptyPlan(409, "vanilla"), source),
    time: 5000,
  };
  await store.put(project);
  const { reader, calls } = readerFixture();
  const { engine } = engineFixture();
  engine.set_replay_frame = (json: string) => {
    if (JSON.parse(json).length) throw new Error("Fixture frame rejected");
  };
  const c = new EditorController(undefined, {
    browserAssets: true,
    projectStore: store,
    openClient: async () => reader,
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  try {
    await c.initializeLibrary();
    await c.openProject(project.id);
    await c.openClient([]);
    assert.equal(c.getSnapshot().clientStatus, "ready");
    assert.match(c.getSnapshot().libraryError!, /Fixture frame rejected/);
    assert.equal(calls.includes("close"), false);
  } finally {
    c.stop();
    reader.close();
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("cold indoor imports send local room height to native actors, focus and teleport streaming without opening 2D", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: {} },
    configurable: true,
  });
  const { reader } = readerFixture();
  const mapCalls: number[] = [],
    focuses: number[][] = [];
  reader.map = async (map) => {
    mapCalls.push(map);
    const floor = (z: number, interior: boolean) => ({
      area: interior ? "room" : "terrain",
      interior,
      vertices: [
        [-100, -100, z],
        [200, -100, z],
        [-100, 200, z],
      ] as [number, number, number][],
      indices: [0, 1, 2],
    });
    return {
      map,
      bounds: [-100, -100, 200, 200],
      areas: [],
      tiles: [],
      floors: [floor(104, false), floor(186, true)],
    };
  };
  const { engine, frames } = engineFixture();
  engine.focus_replay = (...point) => {
    focuses.push(point);
  };
  const c = new EditorController(undefined, {
    browserAssets: true,
    openClient: async () => reader,
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  try {
    await c.openClient([]);
    const indoor = {
      ...raw,
      gameVersion: "sod",
      fight: { ...raw.fight, gameZone: { id: 2856, name: "Scarlet Enclave" } },
    };
    await c.importFile(
      { size: 1, text: async () => JSON.stringify(indoor) } as File,
      "replay",
    );
    assert.equal(c.getSnapshot().replay?.map, 2856);
    c.seek(1000);
    const player = frames
      .flat()
      .reverse()
      .find((frame: any) => frame.key === "1:1" && frame.position);
    assert.equal(player?.floor_hint, 186);
    c.focus("1:1");
    assert.equal(focuses.at(-1)?.[2], 186);
    c.setOption("followRaid", true);
    c.render();
    assert.deepEqual(focuses.at(-1), [2, -1, 186]);
    assert.equal(mapCalls.filter((map) => map === 2856).length, 1);
    removeAssetBridge((globalThis as any).__pullfiction_assets);
  } finally {
    c.stop();
    reader.close();
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

// Remembered folders use the same real startup/catalog/provider path as files.
function folderAccessFixture(
  permission: PermissionState = "granted",
  exists = true,
) {
  const handle = {
    kind: "directory",
    name: "World of Warcraft",
  } as import("./client-folder").ClientDirectory;
  let saved = exists ? handle : null,
    currentPermission = permission;
  const calls: string[] = [];
  const access: import("./client-folder").ClientFolderAccess = {
    supported: true,
    load: async () => {
      calls.push("load");
      return saved;
    },
    save: async (h) => {
      calls.push("save");
      saved = h;
    },
    forget: async () => {
      calls.push("forget");
      saved = null;
    },
    pick: () => {
      calls.push("pick");
      return Promise.resolve(handle);
    },
    permission: (_h, request) => {
      calls.push(request ? "request-read" : "query-read");
      return Promise.resolve(currentPermission);
    },
  };
  return {
    handle,
    access,
    calls,
    saved: () => saved,
    grant: () => {
      currentPermission = "granted";
    },
  };
}
function rememberedController(
  t: any,
  access: import("./client-folder").ClientFolderAccess,
) {
  const d = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: {} },
  });
  const { reader } = readerFixture(),
    { engine } = engineFixture();
  const sources: import("./client-folder").ClientSelection[] = [];
  const c = new EditorController(undefined, {
    browserAssets: true,
    clientFolders: access,
    projectStore: null,
    openClient: async (source) => {
      sources.push(source);
      return reader;
    },
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  t.after(() => {
    c.stop();
    reader.close();
    if (d) Object.defineProperty(globalThis, "navigator", d);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  return { c, sources };
}
test("A granted remembered folder automatically prepares and boots exactly once", async (t) => {
  const f = folderAccessFixture(),
    { c, sources } = rememberedController(t, f.access);
  await Promise.all([c.boot(), c.boot()]);
  assert.equal(c.getSnapshot().ready, true);
  assert.deepEqual(sources, [f.handle]);
  assert.equal(c.getSnapshot().clientRemembered, true);
  assert.equal(c.getSnapshot().clientFolderName, "World of Warcraft");
  assert.deepEqual(f.calls, ["load", "query-read"]);
  await c.boot();
  assert.equal(sources.length, 1);
});
for (const permission of ["prompt", "denied"] as const)
  test(`A ${permission} folder waits for a click, then reconnects without a folder picker`, async (t) => {
    const f = folderAccessFixture(permission),
      { c, sources } = rememberedController(t, f.access);
    await c.boot();
    assert.equal(sources.length, 0);
    assert.equal(c.getSnapshot().clientReconnect, true);
    assert.deepEqual(f.calls, ["load", "query-read"]);
    f.grant();
    const reconnect = c.reconnectClientFolder();
    assert.equal(f.calls.at(-1), "request-read");
    await reconnect;
    assert.deepEqual(sources, [f.handle]);
    assert.equal(c.getSnapshot().ready, true);
    assert.equal(f.calls.includes("pick"), false);
  });
test("A successful new selection is saved; forgetting it keeps the current client running", async (t) => {
  const f = folderAccessFixture("granted", false),
    { c, sources } = rememberedController(t, f.access);
  await c.boot();
  const selecting = c.chooseClientFolder();
  assert.equal(f.calls.at(-1), "pick");
  await selecting;
  assert.equal(f.saved(), f.handle);
  assert.equal(c.getSnapshot().clientRemembered, true);
  assert.deepEqual(sources, [f.handle]);
  await c.forgetClientFolder();
  assert.equal(f.saved(), null);
  assert.equal(c.getSnapshot().clientRemembered, false);
  assert.equal(c.getSnapshot().ready, true);
});
test("A late restore cannot replace a manual folder upload", async (t) => {
  const f = folderAccessFixture();
  let release!: (v: any) => void, started!: () => void;
  const loading = new Promise<void>((r) => (started = r));
  f.access.load = () => {
    started();
    return new Promise((r) => (release = r));
  };
  const { c, sources } = rememberedController(t, f.access);
  const boot = c.boot();
  await loading;
  await c.openClient([]);
  release(f.handle);
  await boot;
  assert.deepEqual(sources, [[]]);
  assert.equal(c.getSnapshot().clientRemembered, false);
  assert.equal(f.saved(), null);
});
test("Stopping while the saved folder is loading prevents automatic reopening", async (t) => {
  const f = folderAccessFixture();
  let release!: (v: any) => void, started!: () => void;
  const loading = new Promise<void>((r) => (started = r));
  f.access.load = () => {
    started();
    return new Promise((r) => (release = r));
  };
  const { c, sources } = rememberedController(t, f.access);
  const boot = c.boot();
  await loading;
  c.stop();
  release(f.handle);
  await boot;
  assert.equal(sources.length, 0);
  assert.equal(c.getSnapshot().ready, false);
});
test("Cancel during a reconnect permission prompt does not reopen the folder later", async (t) => {
  const f = folderAccessFixture("prompt"),
    { c, sources } = rememberedController(t, f.access);
  await c.boot();
  let release!: (p: PermissionState) => void;
  f.access.permission = () => new Promise((r) => (release = r));
  const reconnect = c.reconnectClientFolder();
  c.cancelClient();
  release("granted");
  await reconnect;
  assert.equal(sources.length, 0);
  assert.equal(c.getSnapshot().clientStatus, "select");
});
test("A moved saved folder fails once and stays selectable instead of looping", async (t) => {
  const f = folderAccessFixture();
  const c = new EditorController(undefined, {
    browserAssets: true,
    clientFolders: f.access,
    projectStore: null,
    openClient: async () => {
      throw new DOMException("Folder moved", "NotFoundError");
    },
  });
  t.after(() => c.stop());
  await c.boot();
  assert.equal(c.getSnapshot().clientStatus, "error");
  assert.equal(c.getSnapshot().clientReconnect, true);
  assert.match(c.getSnapshot().error!, /Folder moved/);
  await c.boot();
  assert.deepEqual(f.calls, ["load", "query-read"]);
});
test("Folder persistence failure does not prevent the selected client from booting", async (t) => {
  const f = folderAccessFixture("granted", false);
  f.access.save = async () => {
    throw new Error("IndexedDB unavailable");
  };
  const { c } = rememberedController(t, f.access);
  await c.chooseClientFolder();
  assert.equal(c.getSnapshot().ready, true);
  assert.equal(c.getSnapshot().clientRemembered, false);
  assert.match(c.getSnapshot().notice ?? "", /could not save/);
  assert.equal(c.getSnapshot().clientFolderError, "IndexedDB unavailable");
});
test("Forgetting during preparation does not re-save the folder at the end", async (t) => {
  const f = folderAccessFixture("granted", false);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (started = r));
  const { c } = rememberedController(t, f.access);
  const savedOpen = (c as any).runtime.openClient;
  (c as any).runtime.openClient = async (...args: any[]) => {
    started();
    await new Promise<void>((r) => (release = r));
    return savedOpen(...args);
  };
  const selecting = c.chooseClientFolder();
  await waiting;
  await c.forgetClientFolder();
  release();
  await selecting;
  assert.equal(c.getSnapshot().ready, true);
  assert.equal(f.saved(), null);
  assert.equal(f.calls.includes("save"), false);
});

for (const phase of ["initializeLibrary", "initializeWcl"] as const)
  test(`Stopping during ${phase} does not begin saved-folder restoration`, async (t) => {
    const f = folderAccessFixture(),
      { c, sources } = rememberedController(t, f.access);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    (c as any)[phase] = async () => {
      started();
      await new Promise<void>((r) => (release = r));
    };
    const boot = c.boot();
    await waiting;
    c.stop();
    release();
    await boot;
    assert.equal(sources.length, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(c.getSnapshot().ready, false);
  });

function cachedController(
  t: any,
  cache: import("./client-cache").ClientAssetCache,
  rendererLab = false,
) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: {} },
  });
  const fixture = readerFixture(),
    { engine } = engineFixture();
  fixture.reader.build.buildKey = "a".repeat(32);
  fixture.reader.map = async (map) => ({
    map,
    bounds: [0, 0, 1, 1],
    areas: [],
    tiles: [],
    floors: [],
  });
  let opens = 0;
  const c = new EditorController(undefined, {
    rendererLab,
    browserAssets: true,
    clientFolders: null,
    clientCache: cache,
    projectStore: null,
    openClient: async () => {
      opens++;
      return fixture.reader;
    },
    loadNpcIndex: async () => ({
      schema: 1,
      provider: "Wowhead",
      versions: {},
    }),
    loadEngine: async () => engine,
  });
  t.after(() => {
    c.stop();
    (c as any).clientReader?.close();
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  return { c, fixture, opens: () => opens };
}
function waitingForFiles(c: EditorController) {
  return new Promise<void>((resolve, reject) => {
    if (c.getSnapshot().clientNeedsFiles) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      release();
      reject(new Error("Expected request for uncached client assets"));
    }, 2000);
    const release = c.subscribe(() => {
      if (c.getSnapshot().clientNeedsFiles) {
        clearTimeout(timer);
        release();
        resolve();
      }
    });
  });
}
test("The original startup reopens from committed prepared assets without selecting any installation", async (t) => {
  const factory = new IDBFactory(),
    cache = new IndexedClientAssetCache(factory, "converter-a");
  t.after(() => cache.close());
  const first = cachedController(t, cache);
  await first.c.openClient([]);
  assert.equal(first.c.getSnapshot().ready, true);
  assert.equal(first.c.getSnapshot().clientCacheStatus, "ready");
  first.c.stop();
  (first.c as any).clientReader.close();
  (globalThis as any).__pullfiction_local_files.close();
  Reflect.deleteProperty(globalThis, "__pullfiction_local_files");
  const second = cachedController(t, cache);
  await second.c.boot();
  assert.equal(second.c.getSnapshot().ready, true);
  assert.equal(second.c.getSnapshot().clientNeedsFiles, false);
  assert.equal(second.c.getSnapshot().clientCacheStatus, "ready");
  assert.equal(second.opens(), 0);
  assert.equal(second.fixture.calls.length, 0);
  await assert.rejects(
    (second.c as any).browserBridge.read("__classic/186939_s.blp"),
    { name: "NotFoundError" },
  );
  assert.equal(second.c.getSnapshot().clientNeedsFiles, false);
  second.c.receive("scene", "ready");
  assert.equal(second.c.getSnapshot().sceneReady, true);
  assert.deepEqual(
    [
      ...(globalThis as any).__pullfiction_local_files.readSync(
        "Fonts/FRIZQT__.TTF",
      ),
    ],
    [1, 2],
  );
  const prompt = waitingForFiles(second.c);
  const requested = (second.c as any).browserBridge.read(
    "interface/icons/new-asset.blp",
  );
  await prompt;
  assert.equal(second.c.getSnapshot().ready, true);
  const reconnectMarkup = renderToString(
    createElement(App, { controller: second.c }),
  );
  assert.match(reconnectMarkup, /Game assets unavailable/);
  assert.doesNotMatch(reconnectMarkup, /webkitdirectory|Choose client folder/);
  const libraryMarkup = renderToString(
    createElement(Library, {
      state: second.c.getSnapshot(),
      controller: second.c,
      initialTab: "projects",
      share: () => {},
      close: () => {},
    }),
  );
  assert.match(libraryMarkup, /Game assets unavailable/);
  assert.doesNotMatch(libraryMarkup, /webkitdirectory|Choose client folder/);
  second.c.dismissClientSource();
  assert.equal(second.c.getSnapshot().clientNeedsFiles, true);
  assert.equal(second.c.getSnapshot().clientPromptHidden, true);
  const deferredMarkup = renderToString(
    createElement(App, { controller: second.c }),
  );
  assert.match(deferredMarkup, /Load game assets/);
  assert.doesNotMatch(deferredMarkup, /aria-label="Local game client"/);
  second.c.showClientSource();
  assert.equal(second.c.getSnapshot().clientPromptHidden, false);
  await second.c.openClient([]);
  assert.deepEqual([...(await requested)], [1, 2]);
  assert.equal(second.c.getSnapshot().clientNeedsFiles, false);
  assert.equal(second.opens(), 1);
});
test("Stopping while the prepared manifest loads prevents a later cached client from booting", async (t) => {
  const actual = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  t.after(() => actual.close());
  const f = readerFixture();
  f.reader.build.buildKey = "a".repeat(32);
  const saved = await actual.wrap(f.reader, () => {});
  let release!: (value: any) => void, started!: () => void;
  const pending = new Promise<void>((r) => (started = r));
  const controlled = {
    restore: async () => {
      started();
      return new Promise<any>((r) => (release = r));
    },
    wrap: actual.wrap.bind(actual),
    forget: actual.forget.bind(actual),
  };
  const { c, opens } = cachedController(t, controlled);
  const boot = c.boot();
  await pending;
  c.stop();
  release(saved);
  await boot;
  assert.equal(c.getSnapshot().ready, false);
  assert.equal(opens(), 0);
  assert.ok(f.calls.includes("close"));
});

test("Cancelling an uncached startup during source attachment leaves the ordinary picker usable", async (t) => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  t.after(() => cache.close());
  const metadata = readerFixture();
  metadata.reader.build.buildKey = "a".repeat(32);
  const saved = await cache.wrap(metadata.reader, () => {});
  await saved.activate();
  saved.close(); // Active metadata with evicted/missing startup resources.
  const { c, fixture } = cachedController(t, cache);
  let release!: (reader: ClientReader) => void;
  const selected = new Promise<ClientReader>((r) => (release = r));
  (c as any).runtime.openClient = async () => selected;
  const prompt = waitingForFiles(c),
    boot = c.boot();
  await prompt;
  const attachment = c.openClient([]);
  assert.equal(c.getSnapshot().clientAttaching, true);
  c.cancelClient();
  release(fixture.reader);
  await Promise.all([boot, attachment]);
  assert.equal(c.getSnapshot().ready, false);
  assert.equal(c.getSnapshot().clientStatus, "select");
  assert.equal(c.getSnapshot().clientAttaching, false);
  assert.equal(c.getSnapshot().clientNeedsFiles, false);
  assert.ok(fixture.calls.includes("close"));
  assert.doesNotMatch(
    renderToString(createElement(App, { controller: c })),
    /aria-label="World of Warcraft client folder"[^>]*disabled/,
  );
});

test("Renderer workbench reconnects its source before any uncached request", async (t) => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  t.after(() => cache.close());
  const first = cachedController(t, cache, true);
  await first.c.openClient([]);
  first.c.stop();
  (globalThis as any).__pullfiction_local_files.close();
  Reflect.deleteProperty(globalThis, "__pullfiction_local_files");
  const second = cachedController(t, cache, true);
  await second.c.boot();
  assert.equal(second.c.getSnapshot().ready, true);
  assert.equal(second.c.getSnapshot().clientNeedsFiles, false);
  assert.equal(second.c.rendererLabResources().needsSource, true);
  second.c.rendererLabConnectSource();
  await second.c.openClient([]);
  assert.equal(second.opens(), 1);
  assert.equal(second.c.rendererLabResources().needsSource, false);
  assert.equal(second.c.getSnapshot().clientNeedsFiles, false);
  await second.c
    .rendererLabResources()
    .bridge!.read("interface/icons/uncached-probe.blp");
  assert.ok(
    second.fixture.calls.includes("read:interface/icons/uncached-probe.blp"),
  );
});

test("Client prefetch starts only after scene readiness and aborts when the cache is cleared", async (t) => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  t.after(() => cache.close());
  const { c } = cachedController(t, cache);
  await c.openClient([]);
  const client = (c as any).preparedClient;
  let options: Parameters<typeof client.prefetch>[0] | undefined;
  let starts = 0;
  client.prefetch = async (value: any) => {
    options = value;
    starts++;
  };
  assert.equal(starts, 0);
  c.receive("scene", "ready");
  assert.equal(starts, 1);
  assert.ok((options as any).raids.length >= 8);
  assert.equal((options as any).ready(), true);
  (c as any).patch({ sceneReady: false });
  assert.equal((options as any).ready(), false);
  c.receive("scene", "ready");
  assert.equal(starts, 1);
  await c.clearClientCache();
  assert.equal((options as any).signal.aborted, true);
});

test("Hosted startup downloads automatically and exposes no local-client import", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const c = new EditorController(undefined, { browserAssets: true });
  try {
    await c.boot();
    assert.ok(
      requests.some(
        (url) => url === "https://assets.pullfiction.com/manifest.json",
      ),
    );
    assert.equal(c.getSnapshot().clientStatus, "error");
    const markup = renderToString(createElement(App, { controller: c }));
    assert.match(markup, /Retry download/);
    assert.doesNotMatch(
      markup,
      /webkitdirectory|Choose client folder|Remember a client folder/,
    );
    await assert.rejects(
      c.openClient([{} as File]),
      /supplied by Pull Fiction/,
    );
  } finally {
    c.stop();
    globalThis.fetch = originalFetch;
  }
});
