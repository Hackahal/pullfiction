import type { BrowserAssetBridge } from "./browser-assets";

export interface BodyAppearance {
  race: number;
  sex: number;
  look: readonly number[];
  displays: readonly number[];
}

export function bodyAppearanceResource(value: BodyAppearance): string {
  const numbers = [value.race, value.sex, ...value.look, ...value.displays];
  if (
    value.look.length !== 5 ||
    value.displays.length !== 8 ||
    !numbers.every((v) => Number.isInteger(v) && v >= 0 && v < 0x100000000) ||
    value.race < 1 ||
    value.race > 8 ||
    value.sex > 1 ||
    value.look.some((v) => v > 255)
  )
    throw new Error("Invalid original character appearance");
  return `__classic/appearance/${numbers.join("-")}-body.blp`;
}

export function appearanceRequest(
  resource: string,
): { request: Record<string, unknown>; type: number } | undefined {
  const match =
    /^__classic\/appearance\/([0-9]+(?:-[0-9]+)*)-(body|hair|extra)\.blp$/.exec(
      resource,
    );
  if (!match) {
    if (resource.startsWith("__classic/appearance/"))
      throw new Error("Invalid prepared appearance resource");
    return undefined;
  }
  const numbers = match[1].split("-").map(Number),
    kind = match[2];
  if (
    !numbers.every((v) => Number.isInteger(v) && v >= 0 && v < 0x100000000) ||
    numbers[0] < 1 ||
    numbers[0] > 8 ||
    numbers[1] > 1
  )
    throw new Error("Invalid prepared appearance resource");
  const [race, sex] = numbers;
  if (kind === "body" && numbers.length === 15) {
    const look = numbers.slice(2, 7),
      displays = numbers.slice(7);
    bodyAppearanceResource({ race, sex, look, displays });
    return {
      request: { race, sex, legacyLook: look, bodyDisplays: displays },
      type: 1,
    };
  }
  if (
    kind === "hair" &&
    numbers.length === 4 &&
    numbers.slice(2).every((v) => v <= 255)
  )
    return {
      request: { race, sex, legacyLook: [0, 0, numbers[2], numbers[3], 0] },
      type: 6,
    };
  if (kind === "extra" && numbers.length === 3 && numbers[2] <= 255)
    return {
      request: { race, sex, legacyLook: [numbers[2], 0, 0, 0, 0] },
      type: 8,
    };
  throw new Error("Invalid prepared appearance resource");
}

// BLP2 is the original texture loader's input. Derived atlases stay inside the local cache.
// Preserve straight RGBA and provide the full mip ladder for the original material sampler.
export function encodeAtlasBlp(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    rgba.byteLength !== width * height * 4
  )
    throw new Error("Invalid prepared character atlas");
  const levels = [{ width, height, rgba }];
  while (width > 1 || height > 1) {
    const previous = levels[levels.length - 1],
      nextWidth = Math.max(1, width >> 1),
      nextHeight = Math.max(1, height >> 1);
    const pixels = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y++)
      for (let x = 0; x < nextWidth; x++) {
        for (let channel = 0; channel < 4; channel++) {
          let total = 0,
            count = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const sx = x * 2 + dx,
                sy = y * 2 + dy;
              if (sx < width && sy < height) {
                total += previous.rgba[(sy * width + sx) * 4 + channel];
                count++;
              }
            }
          pixels[(y * nextWidth + x) * 4 + channel] = Math.round(total / count);
        }
      }
    width = nextWidth;
    height = nextHeight;
    levels.push({ width, height, rgba: pixels });
  }
  // BLP2 retains the 256-entry palette block even for raw BGRA, which does not use it.
  const dataOffset = 148 + 256 * 4;
  const output = new Uint8Array(
    dataOffset + levels.reduce((sum, level) => sum + level.rgba.byteLength, 0),
  );
  const header = new DataView(output.buffer);
  output.set([66, 76, 80, 50]);
  header.setUint32(4, 1, true);
  output.set([3, 8, 0, 1], 8);
  header.setUint32(12, levels[0].width, true);
  header.setUint32(16, levels[0].height, true);
  let offset = dataOffset;
  levels.forEach((level, index) => {
    header.setUint32(20 + index * 4, offset, true);
    header.setUint32(84 + index * 4, level.rgba.byteLength, true);
    for (let pixel = 0; pixel < level.rgba.byteLength; pixel += 4) {
      output[offset + pixel] = level.rgba[pixel + 2];
      output[offset + pixel + 1] = level.rgba[pixel + 1];
      output[offset + pixel + 2] = level.rgba[pixel];
      output[offset + pixel + 3] = level.rgba[pixel + 3];
    }
    offset += level.rgba.byteLength;
  });
  return output;
}

export async function readAppearanceAsset(
  bridge: Pick<BrowserAssetBridge, "appearance">,
  resource: string,
): Promise<Uint8Array | undefined> {
  const spec = appearanceRequest(resource);
  if (!spec) return undefined;
  let prepared = await bridge.appearance(spec.request);
  let texture = prepared?.textures?.find((row: any) => row.type === spec.type);
  if (!texture && spec.type === 6) {
    // Match the original CharSections::hair_mesh_texture variation-1 fallback for bald styles.
    const look = [...(spec.request.legacyLook as number[])];
    if (look[2] !== 1) {
      look[2] = 1;
      prepared = await bridge.appearance({ ...spec.request, legacyLook: look });
      texture = prepared?.textures?.find((row: any) => row.type === spec.type);
    }
  }
  if (!texture || !(texture.pixels instanceof ArrayBuffer))
    throw new Error(
      `The selected client did not supply appearance texture type ${spec.type} (${resource})`,
    );
  return encodeAtlasBlp(
    texture.width,
    texture.height,
    new Uint8Array(texture.pixels),
  );
}
