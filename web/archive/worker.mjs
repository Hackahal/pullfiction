import createCasc from "./casc.mjs";
import {
  archivePath,
  isStorageFile,
  resourceName,
  cacheIdentity,
} from "./policy.mjs";
import { assetCache, cachedAsset } from "./cache.mjs";
import { modernConverter } from "./converter.mjs";
import { CONVERTER_REVISION } from "./revision.mjs";

let casc;
let mounted = false;
let queue = Promise.resolve();
let converter;
let cache;
let build;
let activeId;
let codec;

function readBytes(resource, offset, length) {
  if (!casc || !mounted) throw new Error("Select a client first");
  const key = resourceName(resource);
  const pointer = casc.ccall(
    offset === undefined ? "pf_read" : "pf_read_range",
    "number",
    offset === undefined
      ? ["string", "number"]
      : ["string", "number", "number", "number"],
    offset === undefined
      ? [key.name, key.fileId]
      : [key.name, key.fileId, offset, length],
  );
  if (!pointer) {
    const code = casc._pf_error();
    const error = new Error(
      `Client resource unavailable: ${key.key} (${code})`,
    );
    // Missing names differ from offline/corrupt archive data and remain so at the reader seam.
    if (casc._pf_error_is_missing()) error.name = "NotFoundError";
    if (casc._pf_error_is_encrypted()) error.name = "EncryptedSectionError";
    throw error;
  }
  return casc.HEAPU8.slice(pointer, pointer + casc._pf_size());
}

function readRange(resource, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > 128 * 1024 * 1024
  )
    throw new Error("Invalid client range");
  try {
    return readBytes(resource, offset, length);
  } catch (error) {
    if (error.name === "EncryptedSectionError") return false;
    throw error;
  }
}

async function handle({
  id,
  type,
  files,
  resource,
  source,
  kind,
  appearance,
  mapId,
  directory,
  table,
}) {
  activeId = id;
  if (type === "open") {
    // Validate the worker boundary as well as the page's metadata parser.
    cacheIdentity(source, CONVERTER_REVISION);
    if (!Array.isArray(files) || files.length < 2 || files.length > 20000)
      throw new Error("Invalid client storage selection");
    const names = new Set();
    const blobs = files.map(({ name, file }) => {
      archivePath(name);
      if (
        !isStorageFile(name) ||
        names.has(name.toLowerCase()) ||
        !(file instanceof Blob)
      )
        throw new Error("Invalid or duplicate client storage file");
      names.add(name.toLowerCase());
      return { name, data: file };
    });
    if (!names.has(".build.info"))
      throw new Error("Client selection is missing .build.info");
    casc ??= await createCasc({
      onProgress: (value) =>
        postMessage({ id: activeId, type: "progress", value }),
    });
    casc._pf_close();
    if (mounted) casc.FS.unmount("/client");
    else if (!casc.FS.analyzePath("/client").exists) casc.FS.mkdir("/client");
    casc.FS.mount(casc.WORKERFS, { blobs }, "/client");
    mounted = true;
    const started = performance.now();
    if (
      !casc.ccall(
        "pf_open",
        "number",
        ["string", "string"],
        ["/client", source.product],
      )
    )
      throw new Error(
        `Cannot open local ${source.product} storage (${casc._pf_error()}). Finish downloading the client and select its root folder`,
      );
    build = source;
    converter = undefined;
    try {
      cache = await assetCache(build, CONVERTER_REVISION);
    } catch {
      cache = null;
    }
    return {
      openMs: performance.now() - started,
      wasmMemoryBytes: casc.HEAPU8.buffer.byteLength,
    };
  }
  if (type === "table") {
    if (!build || !mounted) throw new Error("Select a client first");
    converter ??= await modernConverter(
      readBytes,
      (value) => postMessage({ id: activeId, type: "progress", value }),
      readRange,
    );
    // Section coverage is deliberately uncached. Missing records are retried on
    // the next request, including when local key availability changes.
    return converter.table(table);
  }
  if (type === "read") {
    const started = performance.now();
    const bytes = readBytes(resource);
    postMessage(
      {
        id,
        type: "result",
        value: {
          bytes: bytes.buffer,
          readMs: performance.now() - started,
          wasmMemoryBytes: casc.HEAPU8.buffer.byteLength,
        },
      },
      [bytes.buffer],
    );
    return undefined;
  }
  if (type === "model" || type === "world") {
    resourceName(resource);
    if (type === "world" && !/\.(?:wdt|adt|wmo)$/i.test(resource))
      throw new Error("Expected a world geometry resource");
    const started = performance.now();
    const { bytes, cached } = await cachedAsset(cache, resource, async () => {
      converter ??= await modernConverter(
        readBytes,
        (value) => postMessage({ id: activeId, type: "progress", value }),
        readRange,
      );
      return converter[type](resource);
    });
    postMessage(
      {
        id,
        type: "result",
        value: {
          bytes: bytes.buffer,
          cached,
          prepareMs: performance.now() - started,
        },
      },
      [bytes.buffer],
    );
    return undefined;
  }
  if (type === "map") {
    if (!build || !mounted) throw new Error("Select a client first");
    converter ??= await modernConverter(
      readBytes,
      (value) => postMessage({ id: activeId, type: "progress", value }),
      readRange,
    );
    return converter.map(mapId, directory);
  }
  if (type === "catalog") {
    if (!build) throw new Error("Select a client first");
    converter ??= await modernConverter(
      readBytes,
      (value) => postMessage({ id: activeId, type: "progress", value }),
      readRange,
    );
    return converter.catalog(kind, build);
  }
  if (type === "appearance") {
    if (!build || !mounted) throw new Error("Select a client first");
    converter ??= await modernConverter(
      readBytes,
      (value) => postMessage({ id: activeId, type: "progress", value }),
      readRange,
    );
    const recipe = converter.appearance(appearance, build);
    if (!codec) {
      codec = await import("./pullfiction_asset_codec.js");
      await codec.default();
    }
    const textures = [],
      transfers = [],
      decoded = new Map();
    try {
      for (const target of recipe.textures) {
        let atlas;
        try {
          for (const layer of target.layers) {
            let source = decoded.get(layer.file);
            if (!source) {
              source = codec.decode_texture(readBytes(`id:${layer.file}`));
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
          const pixels = output.pixels();
          textures.push({
            type: target.type,
            width: output.width,
            height: output.height,
            pixels: pixels.buffer,
          });
          transfers.push(pixels.buffer);
        } finally {
          atlas?.free();
        }
      }
      postMessage(
        { id, type: "result", value: { recipe, textures } },
        transfers,
      );
      return undefined;
    } finally {
      for (const texture of decoded.values()) texture.free();
    }
  }
  if (type === "close") {
    casc?._pf_close();
    if (mounted) casc.FS.unmount("/client");
    mounted = false;
    return null;
  }
  throw new Error("Unknown archive operation");
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const value = await handle(data);
      if (value !== undefined)
        postMessage({ id: data.id, type: "result", value });
    } catch (error) {
      postMessage({
        id: data.id,
        type: "error",
        errorName: error instanceof Error ? error.name : "Error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
