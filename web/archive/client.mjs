import { isStorageFile, clientBuild } from "./policy.mjs";

export async function selectClient(
  onProgress = () => {},
  { signal, product } = {},
) {
  signal?.throwIfAborted();
  if (!globalThis.showDirectoryPicker)
    throw new Error("Use desktop Chrome or Edge to select your WoW folder");
  const directory = await showDirectoryPicker({
    id: "pullfiction-client",
    mode: "read",
  });
  return openDirectory(directory, onProgress, { signal, product });
}

export async function openDirectory(
  directory,
  onProgress = () => {},
  { signal, product } = {},
) {
  signal?.throwIfAborted();
  let metadata;
  try {
    metadata = await (await directory.getFileHandle(".build.info")).getFile();
  } catch {
    throw new Error(
      "Select the World of Warcraft root folder containing .build.info and Data",
    );
  }
  const files = [{ name: ".build.info", file: metadata }];
  // Only visit CASC's index/config/archive directories. Never scan screenshots, logs or executables.
  async function visit(handle, prefix) {
    for await (const [name, entry] of handle.entries()) {
      signal?.throwIfAborted();
      const path = `${prefix}/${name}`;
      if (entry.kind === "directory") {
        if (
          prefix === "Data/config"
            ? /^[a-f0-9]{2}$/i.test(name)
            : /^Data\/config\/[a-f0-9]{2}$/i.test(prefix) &&
              /^[a-f0-9]{2}$/i.test(name)
        )
          await visit(entry, path);
      } else if (isStorageFile(path)) {
        if (files.length >= 20000)
          throw new Error("Client storage contains too many files");
        files.push({ name: path, file: await entry.getFile() });
      }
    }
  }
  const data = await directory.getDirectoryHandle("Data");
  for (const name of ["config", "data"])
    await visit(await data.getDirectoryHandle(name), `Data/${name}`);
  const prepared = await prepareClientFiles(files, onProgress, signal, product);
  return openStorage(
    prepared.files,
    prepared.build,
    onProgress,
    directory,
    signal,
  );
}

// A standard folder input provides read-only File objects without a persistent
// directory grant. Some installations cannot be selected with showDirectoryPicker.
export async function openFiles(
  selection,
  onProgress = () => {},
  { signal, product } = {},
) {
  signal?.throwIfAborted();
  const files = [];
  let root;
  for (const file of selection) {
    signal?.throwIfAborted();
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2)
      throw new Error("Select the complete World of Warcraft folder");
    root ??= parts[0];
    if (parts[0] !== root) throw new Error("Select a single client folder");
    const name = parts.slice(1).join("/");
    if (isStorageFile(name)) {
      if (files.length >= 20000)
        throw new Error("Client storage contains too many files");
      files.push({ name, file });
    }
  }
  const metadata = files.find((entry) => entry.name === ".build.info");
  if (!metadata)
    throw new Error(
      "The selected folder is missing .build.info. Select the World of Warcraft root folder",
    );
  const prepared = await prepareClientFiles(files, onProgress, signal, product);
  return openStorage(
    prepared.files,
    prepared.build,
    onProgress,
    undefined,
    signal,
  );
}

