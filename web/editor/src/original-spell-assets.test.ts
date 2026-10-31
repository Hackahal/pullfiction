import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserAssetBridge } from "./browser-assets";
import { LocalClientFiles } from "./local-client-files";
import {
  prepareOriginalSpellEffects,
  preparedModelDependencies,
  preparedWmoDependencies,
} from "./original-spell-assets";

function model(texture: string, child?: string) {
  const bytes = new Uint8Array(1024),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("MD20"));
  view.setUint32(4, 256, true);
  let cursor = 0x144;
  const name = (field: number, text: string) => {
    const value = new TextEncoder().encode(text + "\0");
    view.setUint32(field, value.length, true);
    view.setUint32(field + 4, cursor, true);
    bytes.set(value, cursor);
    cursor += value.length;
  };
  view.setUint32(0x5c, 1, true);
  view.setUint32(0x60, cursor, true);
  const textureRecord = cursor;
  cursor += 16;
  name(textureRecord + 8, texture);
  if (child) {
    view.setUint32(0x13c, 1, true);
    view.setUint32(0x140, cursor, true);
    const particle = cursor;
    cursor += 504;
    name(particle + 24, child);
  }
  return bytes.subarray(0, cursor);
}

function wmoChunk(tag: string, payload: Uint8Array) {
  const result = new Uint8Array(payload.length + 8);
  result.set(new TextEncoder().encode(tag.split("").reverse().join("")));
  new DataView(result.buffer).setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}
function wmoRoot(extra?: Uint8Array) {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 17, true);
  const header = new Uint8Array(64);
  new DataView(header.buffer).setUint32(4, 1, true);
  const material = new Uint8Array(64);
  const names = new TextEncoder().encode("__classic/10.blp\0\0");
  new DataView(material.buffer).setUint32(24, names.length - 1, true);
  new DataView(material.buffer).setUint32(36, names.length - 1, true);
  const chunks = [
    wmoChunk("MVER", version),
    wmoChunk("MOHD", header),
    wmoChunk("MOMT", material),
    wmoChunk("MOTX", names),
    wmoChunk("GFID", new Uint8Array(16)),
    ...(extra ? [extra] : []),
  ];
  const bytes = new Uint8Array(
    chunks.reduce((n, value) => n + value.length, 0),
  );
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

test("source-classified WMO spell preparation follows required base groups and textures without M2 conversion", async () => {
  const reads: string[] = [];
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 17, true);
  const group = new Uint8Array(12 + 8 + 68);
  group.set(wmoChunk("MVER", version));
  group.set(wmoChunk("MOGP", new Uint8Array(68)), 12);
  const bytes: Record<string, Uint8Array> = {
    "__classic/100.wmo": wmoRoot(),
    "__classic/100_000.wmo": group,
    "__classic/10.blp": new Uint8Array([1]),
  };
  const files = new LocalClientFiles(
    {
      async read(path) {
        reads.push(path);
        assert.ok(bytes[path], path);
        return bytes[path];
      },
    },
    "wmo-spell",
  );
  const bridge = {
    async catalog() {
      return {
        spells: { 7: { visuals: [{ id: 1 }] } },
        visuals: { 1: { missiles: [{ effect: 1 }], events: [] } },
        effects: { 1: { type: 0, fileDataID: 100, assetFormat: "wmo" } },
      };
    },
  } as unknown as BrowserAssetBridge;
  await prepareOriginalSpellEffects(files, bridge, [7]);
  assert.deepEqual(reads, [
    "__classic/100.wmo",
    "__classic/100_000.wmo",
    "__classic/10.blp",
  ]);
  assert.throws(
    () => files.containsSync("__classic/100_001.wmo"),
    /needs preparation/,
  );
});

