import type { CatalogKind, ClientReader, OpenClient } from "./browser-assets";
import type { LocalMap } from "./local-map";

type Part = { chunk: string; offset: number; length: number };
export interface HostedManifest {
  schema: 1;
  revision: string;
  build: ClientReader["build"];
  chunks: Record<string, { bytes: number; rawBytes: number }>;
  files: Record<string, { parts: Part[]; bytes: number; sha256: string }>;
  appearanceInputs: string[];
  unsupported?: Record<
    string,
    { status: string; reason: string; references?: unknown[] }
  >;
  aliases?: Record<string, string>;
}
export interface HostedOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  cache?: Pick<Cache, "match" | "put" | "delete"> | null;
  memoryBytes?: number;
  allowLoopback?: boolean;
  retries?: number;
}
const hashPattern = /^[a-f0-9]{64}$/;
const maxChunk = 25 * 1024 * 1024;
const maxRaw = 128 * 1024 * 1024;
const integer = (n: unknown, max: number) =>
  Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= max;
export function normalizeHostedResource(value: string): string {
  const key = value.replaceAll("\\", "/").toLowerCase();
  if (
    !key ||
    key.length > 1024 ||
    /[\x00-\x1f\x7f?#]/.test(key) ||
    key.startsWith("/") ||
    key.split("/").some((p) => p === ".." || p === "." || !p)
  )
    throw new Error("Invalid hosted resource name");
  return key;
}
function validKey(key: string) {
  const match = /^(read|model|world|catalog|map):(.+)$/.exec(key);
  return !!match && normalizeHostedResource(match[2]) === match[2];
}
export function validateHostedManifest(value: unknown): HostedManifest {
  const m = value as HostedManifest;
  if (
    !m ||
    m.schema !== 1 ||
    !hashPattern.test(m.revision) ||
    !m.build ||
    ![m.build.product, m.build.version, m.build.buildKey].every(
      (s) => typeof s === "string" && s.length > 0 && s.length < 256,
    ) ||
    !m.chunks ||
    typeof m.chunks !== "object" ||
    Array.isArray(m.chunks) ||
    !m.files ||
    typeof m.files !== "object" ||
    Array.isArray(m.files) ||
    !Array.isArray(m.appearanceInputs)
  )
    throw new Error("Invalid hosted asset manifest");
  for (const [sha, chunk] of Object.entries(m.chunks)) {
    if (
      !hashPattern.test(sha) ||
      !chunk ||
      !integer(chunk.bytes, maxChunk - 1) ||
      chunk.bytes === 0 ||
      !integer(chunk.rawBytes, maxRaw)
    )
      throw new Error("Invalid hosted chunk declaration");
  }
  for (const [key, file] of Object.entries(m.files)) {
    if (
      !validKey(key) ||
      !file ||
      !integer(file.bytes, maxRaw) ||
      !hashPattern.test(file.sha256) ||
      !Array.isArray(file.parts)
    )
      throw new Error("Invalid hosted file declaration");
    let total = 0;
    for (const part of file.parts) {
      const chunk =
        part && Object.hasOwn(m.chunks, part.chunk)
          ? m.chunks[part.chunk]
          : undefined;
      if (
        !chunk ||
        !integer(part.offset, chunk.rawBytes) ||
        !integer(part.length, chunk.rawBytes) ||
        part.offset + part.length > chunk.rawBytes
      )
        throw new Error("Invalid hosted file bounds");
      total += part.length;
    }
    if (total !== file.bytes) throw new Error("Invalid hosted file length");
  }
  if (m.unsupported !== undefined) {
    if (
      !m.unsupported ||
      typeof m.unsupported !== "object" ||
      Array.isArray(m.unsupported)
    )
      throw new Error("Invalid unsupported resource inventory");
    for (const [key, entry] of Object.entries(m.unsupported)) {
      if (
        normalizeHostedResource(key) !== key ||
        !entry ||
        typeof entry.status !== "string" ||
        typeof entry.reason !== "string"
      )
        throw new Error("Invalid unsupported resource entry");
    }
  }
  if (m.aliases !== undefined) {
    if (!m.aliases || typeof m.aliases !== "object" || Array.isArray(m.aliases))
      throw new Error("Invalid hosted aliases");
    for (const [name, target] of Object.entries(m.aliases)) {
      if (
        normalizeHostedResource(name) !== name ||
        typeof target !== "string" ||
        !/^id:[1-9]\d*$/.test(target)
      )
        throw new Error("Invalid hosted alias");
    }
  }
  if (
    m.appearanceInputs.some(
      (key) =>
        typeof key !== "string" ||
        !key.startsWith("read:") ||
        !Object.hasOwn(m.files, key),
    )
  )
    throw new Error("Invalid appearance input closure");
  return m;
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function namedError(name: string, message: string) {
  const e = new Error(message);
  e.name = name;
  return e;
}
function baseURL(base: string, loopback: boolean) {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (loopback &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Hosted assets require an HTTPS origin");
  return url;
}
export async function openHostedAssets(
  base: string,
  progress: (value: unknown) => void = () => {},
  options: HostedOptions = {},
): Promise<ClientReader> {
  const baseUrl = baseURL(base, options.allowLoopback === true);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = lifetime.signal;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const check = () => signal.throwIfAborted();
  const memory = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array>>();
  let used = 0;
  const budget = options.memoryBytes ?? 64 * 1024 * 1024;
  const attempts = Math.max(1, Math.min(5, (options.retries ?? 2) + 1));
  async function request<T>(
    url: URL,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        const response = await fetcher(url, {
          signal,
          credentials: "omit",
          redirect: "error",
        });
        if (response.ok) return await consume(response);
        if (
          response.status !== 408 &&
          response.status !== 429 &&
          response.status < 500
        )
          throw namedError(
            "AssetUnavailableError",
            `Hosted asset request failed (${response.status})`,
          );
        throw new Error(
          `Hosted asset service unavailable (${response.status})`,
        );
      } catch (error) {
        check();
        if (
          [
            "AssetUnavailableError",
            "AssetIntegrityError",
            "AbortError",
            "SyntaxError",
          ].includes((error as Error).name) ||
          attempt + 1 >= attempts
        )
          throw error;
        // Yield between retries; failed promises are removed from the dedup map.
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener("abort", cancel);
              resolve();
            },
            100 * 2 ** attempt,
          );
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
    }
  }
  let manifest: HostedManifest;
  try {
    manifest = validateHostedManifest(
      await request(new URL("manifest.json", baseUrl), (response) =>
        response.json(),
      ),
    );
    check();
  } catch (error) {
    options.signal?.removeEventListener("abort", abort);
    lifetime.abort();
    throw error;
  }
  let cache = options.cache;
  if (cache === undefined) {
    try {
      cache =
        typeof caches === "undefined"
          ? null
          : await caches.open("pullfiction-hosted-chunks-v1");
    } catch {
      cache = null;
    }
  }
  async function compressedBody(response: Response, sha: string) {
    const size = manifest.chunks[sha].bytes;
    const bytes = new Uint8Array(size);
    if (!response.body)
      throw namedError(
        "AssetIntegrityError",
        "Hosted chunk integrity check failed",
      );
    const stream = response.body.getReader();
    let offset = 0;
    try {
      for (;;) {
        check();
        const { value, done } = await stream.read();
        if (done) break;
        if (offset + value.length > size)
          throw namedError(
            "AssetIntegrityError",
            "Hosted chunk integrity check failed",
          );
        bytes.set(value, offset);
        offset += value.length;
      }
    } finally {
      await stream.cancel().catch(() => {});
    }
    if (offset !== size)
      throw namedError(
        "AssetIntegrityError",
        "Hosted chunk integrity check failed",
      );
    return bytes;
  }
  async function verifyCompressed(bytes: Uint8Array, sha: string) {
    const declaration = manifest.chunks[sha];
    if (bytes.length !== declaration.bytes || (await digest(bytes)) !== sha)
      throw namedError(
        "AssetIntegrityError",
        "Hosted chunk integrity check failed",
      );
    check();
    const raw = new Uint8Array(declaration.rawBytes);
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    let offset = 0;
    try {
      for (;;) {
        check();
        const { value, done } = await stream.read();
        if (done) break;
        if (offset + value.length > raw.length)
          throw new Error("Hosted chunk decompressed length mismatch");
        raw.set(value, offset);
        offset += value.length;
      }
    } finally {
      await stream.cancel().catch(() => {});
    }
    if (offset !== declaration.rawBytes)
      throw new Error("Hosted chunk decompressed length mismatch");
    check();
    return raw;
  }
  async function loadChunk(sha: string): Promise<Uint8Array> {
    const url = new URL(`chunks/${sha}.bin.gz`, baseUrl);
    let raw: Uint8Array | undefined;
    try {
      const saved = await cache?.match(url.href);
      if (saved)
        raw = await verifyCompressed(await compressedBody(saved, sha), sha);
    } catch {
      check();
      try {
        await cache?.delete(url.href);
      } catch {
        /* Optional cache. */
      }
    }
    if (!raw) {
      const compressed = await request(url, (response) =>
        compressedBody(response, sha),
      );
      raw = await verifyCompressed(compressed, sha);
      try {
        await cache?.put(
          url.href,
          new Response(compressed as Uint8Array<ArrayBuffer>),
        );
      } catch {
        /* Quota must not block assets. */
      }
    }
    check();
    if (raw.length <= budget) {
      while (used + raw.length > budget && memory.size) {
        const key = memory.keys().next().value!;
        used -= memory.get(key)!.length;
        memory.delete(key);
      }
      memory.set(sha, raw);
      used += raw.length;
    }
    return raw;
  }
  function chunk(sha: string) {
    check();
    const hit = memory.get(sha);
    if (hit) {
      memory.delete(sha);
      memory.set(sha, hit);
      return Promise.resolve(hit);
    }
    let promise = pending.get(sha);
    if (!promise) {
      promise = loadChunk(sha).finally(() => pending.delete(sha));
      pending.set(sha, promise);
    }
    return promise;
  }
  async function file(key: string): Promise<Uint8Array<ArrayBuffer>> {
    check();
    const entry = Object.hasOwn(manifest.files, key)
      ? manifest.files[key]
      : undefined;
    const resource = key.slice(key.indexOf(":") + 1);
    const unsupported =
      manifest.unsupported && Object.hasOwn(manifest.unsupported, resource)
        ? manifest.unsupported[resource]
        : undefined;
    if (!entry && unsupported)
      throw namedError(
        "ClientUnsupportedError",
        `Hosted resource is unavailable: ${resource}. ${unsupported.reason}`,
      );
    if (!entry)
      throw namedError(
        "NotFoundError",
        `Hosted resource is not published: ${key}`,
      );
    const stage = key.split(":", 1)[0];
    const label =
      stage === "catalog"
        ? `Loading ${key.slice(8)} data`
        : stage === "map"
          ? "Loading raid map"
          : stage === "world"
            ? "Loading raid environment"
            : stage === "model"
              ? "Loading character and creature models"
              : "Loading textures and interface assets";
    progress({ stage: "assets", message: label });
    const bytes = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of entry.parts) {
      const raw = await chunk(part.chunk);
      bytes.set(raw.subarray(part.offset, part.offset + part.length), offset);
      offset += part.length;
    }
    if ((await digest(bytes)) !== entry.sha256)
      throw new Error(`Hosted resource integrity check failed: ${key}`);
    check();
    return bytes;
  }
  async function json(key: string) {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await file(key)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid hosted JSON: ${key}`);
    return value;
  }
  function resourceKey(resource: string) {
    const key = normalizeHostedResource(resource);
    return manifest.aliases && Object.hasOwn(manifest.aliases, key)
      ? manifest.aliases[key]
      : key;
  }
  let appearance:
    ((request: Record<string, unknown>) => Promise<any>) | undefined;
  let appearanceModule: Promise<any> | undefined;
  return {
    build: manifest.build,
    read: async (resource) => ({
      bytes: (await file(`read:${resourceKey(resource)}`)).buffer,
    }),
    model: async (resource) => ({
      bytes: (await file(`model:${resourceKey(resource)}`)).buffer,
    }),
    world: async (resource) => ({
      bytes: (await file(`world:${normalizeHostedResource(resource)}`)).buffer,
    }),
    async catalog(kind: CatalogKind) {
      const value = await json(`catalog:${kind}`);
      return value;
    },
    async map(mapId: number): Promise<LocalMap> {
      if (!integer(mapId, 0xffffffff)) throw new Error("Invalid hosted map ID");
      const value = await json(`map:${mapId}`);
      if (
        value.map !== mapId ||
        !Array.isArray(value.bounds) ||
        value.bounds.length !== 4 ||
        !value.bounds.every(Number.isFinite) ||
        ![value.areas, value.floors, value.tiles].every(Array.isArray)
      )
        throw new Error("Invalid hosted map");
      return value;
    },
    async appearance(request) {
      check();
      const path = "/archive/hosted-appearance.mjs";
      appearanceModule ??= import(/* @vite-ignore */ path).catch((error) => {
        appearanceModule = undefined;
        throw error;
      });
      const module = await appearanceModule;
      appearance ??= module.hostedAppearance(
        async (resource: string) => file(`read:${resourceKey(resource)}`),
        manifest.appearanceInputs,
        manifest.build,
        progress,
      );
      const result = await appearance!(request);
      check();
      return result;
    },
    close() {
      lifetime.abort(namedError("AbortError", "Hosted reader closed"));
      options.signal?.removeEventListener("abort", abort);
      memory.clear();
      appearance = undefined;
      appearanceModule = undefined;
      used = 0;
    },
  };
}
export const preparedAssetsOpenClient: OpenClient = async (
  files,
  progress,
  options,
) => {
  if (!Array.isArray(files) || files.length)
    throw new Error("Hosted assets do not accept local client files");
  return openHostedAssets(
    import.meta.env?.VITE_GAME_ASSET_URL || "https://assets.pullfiction.com",
    progress,
    { ...options, allowLoopback: import.meta.env?.DEV === true },
  );
};
export const openHostedClient = preparedAssetsOpenClient;