// Battle.net can replace the root product row when adding another WoW product,
// while retaining the Classic build config and archive bytes in shared Data.
// Select that real local build through an in-memory metadata view. Never change
// the installation, guess file contents, or download missing archive data.
export async function prepareClientFiles(
  files,
  onProgress = () => {},
  signal,
  product = "wow_classic_era",
) {
  signal?.throwIfAborted();
  const metadata = files.find((entry) => entry.name === ".build.info");
  if (!metadata) throw new Error("Client selection is missing .build.info");
  const text = await metadata.file.text();
  try {
    return { files, build: clientBuild(text, product) };
  } catch (error) {
    // Retained Classic recovery belongs only to an explicit/default Classic
    // selection. Forever never silently opens a different product's records.
    if (product !== "wow_classic_era") throw error;
    const lines = text
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/);
    const headers = lines[0].split("|").map((s) => s.split("!")[0]);
    const column = (name) => headers.indexOf(name);
    if (
      ["Active", "Product", "Version", "Build Key", "CDN Key"].some(
        (name) => column(name) < 0,
      )
    )
      throw error;
    const rows = lines.slice(1).map((line) => line.split("|"));
    if (
      rows.some(
        (row) =>
          row[column("Active")] === "1" &&
          row[column("Product")] === "wow_classic_era",
      )
    )
      throw error;
    const current = rows.find(
      (row) =>
        row[column("Active")] === "1" && row[column("Product")] === "wowf",
    );
    if (!current || !/^[a-f0-9]{32}$/i.test(current[column("CDN Key")]))
      throw error;
    onProgress({
      stage: "build-selection",
      message: "Looking for retained Classic data",
    });
    const candidates = [];
    for (const entry of files) {
      signal?.throwIfAborted();
      const match =
        /^Data\/config\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{32})$/i.exec(
          entry.name,
        );
      if (
        !match ||
        match[3].slice(0, 4).toLowerCase() !==
          (match[1] + match[2]).toLowerCase() ||
        entry.file.size > 128 * 1024
      )
        continue;
      const config = await entry.file.text();
      const build =
        /^build-name\s*=\s*WOW-(\d+)patch(1\.15\.9)_ClassicRetail\s*$/m.exec(
          config,
        );
      if (
        build &&
        /^root\s*=\s*[a-f0-9]{32}\s*$/im.test(config) &&
        /^encoding\s*=\s*[a-f0-9]{32}\s+[a-f0-9]{32}\s*$/im.test(config)
      )
        candidates.push({
          product: "wow_classic_era",
          version: `${build[2]}.${build[1]}`,
          buildKey: match[3].toLowerCase(),
          number: Number(build[1]),
        });
    }
    signal?.throwIfAborted();
    candidates.sort(
      (a, b) => b.number - a.number || a.buildKey.localeCompare(b.buildKey),
    );
    if (!candidates.length)
      throw new Error(
        "This folder registers WoW Forever, but no supported Classic 1.15.9 build is retained. Select a completed Classic installation.",
      );
    if (
      candidates[1]?.number === candidates[0].number &&
      candidates[1].buildKey !== candidates[0].buildKey
    )
      throw new Error("Retained Classic build selection is ambiguous.");
    const { number: _, ...build } = candidates[0];
    const selected = [...current];
    for (const [name, value] of Object.entries({
      Active: "1",
      Product: build.product,
      Version: build.version,
      "Build Key": build.buildKey,
    }))
      selected[column(name)] = value;
    const file = new Blob([`${lines[0]}\n${selected.join("|")}\n`]);
    onProgress({
      stage: "retained-build",
      message: `Using retained Classic ${build.version} data`,
    });
    return {
      build,
      files: files.map((entry) =>
        entry === metadata ? { name: entry.name, file } : entry,
      ),
    };
  }
}

async function openStorage(files, build, onProgress, directory, signal) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
  });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  function failAll(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  function stop(error = new Error("Client reader was closed")) {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    failAll(error);
  }
  function abort() {
    stop(
      signal.reason ??
        new DOMException("Client preparation cancelled", "AbortError"),
    );
  }
  signal?.addEventListener("abort", abort, { once: true });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") {
      onProgress(data.value);
      return;
    }
    pending.delete(data.id);
    if (data.type === "error") {
      const error = new Error(data.error);
      error.name = data.errorName ?? "Error";
      request.reject(error);
    } else request.resolve(data.value);
  };
  worker.onerror = () =>
    stop(new Error("The client reader stopped unexpectedly"));
  function send(type, payload = {}) {
    if (closed) return Promise.reject(new Error("Client reader is closed"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, type, ...payload });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  try {
    const timing = await send("open", { files, source: build });
    signal?.throwIfAborted();
    return {
      build,
      timing,
      directory,
      read: (resource) => send("read", { resource }),
      model: (resource) => send("model", { resource }),
      world: (resource) => send("world", { resource }),
      map: (mapId, directory) => send("map", { mapId, directory }),
      catalog: (kind) => send("catalog", { kind }),
      table: (table) => send("table", { table }),
      appearance: (appearance) => send("appearance", { appearance }),
      close: () => stop(),
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}
