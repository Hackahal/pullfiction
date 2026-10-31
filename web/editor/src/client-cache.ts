import {
  assetDependencies,
  catalogAssets,
  PREFETCH_CATALOGS,
  type AssetTask,
} from "./client-prefetch";
import type { ClientReader, CatalogKind } from "./browser-assets";
import type { LocalMap } from "./local-map";

type Build = ClientReader["build"];
type Entry =
  | { kind: "value"; value: any }
  | { kind: "missing" }
  | { kind: "unsupported"; message: string };
type Manifest = { identity: string; revision: string; build: Build };
export interface PreparedClient extends ClientReader {
  readonly needsSource: boolean;
  readonly hasSource: boolean;
  attach(source: ClientReader): void;
  activate(): Promise<boolean>;
  prefetch(options: {
    raids: readonly { map: number; directory: string }[];
    signal: AbortSignal;
    ready(): boolean;
    progress(value: string): void;
  }): Promise<void>;
}
export interface ClientAssetCache {
  restore(needsSource: () => void): Promise<PreparedClient | null>;
  wrap(source: ClientReader, needsSource: () => void): Promise<PreparedClient>;
  forget(): Promise<void>;
}
const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_CACHE = 1024 * 1024 * 1024;

function buildIdentity(build: Build, revision: string) {
  if (
    !/^[a-z0-9_]{1,32}$/i.test(build?.product) ||
    !/^[0-9.]{1,32}$/.test(build?.version) ||
    !/^[a-f0-9]{32}$/i.test(build?.buildKey) ||
    !/^[a-z0-9-]{1,64}$/i.test(revision)
  )
    throw new Error("Invalid prepared client identity");
  return JSON.stringify([
    "reader-v1",
    revision,
    build.product,
    build.version,
    build.buildKey,
  ]);
}
function dataSize(value: any, seen = new Set<object>()): number {
  if (value == null) return 4;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return value.byteLength;
  let size = 0;
  for (const [key, child] of Object.entries(value)) {
    size += key.length * 2 + dataSize(child, seen);
    if (size > MAX_ENTRY) break;
  }
  return size;
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function operationKey(method: string, args: any[]) {
  if (["read", "model", "world"].includes(method))
    args = [args[0].replaceAll("\\", "/").toLowerCase()];
  return JSON.stringify([method, stable(args)]);
}

/** Only prepared reader results are saved: no installation paths or archive copies. */
export class IndexedClientAssetCache implements ClientAssetCache {
  private database: Promise<IDBDatabase> | null = null;
  private revisionPromise: Promise<string> | null = null;
  private generation = 0;
  constructor(
    private factory: IDBFactory,
    private revision: string | (() => Promise<string>),
    private name = "pullfiction-prepared-client-v1",
    private maxBytes = MAX_CACHE,
  ) {}
  private currentRevision() {
    return (this.revisionPromise ??= Promise.resolve(
      typeof this.revision === "string" ? this.revision : this.revision(),
    ));
  }
  private open() {
    if (!this.database)
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        let failed = false;
        request.onupgradeneeded = () => {
          request.result.createObjectStore("meta");
          request.result.createObjectStore("assets");
        };
        request.onerror = () => {
          failed = true;
          reject(request.error);
        };
        request.onblocked = () => {
          failed = true;
          reject(new Error("Local asset cache is blocked"));
        };
        request.onsuccess = () => {
          if (failed) {
            request.result.close();
            return;
          }
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.database = null;
          };
          resolve(db);
        };
      }).catch((error) => {
        this.database = null;
        throw error;
      });
    return this.database;
  }
  private async get(store: string, key: IDBValidKey) {
    const db = await this.open();
    return new Promise<any>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const request = tx.objectStore(store).get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("Local asset cache read failed"));
    });
  }
  async restore(needsSource: () => void) {
    const revision = await this.currentRevision();
    const manifest = (await this.get("meta", "active")) as Manifest | undefined;
    if (!manifest || manifest.revision !== revision) return null;
    if (buildIdentity(manifest.build, revision) !== manifest.identity)
      return null;
    return this.session(manifest, null, needsSource);
  }
  async wrap(source: ClientReader, needsSource: () => void) {
    const revision = await this.currentRevision();
    const manifest = {
      identity: buildIdentity(source.build, revision),
      revision,
      build: source.build,
    };
    await this.open();
    return this.session(manifest, source, needsSource);
  }
  private session(
    manifest: Manifest,
    source: ClientReader | null,
    needsSource: () => void,
  ) {
    const generation = this.generation;
    return new CachedClientReader(manifest.build, source, needsSource, {
      get: (key) => this.get("assets", [manifest.identity, key]),
      put: (key, value) => this.put(manifest.identity, key, value, generation),
      activate: (usable) => this.activate(manifest, generation, usable),
    });
  }
  private async put(
    identity: string,
    key: string,
    value: Entry,
    generation: number,
  ) {
    const size = dataSize(value);
    if (size > MAX_ENTRY || generation !== this.generation) return false;
    const db = await this.open();
    if (generation !== this.generation) return false;
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(["assets", "meta"], "readwrite");
      const assets = tx.objectStore("assets"),
        meta = tx.objectStore("meta");
      const existing = assets.getKey([identity, key]),
        budget = meta.get("bytes");
      let pending = 2,
        saved = false;
      const commit = () => {
        if (--pending) return;
        if (existing.result !== undefined) {
          saved = true;
          return;
        }
        const used = Number(budget.result) || 0;
        if (size > this.maxBytes - used) return;
        assets.put(value, [identity, key]);
        meta.put(used + size, "bytes");
        saved = true;
      };
      existing.onsuccess = budget.onsuccess = commit;
      tx.oncomplete = () => resolve(saved);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("Local asset cache write failed"));
    });
  }
  private async activate(
    manifest: Manifest,
    generation: number,
    usable: boolean,
  ) {
    const db = await this.open();
    if (generation !== this.generation) return false;
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      if (usable) tx.objectStore("meta").put(manifest, "active");
      else tx.objectStore("meta").delete("active");
      tx.oncomplete = () => resolve(usable);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("Could not save prepared client"));
    });
  }
  async forget() {
    ++this.generation;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["assets", "meta"], "readwrite");
      tx.objectStore("assets").clear();
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("Could not clear local asset cache"));
    });
  }
  async close() {
    const db = this.database;
    this.database = null;
    (await db)?.close();
  }
}

