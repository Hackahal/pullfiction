import test from "node:test";
import assert from "node:assert/strict";
import { assetBridge, type ClientReader } from "./browser-assets";
import {
  originalClientFiles,
  ORIGINAL_UI_FILES,
  ORIGINAL_WORLD_FILES,
  prepareOriginalClient,
} from "./original-client-assets";

test("original startup prepares native UI bytes and modern catalogs without requesting old tables", async () => {
  const calls: string[] = [];
  const reader: ClientReader = {
    build: {
      version: "1.15.9.70576",
      product: "wow_classic_era",
      buildKey: "a".repeat(32),
    },
    async read(name) {
      calls.push(`read:${name}`);
      assert.ok(!/\.dbc$/i.test(name));
      return { bytes: new Uint8Array([0, 255]).buffer };
    },
    async model() {
      throw new Error("No model preparation requested");
    },
    async catalog(kind) {
      calls.push(`catalog:${kind}`);
      return { schema: 1, kind };
    },
    async appearance() {
      throw new Error("No appearance preparation requested");
    },
    close() {},
  };
  const files = originalClientFiles(assetBridge(reader));
  await prepareOriginalClient(files);
  for (const name of ORIGINAL_UI_FILES)
    assert.equal(files.containsSync(name), true);
  for (const [name, kind] of [
    ["spell-effects", "spells"],
    ["item-appearances", "items"],
    ["world-catalog", "world"],
    ["lighting", "lighting"],
    ["creature-catalog", "creatures"],
    ["character-catalog", "characters"],
  ]) {
    assert.deepEqual(
      JSON.parse(
        new TextDecoder().decode(files.readSync(`__classic/${name}.json`)),
      ),
      { schema: 1, kind },
    );
    assert.ok(calls.includes(`catalog:${kind}`));
  }
  for (const name of ORIGINAL_WORLD_FILES)
    assert.equal(files.containsSync(name), true);
  assert.equal(files.containsSync("textures/shadowblob.blp"), true);
  assert.equal(files.containsSync("textures/unitselecttexture.blp"), true);
  assert.equal(
    files.containsSync("interface/spellshadow/spell-shadow-acceptable.blp"),
    true,
  );
  assert.equal(
    calls.length,
    ORIGINAL_UI_FILES.length + ORIGINAL_WORLD_FILES.length + 10,
  );
});

test("An absent optional actor shadow does not prevent startup or become an unresolved preparation request", async () => {
  const reader: ClientReader = {
    build: {
      version: "1.15.9.70576",
      product: "wow_classic_era",
      buildKey: "a".repeat(32),
    },
    read: async (name) => {
      if (name === "textures/shadowblob.blp") {
        const error = new Error("No shadow in this build");
        error.name = "NotFoundError";
        throw error;
      }
      return { bytes: new Uint8Array([1]).buffer };
    },
    model: async () => ({ bytes: new Uint8Array([1]).buffer }),
    catalog: async () => ({ schema: 1 }),
    appearance: async () => ({}),
    close() {},
  };
  const files = originalClientFiles(assetBridge(reader));
  await prepareOriginalClient(files);
  assert.equal(files.containsSync("textures/shadowblob.blp"), false);
  assert.ok(files.containsSync("Fonts/FRIZQT__.TTF"));
});

test("failed required startup catalog prevents ready and can be retried", async () => {
  let fail = true;
  const bridge = assetBridge({
    build: {
      version: "1.15.9.70576",
      product: "wow_classic_era",
      buildKey: "a".repeat(32),
    },
    read: async () => ({ bytes: new Uint8Array([1]).buffer }),
    model: async () => ({ bytes: new Uint8Array([1]).buffer }),
    async catalog(kind) {
      if (fail && kind === "world")
        throw new Error("World DB2 conversion failed");
      return { schema: 1, kind };
    },
    appearance: async () => ({}),
    close() {},
  });
  const files = originalClientFiles(bridge);
  await assert.rejects(
    prepareOriginalClient(files),
    /World DB2 conversion failed/,
  );
  assert.throws(() => files.readSync("__classic/world-catalog.json"), {
    name: "InvalidStateError",
  });
  fail = false;
  await prepareOriginalClient(files);
  assert.equal(files.containsSync("__classic/world-catalog.json"), true);
});
