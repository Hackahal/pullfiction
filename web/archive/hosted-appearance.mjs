import { modernConverter } from "./converter.mjs";

// The Python adapters call read synchronously. Preload their declared table
// closure first, while texture payloads can still be fetched on demand.
export function hostedAppearance(
  read,
  inputs,
  build,
  progress = () => {},
  dependencies = {},
) {
  let converter,
    codec,
    queue = Promise.resolve();
  const resident = new Map();
  const syncRead = (resource) => {
    const key = String(resource).replaceAll("\\", "/").toLowerCase();
    const bytes = resident.get(key);
    if (!bytes) {
      const error = new Error(`Appearance input was not prepared: ${key}`);
      error.name = "NotReadyError";
      throw error;
    }
    return bytes;
  };
  async function prepare(request) {
    if (!converter) {
      for (const key of inputs)
        resident.set(key.slice(5), await read(key.slice(5)));
      converter = await (dependencies.converter ?? modernConverter)(
        syncRead,
        progress,
        (resource, offset, length) =>
          syncRead(resource).slice(offset, offset + length),
      );
    }
    const recipe = converter.appearance(request, build);
    if (!codec) {
      const loaded = await (dependencies.codec
        ? dependencies.codec()
        : import("./pullfiction_asset_codec.js"));
      await loaded.default();
      codec = loaded;
    }
    const textures = [],
      decoded = new Map();
    try {
      for (const target of recipe.textures) {
        let atlas;
        try {
          for (const layer of target.layers) {
            let source = decoded.get(layer.file);
            if (!source) {
              source = codec.decode_texture(await read(`id:${layer.file}`));
              decoded.set(layer.file, source);
            }
            if (target.composite) {
              atlas ??= codec.character_atlas(target.width, target.height);
              atlas.blend(source, ...layer.rect, layer.blend);
            }
          }
          const output = target.composite
            ? atlas
            : decoded.get(target.layers.at(-1).file);
          textures.push({
            type: target.type,
            width: output.width,
            height: output.height,
            pixels: output.pixels().buffer,
          });
        } finally {
          atlas?.free();
        }
      }
      return { recipe, textures };
    } finally {
      for (const texture of decoded.values()) texture.free();
    }
  }
  return (request) => {
    const result = queue.then(() => prepare(request));
    queue = result.catch(() => {});
    return result;
  };
}