class CachedClientReader implements PreparedClient {
  private closed = false;
  private foreground = 0;
  private failedWrites = false;
  private written = new Set<string>();
  private reportedErrors = new Set<string>();
  private inFlight = new Map<string, Promise<any>>();
  private waiting: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  constructor(
    readonly build: Build,
    private source: ClientReader | null,
    private needs: () => void,
    private store: {
      get(key: string): Promise<Entry | undefined>;
      put(key: string, value: Entry): Promise<boolean>;
      activate(usable: boolean): Promise<boolean>;
    },
  ) {}
  get needsSource() {
    return !!this.waiting;
  }
  get hasSource() {
    return !!this.source;
  }
  attach(source: ClientReader) {
    if (this.closed)
      throw new DOMException("Client access was cancelled", "AbortError");
    if (
      source.build.product !== this.build.product ||
      source.build.version !== this.build.version ||
      source.build.buildKey !== this.build.buildKey
    ) {
      const error = new Error(
        "The selected client is a different build. Restart to select the updated game.",
      );
      error.name = "ClientBuildChangedError";
      throw error;
    }
    this.source?.close();
    this.source = source;
    this.waiting?.resolve();
    this.waiting = null;
  }
  private async remember(key: string, value: Entry) {
    if (
      this.written.has(key) ||
      (value.kind === "value" && value.value?.partial)
    )
      return;
    try {
      if (await this.store.put(key, value)) this.written.add(key);
      else {
        if (!this.failedWrites)
          console.warn("Prepared client cache could not save an asset", key);
        this.failedWrites = true;
      }
    } catch (error) {
      if (!this.failedWrites)
        console.warn("Prepared client cache write failed", error);
      this.failedWrites = true;
    }
  }
  private invoke(method: string, args: any[]): Promise<any> {
    const key = operationKey(method, args);
    let pending = this.inFlight.get(key);
    if (!pending) {
      ++this.foreground;
      pending = this.request(key, method, args).finally(() => {
        --this.foreground;
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }
    return pending;
  }
  private async request(
    key: string,
    method: string,
    args: any[],
  ): Promise<any> {
    if (this.closed)
      throw new DOMException("Client access was cancelled", "AbortError");
    let cached: Entry | undefined;
    try {
      cached = await this.store.get(key);
    } catch {}
    if (this.closed)
      throw new DOMException("Client access was cancelled", "AbortError");
    if (cached?.kind === "missing") {
      const error = new Error("Asset is absent from this client build");
      error.name = "NotFoundError";
      throw error;
    }
    if (cached?.kind === "value") return cached.value;
    if (cached?.kind === "unsupported") {
      const error = new Error(cached.message);
      error.name = "ClientUnsupportedError";
      throw error;
    }
    if (this.source) {
      try {
        const fn = (this.source as any)[method];
        if (!fn) throw new Error(`The client reader cannot prepare ${method}`);
        const value = await fn.apply(this.source, args);
        if (this.closed)
          throw new DOMException("Client access was cancelled", "AbortError");
        await this.remember(key, { kind: "value", value });
        return value;
      } catch (error) {
        if (!this.reportedErrors.has(key)) {
          this.reportedErrors.add(key);
          console.debug(
            "Client asset unavailable while preparing cache",
            method,
            args[0],
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
          );
        }
        if (
          !this.closed &&
          error instanceof Error &&
          error.name === "NotFoundError"
        )
          await this.remember(key, { kind: "missing" });
        else if (
          !this.closed &&
          error instanceof Error &&
          error.name === "ClientUnsupportedError"
        )
          await this.remember(key, {
            kind: "unsupported",
            message: error.message,
          });
        throw error;
      }
    }
    let notify = false;
    if (!this.waiting) {
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.waiting = { promise, resolve, reject };
      notify = true;
    }
    const waiting = this.waiting.promise;
    if (notify) {
      console.info(
        "Pull Fiction needs an uncached client asset",
        method,
        args[0],
      );
      this.needs();
    }
    await waiting;
    return this.request(key, method, args);
  }
  async prefetch(options: Parameters<PreparedClient["prefetch"]>[0]) {
    if (!this.source || this.closed) return;
    const queue = new Map<string, AssetTask>();
    const dependencies = new Map<string, AssetTask>();
    const seen = new Set<string>();
    const enqueue = (tasks: AssetTask[], immediate = false) => {
      for (const task of tasks) {
        const key = operationKey(task.method, task.args);
        if (seen.has(key) || dependencies.has(key)) continue;
        if (immediate) queue.delete(key);
        (immediate ? dependencies : queue).set(key, task);
      }
    };
    enqueue(
      PREFETCH_CATALOGS.map((kind) => ({ method: "catalog", args: [kind] })),
    );
    for (const raid of options.raids) {
      enqueue([
        { method: "map", args: [raid.map, raid.directory] },
        {
          method: "world",
          args: [`world/maps/${raid.directory}/${raid.directory}.wdt`],
        },
      ]);
    }
    let completed = 0,
      failed = 0;
    while (queue.size || dependencies.size) {
      options.signal.throwIfAborted();
      if (this.closed || !this.source) return;
      // Give scene changes and foreground reads first use of the single archive worker.
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!options.ready() || this.foreground) continue;
      options.signal.throwIfAborted();
      const next = dependencies.size ? dependencies : queue;
      const [key, task] = next.entries().next().value!;
      next.delete(key);
      seen.add(key);
      try {
        const pending = this.request(key, task.method, task.args).finally(() =>
          this.inFlight.delete(key),
        );
        this.inFlight.set(key, pending);
        const value = await pending;
        options.signal.throwIfAborted();
        if (task.method === "catalog") {
          if (value.partial) failed++;
          enqueue(catalogAssets(task.args[0], value));
        } else enqueue(assetDependencies(task, value), true);
      } catch (error) {
        options.signal.throwIfAborted();
        if (this.closed) return;
        failed++;
      }
      completed++;
      if (this.failedWrites) {
        options.progress(
          "Background caching stopped: browser storage is full or unavailable",
        );
        return;
      }
      options.progress(
        `Caching game assets: ${completed} prepared, ${queue.size + dependencies.size} queued${failed ? `, ${failed} unavailable` : ""}`,
      );
    }
    options.progress(
      failed
        ? `Background caching finished with ${failed} unavailable assets`
        : "All supported raid and catalog assets cached",
    );
  }
  async activate() {
    if (this.closed) return false;
    try {
      return await this.store.activate(!this.failedWrites);
    } catch {
      return false;
    }
  }
  read(resource: string) {
    return this.invoke("read", [resource]) as ReturnType<ClientReader["read"]>;
  }
  model(resource: string) {
    return this.invoke("model", [resource]) as ReturnType<
      ClientReader["model"]
    >;
  }
  world(resource: string) {
    return this.invoke("world", [resource]) as ReturnType<
      NonNullable<ClientReader["world"]>
    >;
  }
  map(mapId: number, directory: string) {
    return this.invoke("map", [mapId, directory]) as Promise<LocalMap>;
  }
  catalog(kind: CatalogKind) {
    return this.invoke("catalog", [kind]) as ReturnType<
      ClientReader["catalog"]
    >;
  }
  appearance(request: Record<string, unknown>) {
    return this.invoke("appearance", [request]);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.waiting?.reject(
      new DOMException("Client access was cancelled", "AbortError"),
    );
    this.waiting = null;
    this.source?.close();
    this.source = null;
  }
}

export function createClientAssetCache(): ClientAssetCache | null {
  try {
    if (typeof indexedDB === "undefined") return null;
    return new IndexedClientAssetCache(indexedDB, async () => {
      const path = "/archive/revision.mjs";
      const module = await import(/* @vite-ignore */ path);
      return module.CONVERTER_REVISION;
    });
  } catch {
    return null;
  }
}
