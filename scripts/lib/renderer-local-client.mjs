// Filesystem transport for the development renderer. No game process or network access.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareClientFiles } from "../../web/archive/client.mjs";
import { isStorageFile } from "../../web/archive/policy.mjs";

export class LocalClientBlob extends Blob {
  constructor(file, start = 0, end = fs.statSync(file).size) {
    super([]);
    this.file = file;
    this.start = start;
    this.end = end;
  }
  get size() {
    return this.end - this.start;
  }
  bytesSync() {
    const bytes = Buffer.alloc(this.size),
      fd = fs.openSync(this.file, "r");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const n = fs.readSync(
          fd,
          bytes,
          offset,
          bytes.length - offset,
          this.start + offset,
        );
        if (!n) throw new Error(`Short local client read: ${this.file}`);
        offset += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    return bytes;
  }
  slice(start = 0, end = this.size) {
    const bound = (n) => {
      n = Number.isNaN(Number(n)) ? 0 : Math.trunc(Number(n));
      return Math.min(Math.max(n < 0 ? this.size + n : n, 0), this.size);
    };
    start = bound(start);
    end = Math.max(start, bound(end));
    return new LocalClientBlob(this.file, this.start + start, this.start + end);
  }
  async text() {
    return this.bytesSync().toString("utf8");
  }
  async arrayBuffer() {
    const b = this.bytesSync();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

class MemoryClientBlob extends Blob {
  constructor(bytes) {
    super([bytes]);
    this.bytes = Buffer.from(bytes);
  }
  bytesSync() {
    return this.bytes;
  }
  slice(start = 0, end = this.size) {
    const bound = (n) =>
      Math.min(Math.max(n < 0 ? this.size + n : n, 0), this.size);
    start = bound(start);
    end = Math.max(start, bound(end));
    return new MemoryClientBlob(this.bytes.subarray(start, end));
  }
}

export async function openLocalClient(
  install,
  archive,
  product = "wow_classic_era",
) {
  install = path.resolve(install);
  archive = fs.realpathSync(archive);
  const files = [
    {
      name: ".build.info",
      file: new LocalClientBlob(path.join(install, ".build.info")),
    },
  ];
  const visit = (name) => {
    for (const entry of fs.readdirSync(path.join(install, name), {
      withFileTypes: true,
    })) {
      const child = `${name}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (isStorageFile(child))
        files.push({
          name: child,
          file: new LocalClientBlob(path.join(install, child)),
        });
    }
  };
  visit("Data/config");
  visit("Data/data");
  const prepared = await prepareClientFiles(
    files,
    () => {},
    undefined,
    product,
  );
  // Emscripten WORKERFS reads Blob slices synchronously. Keep those reads on disk
  // rather than copying multi-gigabyte CASC archives into a browser or JS heap.
  globalThis.WorkerGlobalScope = class {};
  globalThis.FileReaderSync = class {
    readAsArrayBuffer(blob) {
      const b = blob.bytesSync();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
  };
  globalThis.self = globalThis;
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.protocol !== "file:")
      throw new Error(`Local renderer forbids network fetch: ${url.protocol}`);
    const file = fs.realpathSync(fileURLToPath(url));
    if (!file.startsWith(archive + path.sep))
      throw new Error("Runtime fetch outside the archive tools");
    return new Response(fs.readFileSync(file), {
      headers: {
        "Content-Type": file.endsWith(".wasm")
          ? "application/wasm"
          : "application/octet-stream",
      },
    });
  };
  let sequence = 0;
  const pending = new Map();
  globalThis.postMessage = (data) => {
    if (data.type === "progress") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === "error")
      request.reject(
        Object.assign(new Error(data.error), {
          name: data.errorName ?? "Error",
        }),
      );
    else request.resolve(data.value);
  };
  await import(pathToFileURL(path.join(archive, "worker.mjs")));
  const send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      self.onmessage({ data: { id, type, ...payload } });
    });
  // Product selection may synthesize a tiny .build.info Blob. Give that metadata
  // the same synchronous range interface without copying the storage archives.
  for (const row of prepared.files) {
    if (!(row.file instanceof LocalClientBlob))
      row.file = new MemoryClientBlob(await row.file.arrayBuffer());
  }
  const timing = await send("open", {
    files: prepared.files,
    source: prepared.build,
  });
  return {
    build: prepared.build,
    timing,
    read: (resource) => send("read", { resource }),
    model: (resource) => send("model", { resource }),
    world: (resource) => send("world", { resource }),
    map: (mapId, directory) => send("map", { mapId, directory }),
    catalog: (kind) => send("catalog", { kind }),
    appearance: (appearance) => send("appearance", { appearance }),
    close: () => send("close"),
  };
}
