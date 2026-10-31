import type { ClientSelection } from "./client-folder";
import { installLocalIcons, removeLocalIcons } from "./local-icons";
import { installLocalMaps, removeLocalMaps, type LocalMap } from "./local-map";
export type CatalogKind =
  | "creatures"
  | "items"
  | "spells"
  | "world"
  | "lighting"
  | "characters"
  | "talents";
export type ModernCatalog = Record<string, any>;
export interface ClientReader {
  build: { version: string; product: string; buildKey: string };
  read(resource: string): Promise<{ bytes: ArrayBuffer }>;
  model(resource: string): Promise<{ bytes: ArrayBuffer }>;
  world?(resource: string): Promise<{ bytes: ArrayBuffer }>;
  map?(mapId: number, directory: string): Promise<LocalMap>;
  catalog(kind: CatalogKind): Promise<ModernCatalog>;
  appearance(request: Record<string, unknown>): Promise<any>;
  close(): void;
}
export interface BrowserAssetBridge {
  build: ClientReader["build"];
  read(resource: string): Promise<Uint8Array>;
  model(resource: string): Promise<Uint8Array>;
  world(resource: string): Promise<Uint8Array>;
  map(mapId: number, directory: string): Promise<LocalMap>;
  catalog(kind: CatalogKind): Promise<ModernCatalog>;
  appearance(request: Record<string, unknown>): Promise<any>;
}
export type OpenClient = (
  files: ClientSelection,
  progress: (value: unknown) => void,
  options: { signal: AbortSignal },
) => Promise<ClientReader>;
export const openClientFiles: OpenClient = async (files, progress, options) => {
  const path = "/archive/client.mjs";
  const module = await import(/* @vite-ignore */ path);
  options.signal.throwIfAborted();
  return Array.isArray(files)
    ? module.openFiles(files, progress, options)
    : module.openDirectory(files, progress, options);
};

export function assetBridge(reader: ClientReader): BrowserAssetBridge {
  const catalogs = new Map<CatalogKind, Promise<ModernCatalog>>();
  const resourceKey = (resource: string) =>
    resource
      .replace(/^__classic\/(\d+)\.(?:m2|blp)$/i, "id:$1")
      .replace(/^interface\/icons\/pf_([1-9]\d*)\.blp$/i, "id:$1");
  const raw = async (resource: string) => {
    // Vanilla terrain probes a name-derived specular companion. FileDataID
    // aliases have no such generated file; don't ask for disk access to resolve
    // a name the modern converter does not produce.
    if (/^__classic\/[1-9]\d*_s\.blp$/i.test(resource)) {
      const error = new Error(
        "No generated specular companion for this virtual texture",
      );
      error.name = "NotFoundError";
      throw error;
    }
    try {
      return await reader.read(resourceKey(resource));
    } catch (error) {
      // WCL's Classic icon namespace can prefix the unchanged client icon stem.
      // Prefer the exact asset, then try its modern name only for a confirmed miss.
      const classicIcon =
        /^interface\/icons\/classic_([a-z0-9_-]+\.blp)$/i.exec(resource);
      if (
        !(error instanceof Error) ||
        error.name !== "NotFoundError" ||
        !classicIcon
      )
        throw error;
      return reader.read(`interface/icons/${classicIcon[1]}`);
    }
  };
  const world = async (resource: string) => {
    if (!reader.world)
      throw new Error(
        "The local client reader cannot prepare raid environments",
      );
    // Virtual WMO group names retain their group suffix for the world adapter.
    return new Uint8Array((await reader.world(resource)).bytes);
  };
  return {
    build: reader.build,
    // M2 geometry must pass through the modern converter before the native parser.
    read: async (resource) =>
      /\.(?:wdt|adt|wmo)$/i.test(resource)
        ? world(resource)
        : new Uint8Array(
            (
              await (/\.(?:m2|mdx)$/i.test(resource)
                ? reader.model(resourceKey(resource))
                : raw(resource))
            ).bytes,
          ),
    model: async (resource) =>
      new Uint8Array((await reader.model(resourceKey(resource))).bytes),
    world,
    map(mapId, directory) {
      if (!reader.map)
        return Promise.reject(
          new Error("The local client reader cannot prepare tactical maps"),
        );
      return reader.map(mapId, directory);
    },
    appearance: (request) => reader.appearance(request),
    catalog(kind) {
      let request = catalogs.get(kind);
      if (!request) {
        request = reader
          .catalog(kind)
          .then((value) => {
            // Locked local sections can become readable later. Preserve optional
            // partial metadata for this caller without freezing it in the cache.
            if (
              kind === "talents" &&
              value.partial &&
              catalogs.get(kind) === request
            )
              catalogs.delete(kind);
            return value;
          })
          .catch((error) => {
            if (catalogs.get(kind) === request) catalogs.delete(kind);
            throw error;
          });
        catalogs.set(kind, request);
      }
      return request;
    },
  };
}
export function installAssetBridge(bridge: BrowserAssetBridge) {
  installLocalIcons(bridge);
  installLocalMaps(bridge);
  (
    globalThis as typeof globalThis & {
      __pullfiction_assets?: BrowserAssetBridge;
    }
  ).__pullfiction_assets = bridge;
}
export function removeAssetBridge(bridge: BrowserAssetBridge) {
  removeLocalIcons(bridge);
  removeLocalMaps(bridge);
  const target = globalThis as typeof globalThis & {
    __pullfiction_assets?: BrowserAssetBridge;
  };
  if (target.__pullfiction_assets === bridge)
    delete target.__pullfiction_assets;
}
export function progressText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const progress = value as Record<string, unknown>;
    return String(
      progress.message ??
        progress.status ??
        progress.phase ??
        "Preparing local client",
    );
  }
  return "Preparing local client";
}