test("WMO preparation rejects malformed ranges and unimplemented child contexts; unknown model format is not assumed M2", async () => {
  const malformed = wmoRoot();
  new DataView(malformed.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(
    () => preparedWmoDependencies(malformed, "x.wmo"),
    /chunk range/,
  );
  assert.throws(
    () =>
      preparedWmoDependencies(
        wmoRoot(wmoChunk("MODD", new Uint8Array(40))),
        "x.wmo",
      ),
    /owning world context/,
  );
  const files = new LocalClientFiles(
    {
      async read() {
        throw new Error("unclassified asset must not be read as M2");
      },
    },
    "unknown-spell",
  );
  const bridge = {
    async catalog() {
      return {
        spells: { 7: { visuals: [{ id: 1 }] } },
        visuals: { 1: { missiles: [{ effect: 1 }], events: [] } },
        effects: { 1: { type: 0, fileDataID: 100, assetFormat: "unknown" } },
      };
    },
  } as unknown as BrowserAssetBridge;
  await assert.rejects(
    prepareOriginalSpellEffects(files, bridge, [7]),
    /model format is unavailable/,
  );
});

test("selected spell preparation follows explicit cue and recursive model dependencies once", async () => {
  const reads: string[] = [];
  const models: Record<string, Uint8Array> = {
    "__classic/100.m2": model("__classic/10.blp", "__classic/400.m2"),
    "__classic/200.m2": model("__classic/20.blp"),
    "__classic/300.m2": model("__classic/30.blp"),
    "__classic/400.m2": model("__classic/40.blp", "__classic/100.m2"),
  };
  const files = new LocalClientFiles(
    {
      async read(name) {
        reads.push(name);
        return models[name] ?? new Uint8Array([1, 2, 3]);
      },
    },
    "spell-dependencies",
  );
  const graph = {
    spells: {
      7: {
        visuals: [{ id: 1 }],
        summonCue: {
          displayID: 9,
          visualSpellID: 8,
          presentation: "illustrative",
        },
      },
      8: { visuals: [{ id: 2 }] },
      99: { visuals: [{ id: 99 }] },
    },
    visuals: {
      1: { events: [{ kit: 1 }], missiles: [{ effect: 1 }] },
      2: { events: [{ kit: 2 }] },
      99: { missiles: [{ effect: 99 }] },
    },
    effects: {
      1: { type: 0, fileDataID: 100 },
      2: { type: 0, fileDataID: 200 },
      99: { type: 0, fileDataID: 999 },
    },
    kits: {
      1: {
        effects: [{ effect: 1 }],
        proceduralEffects: [{ type: 0, values: [8, 1, 1, 0] }],
      },
      2: { effects: [{ effect: 2 }] },
    },
    chainEffects: {
      8: { rendererCompatible: true, textureFileDataIDs: [50, 0, 0] },
    },
  };
  const bridge = {
    async catalog(kind: string) {
      return kind === "spells"
        ? graph
        : kind === "creatures"
          ? {
              displays: { 9: { modelID: 3, textures: [60] } },
              models: { 3: { fileDataID: 300 } },
            }
          : {};
    },
  } as unknown as BrowserAssetBridge;
  await prepareOriginalSpellEffects(files, bridge, [7, 7]);
  assert.deepEqual(
    new Set(reads),
    new Set([
      "__classic/100.m2",
      "__classic/200.m2",
      "__classic/300.m2",
      "__classic/400.m2",
      "__classic/10.blp",
      "__classic/20.blp",
      "__classic/30.blp",
      "__classic/40.blp",
      "__classic/50.blp",
      "__classic/60.blp",
    ]),
  );
  assert.equal(
    reads.length,
    new Set(reads).size,
    "cycles and repeated effects do not repeat reads",
  );
  assert.throws(
    () => files.containsSync("__classic/999.m2"),
    /needs preparation/,
  );
  const before = reads.length;
  await prepareOriginalSpellEffects(files, bridge, [7]);
  assert.equal(
    reads.length,
    before,
    "a warmed preparation reuses the actual byte cache",
  );
});

test("model dependencies reject truncated arrays and names", () => {
  assert.throws(
    () => preparedModelDependencies(new Uint8Array(20)),
    /adapted MD20/,
  );
  const badArray = model("__classic/10.blp");
  new DataView(badArray.buffer).setUint32(0x5c, 0xffffffff, true);
  assert.throws(() => preparedModelDependencies(badArray), /dependency array/);
  const badName = model("__classic/10.blp");
  new DataView(badName.buffer).setUint32(0x144 + 8, 2000, true);
  assert.throws(() => preparedModelDependencies(badName), /dependency name/);
});

test("preparation cancellation stops before reading dependencies", async () => {
  const controller = new AbortController();
  controller.abort();
  const files = new LocalClientFiles(
    {
      async read() {
        throw new Error("unexpected read");
      },
    },
    "cancelled",
  );
  const bridge = {
    async catalog() {
      return {};
    },
  } as unknown as BrowserAssetBridge;
  await assert.rejects(
    prepareOriginalSpellEffects(files, bridge, [7], controller.signal),
    { name: "AbortError" },
  );
});
