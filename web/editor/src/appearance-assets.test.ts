import test from "node:test";
import assert from "node:assert/strict";
import {
  appearanceRequest,
  bodyAppearanceResource,
  encodeAtlasBlp,
  readAppearanceAsset,
} from "./appearance-assets";

test("original appearance identity retains all five dials and every body display slot", () => {
  const resource = bodyAppearanceResource({
    race: 7,
    sex: 1,
    look: [2, 3, 4, 5, 6],
    displays: [11, 12, 0, 14, 15, 16, 17, 18],
  });
  assert.equal(
    resource,
    "__classic/appearance/7-1-2-3-4-5-6-11-12-0-14-15-16-17-18-body.blp",
  );
  assert.deepEqual(appearanceRequest(resource), {
    type: 1,
    request: {
      race: 7,
      sex: 1,
      legacyLook: [2, 3, 4, 5, 6],
      bodyDisplays: [11, 12, 0, 14, 15, 16, 17, 18],
    },
  });
  assert.deepEqual(appearanceRequest("__classic/appearance/7-1-4-5-hair.blp"), {
    type: 6,
    request: { race: 7, sex: 1, legacyLook: [0, 0, 4, 5, 0] },
  });
  assert.deepEqual(appearanceRequest("__classic/appearance/6-0-2-extra.blp"), {
    type: 8,
    request: { race: 6, sex: 0, legacyLook: [2, 0, 0, 0, 0] },
  });
  assert.equal(appearanceRequest("world/maps/a/a.wdt"), undefined);
  for (const path of [
    "__classic/appearance/7-2-1-extra.blp",
    "__classic/appearance/7-1-256-extra.blp",
    "__classic/appearance/7-1-1-body.blp",
    "__classic/appearance/../other.blp",
  ])
    assert.throws(() => appearanceRequest(path), /Invalid/);
});

test("derived BLP2 keeps full-resolution colors and supplies the original sampler's mip ladder", () => {
  const pixels = new Uint8Array([
    10, 20, 30, 255, 30, 40, 50, 255, 50, 60, 70, 255, 70, 80, 90, 255,
  ]);
  const blp = encodeAtlasBlp(2, 2, pixels),
    view = new DataView(blp.buffer);
  assert.equal(new TextDecoder().decode(blp.slice(0, 4)), "BLP2");
  assert.equal(view.getUint32(12, true), 2);
  assert.equal(view.getUint32(16, true), 2);
  assert.equal(view.getUint32(20, true), 1172);
  assert.equal(view.getUint32(24, true), 1188);
  assert.equal(view.getUint32(84, true), 16);
  assert.equal(view.getUint32(88, true), 4);
  assert.deepEqual([...blp.slice(1172, 1176)], [30, 20, 10, 255]);
  assert.deepEqual([...blp.slice(1188)], [60, 50, 40, 255]);
  assert.deepEqual([...pixels.slice(0, 4)], [10, 20, 30, 255]);
  assert.throws(() => encodeAtlasBlp(2, 2, new Uint8Array(3)), /Invalid/);
});

test("virtual body assets use real prepared pixels without changing the renderer contract", async () => {
  let called: unknown;
  const bytes = await readAppearanceAsset(
    {
      appearance: async (request) => {
        called = request;
        return {
          textures: [
            {
              type: 1,
              width: 1,
              height: 1,
              pixels: new Uint8Array([9, 8, 7, 255]).buffer,
            },
          ],
        };
      },
    },
    bodyAppearanceResource({
      race: 1,
      sex: 0,
      look: [0, 0, 0, 0, 0],
      displays: Array(8).fill(0),
    }),
  );
  assert.deepEqual(called, {
    race: 1,
    sex: 0,
    legacyLook: [0, 0, 0, 0, 0],
    bodyDisplays: Array(8).fill(0),
  });
  assert.deepEqual([...bytes!.slice(1172)], [7, 8, 9, 255]);
  await assert.rejects(
    readAppearanceAsset(
      { appearance: async () => ({ textures: [] }) },
      "__classic/appearance/6-0-1-extra.blp",
    ),
    /did not supply/,
  );
});

test("bald hair assets retain the original variation-1 material fallback without changing the body look", async () => {
  const looks: unknown[] = [];
  const bytes = await readAppearanceAsset(
    {
      appearance: async (request) => {
        const look = request.legacyLook as number[];
        looks.push(look);
        return {
          textures:
            look[2] === 1
              ? [
                  {
                    type: 6,
                    width: 1,
                    height: 1,
                    pixels: new Uint8Array([3, 4, 5, 255]).buffer,
                  },
                ]
              : [],
        };
      },
    },
    "__classic/appearance/1-0-0-2-hair.blp",
  );
  assert.deepEqual(looks, [
    [0, 0, 0, 2, 0],
    [0, 0, 1, 2, 0],
  ]);
  assert.deepEqual([...bytes!.slice(1172)], [5, 4, 3, 255]);
});
