import test from "node:test";
import assert from "node:assert/strict";
import { assetDependencies, catalogAssets } from "./client-prefetch";

function chunk(tag: string, bytes: Uint8Array) {
  const out = new Uint8Array(8 + bytes.length);
  out.set(new TextEncoder().encode(tag.split("").reverse().join("")));
  new DataView(out.buffer).setUint32(4, bytes.length, true);
  out.set(bytes, 8);
  return out.buffer;
}
test("Converted world dependencies include terrain cells and adjacent WMO names", () => {
  const main = new Uint8Array(64 * 64 * 8);
  new DataView(main.buffer).setUint32((3 * 64 + 2) * 8, 1, true);
  assert.deepEqual(
    assetDependencies(
      { method: "world", args: ["world/maps/raid/raid.wdt"] },
      { bytes: chunk("MAIN", main) },
    ),
    [{ method: "world", args: ["world/maps/raid/raid_2_3.adt"] }],
  );
  const names = new TextEncoder().encode(
    "__classic/12.wmo\0__classic/13.m2\0__classic/14.blp\0",
  );
  assert.deepEqual(
    assetDependencies(
      { method: "world", args: ["raid.adt"] },
      { bytes: chunk("MWMO", names) },
    ),
    [
      { method: "world", args: ["__classic/12.wmo"] },
      { method: "model", args: ["id:13"] },
      { method: "read", args: ["id:14"] },
    ],
  );
});
test("WMO groups and model textures use the same keys as foreground reads", () => {
  const header = new Uint8Array(64);
  new DataView(header.buffer).setUint32(4, 2, true);
  assert.deepEqual(
    assetDependencies(
      { method: "world", args: ["__classic/12.wmo"] },
      { bytes: chunk("MOHD", header) },
    ),
    [
      { method: "world", args: ["__classic/12_000.wmo"] },
      { method: "world", args: ["__classic/12_001.wmo"] },
    ],
  );
  assert.deepEqual(
    assetDependencies(
      { method: "model", args: ["id:13"] },
      { bytes: new TextEncoder().encode("\0__classic/14.blp\0").buffer },
    ),
    [{ method: "read", args: ["id:14"] }],
  );
});
test("Catalog inventory distinguishes model file IDs from textures and record IDs", () => {
  assert.deepEqual(
    catalogAssets("items", {
      items: { 999: { iconFile: 4 } },
      displays: {
        88: {
          models: [[{ file: 5 }]],
          textures: [[{ file: 6 }]],
          regions: { 1: [{ file: 7 }] },
        },
      },
    }),
    [
      { method: "read", args: ["id:4"] },
      { method: "model", args: ["id:5"] },
      { method: "read", args: ["id:6"] },
      { method: "read", args: ["id:7"] },
    ],
  );
});

test("Named character models, skyboxes and talent tree icons are included", () => {
  assert.deepEqual(
    catalogAssets("creatures", {
      models: {
        1: { fileDataID: 2, pathAlias: "Character/Human/HumanMale.m2" },
      },
    }),
    [
      { method: "model", args: ["id:2"] },
      { method: "model", args: ["character/human/humanmale.m2"] },
    ],
  );
  assert.deepEqual(
    catalogAssets("lighting", {
      skyboxes: [{ path: "Environments/Stars/Sky.m2" }],
    }),
    [{ method: "model", args: ["environments/stars/sky.m2"] }],
  );
  assert.deepEqual(
    catalogAssets("talents", { trees: [{ icon: "id:135810" }, { icon: "" }] }),
    [{ method: "read", args: ["id:135810"] }],
  );
});
