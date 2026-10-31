import type { BrowserAssetBridge } from "./browser-assets";
import { decodeLocalIcon } from "./local-icons";
import { mapPoint, type MapFloor, type MapManifest } from "./map-model";

// All coordinates come from the selected client. Bounds are already north-up;
// tile corners and floor vertices remain in WoW coordinates until rendering.
export interface LocalMap {
  map: number;
  bounds: [number, number, number, number];
  areas: MapManifest["areas"];
  tiles: {
    resource: string;
    corners: [number, number][];
    area: string;
    cell?: [number, number];
  }[];
  floors: MapFloor[];
}
type MapProvider = Pick<BrowserAssetBridge, "read" | "map">;
export type MapImagePorts = {
  decode(bytes: Uint8Array): Promise<Blob>;
  create(blob: Blob): string;
  revoke(url: string): void;
};
export type LocalMapResult = { manifest: MapManifest; missingTiles: number };
export type LocalMapLease = {
  ready: Promise<LocalMapResult>;
  release(): void;
};

export function localMapResource(resource: string): string {
  const path = resource.replaceAll("\\", "/");
  if (/^id:[1-9]\d*$/.test(path) && Number(path.slice(3)) <= 0xffffffff)
    return path;
  if (
    !/^[a-z0-9_./ -]+\.blp$/i.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid local minimap resource");
  return path;
}

function validMap(map: LocalMap, mapId: number) {
  if (
    map.map !== mapId ||
    map.bounds.length !== 4 ||
    !map.bounds.every(Number.isFinite) ||
    map.bounds[0] >= map.bounds[2] ||
    map.bounds[1] >= map.bounds[3] ||
    !Array.isArray(map.areas) ||
    !Array.isArray(map.tiles) ||
    !Array.isArray(map.floors)
  )
    throw new Error("Invalid local tactical map");
  const areas = new Set(map.areas.map((area) => area.id));
  if (
    map.areas.some(
      (area) =>
        typeof area.id !== "string" ||
        typeof area.name !== "string" ||
        !Number.isFinite(area.height),
    ) ||
    map.tiles.some(
      (tile) =>
        typeof tile.resource !== "string" ||
        !areas.has(tile.area) ||
        tile.corners.length !== 4 ||
        tile.corners.some((p) => p.length !== 2 || !p.every(Number.isFinite)),
    ) ||
    map.floors.some(
      (floor) =>
        !areas.has(floor.area) ||
        !floor.vertices.length ||
        floor.vertices.some(
          (p) => p.length !== 3 || !p.every(Number.isFinite),
        ) ||
        floor.indices.length % 3 !== 0 ||
        floor.indices.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= floor.vertices.length,
        ),
    )
  )
    throw new Error("Invalid local tactical map geometry");
}

export function mapAreaBounds(manifest: MapManifest, area = "*"): number[] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x: number, y: number) => {
    const point = mapPoint(x, y);
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  };
  for (const tile of manifest.tiles)
    if (area === "*" || tile.area === area)
      for (const p of tile.corners) add(...p);
  for (const floor of manifest.floors ?? [])
    if (area === "*" || floor.area === area)
      for (const index of floor.indices) {
        const [x, y] = floor.vertices[index];
        add(x, y);
      }
  return minX < maxX && minY < maxY
    ? [minX, minY, maxX, maxY]
    : manifest.bounds;
}

export function projectedFloor(floor: MapFloor) {
  const vertices = floor.vertices.map(([x, y]) => mapPoint(x, y));
  const indices: number[] = [];
  for (let i = 0; i < floor.indices.length; i += 3) {
    const ia = floor.indices[i],
      ib = floor.indices[i + 1],
      ic = floor.indices[i + 2];
    const a = vertices[ia],
      b = vertices[ib],
      c = vertices[ic];
    // Vertical faces have no top-down footprint.
    if (
      Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) >
      0.001
    )
      indices.push(ia, ib, ic);
  }
  return { vertices, indices };
}

export function localFloorHeight(
  manifest: MapManifest,
  x: number,
  y: number,
  area = "*",
  hint = 0,
): number | undefined {
  let best: number | undefined;
  for (const floor of manifest.floors ?? []) {
    if (area !== "*" && floor.area !== area) continue;
    for (let i = 0; i < floor.indices.length; i += 3) {
      const a = floor.vertices[floor.indices[i]],
        b = floor.vertices[floor.indices[i + 1]],
        c = floor.vertices[floor.indices[i + 2]];
      const denominator =
        (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(denominator) < 0.001) continue;
      const u =
        ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
      const v =
        ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
      const w = 1 - u - v;
      if (Math.min(u, v, w) < -0.00001) continue;
      const z = u * a[2] + v * b[2] + w * c[2];
      if (best === undefined || Math.abs(z - hint) < Math.abs(best - hint))
        best = z;
    }
  }
  return best;
}

type RetainedMap = {
  lease: LocalMapLease;
  users: number;
  complete: boolean;
  reusable: boolean;
  bytes: number;
  touched: number;
};

// Completed maps own decoded URLs across view mounts. Leases protect visible maps;
// only idle entries can be evicted, and incomplete work is cancelled on last release.
export class LocalMapAssets {
  private sessions = new Set<() => void>();
  private disposed = false;
  private entries = new Map<string, RetainedMap>();
  private clock = 0;
  private retainedBytes = new WeakMap<LocalMapResult, number>();
  constructor(
    private provider: MapProvider,
    private ports: MapImagePorts = {
      decode: decodeLocalIcon,
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    },
    private maxIdleMaps = 2,
    private maxIdleBytes = 128 * 1024 * 1024,
  ) {}
  /** Reuse completed map imagery within this client generation without retaining raw archives. */
  load(mapId: number, directory: string, signal?: AbortSignal): LocalMapLease {
    if (this.disposed || signal?.aborted)
      return {
        ready: Promise.reject(
          new DOMException("Map access cancelled", "AbortError"),
        ),
        release() {},
      };
    const key = JSON.stringify([mapId, directory.toLowerCase()]);
    let entry = this.entries.get(key);
    if (!entry) {
      const lease = this.prepare(mapId, directory);
      entry = {
        lease,
        users: 0,
        complete: false,
        reusable: false,
        bytes: 0,
        touched: ++this.clock,
      };
      const current = entry;
      this.entries.set(key, current);
      current.lease = {
        release: lease.release,
        ready: lease.ready
          .then((result) => {
            current.complete = true;
            current.reusable = result.missingTiles === 0;
            current.bytes = this.retainedBytes.get(result) ?? 0;
            this.trim();
            return result;
          })
          .catch((error) => {
            if (this.entries.get(key) === current) this.entries.delete(key);
            lease.release();
            throw error;
          }),
      };
    }
    const current = entry;
    current.users++;
    current.touched = ++this.clock;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      current.users--;
      current.touched = ++this.clock;
      if (!current.users && (!current.complete || !current.reusable)) {
        if (this.entries.get(key) === current) this.entries.delete(key);
        current.lease.release();
      }
      this.trim();
    };
    signal?.addEventListener("abort", release, { once: true });
    return {
      ready: current.lease.ready.then((result) => {
        if (released || this.disposed)
          throw new DOMException("Map access cancelled", "AbortError");
        return result;
      }),
      release,
    };
  }
  private trim() {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.users === 0)
      .sort((a, b) => a[1].touched - b[1].touched);
    let bytes = idle.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    while (idle.length > this.maxIdleMaps || bytes > this.maxIdleBytes) {
      const [key, entry] = idle.shift()!;
      this.entries.delete(key);
      bytes -= entry.bytes;
      entry.lease.release();
    }
  }
  private prepare(mapId: number, directory: string): LocalMapLease {
    const abort = new AbortController();
    const urls = new Set<string>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      abort.abort();
      for (const url of urls) this.ports.revoke(url);
      urls.clear();
      this.sessions.delete(release);
    };
    this.sessions.add(release);
    if (this.disposed) release();
    const ready = (async () => {
      try {
        abort.signal.throwIfAborted();
        const map = await this.provider.map(mapId, directory);
        abort.signal.throwIfAborted();
        validMap(map, mapId);
        const resources = [...new Set(map.tiles.map((tile) => tile.resource))];
        const images = new Map<string, string>();
        let next = 0,
          imageBytes = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, resources.length) }, async () => {
            while (next < resources.length) {
              abort.signal.throwIfAborted();
              const resource = resources[next++];
              try {
                const bytes = await this.provider.read(
                  localMapResource(resource),
                );
                abort.signal.throwIfAborted();
                const blob = await this.ports.decode(bytes);
                abort.signal.throwIfAborted();
                const header =
                  bytes.byteLength >= 20
                    ? new DataView(
                        bytes.buffer,
                        bytes.byteOffset,
                        bytes.byteLength,
                      )
                    : null;
                imageBytes += header
                  ? header.getUint32(12, true) * header.getUint32(16, true) * 4
                  : blob.size * 4;
                const url = this.ports.create(blob);
                urls.add(url);
                images.set(resource, url);
              } catch (error) {
                if (abort.signal.aborted) throw error;
                // Real floor geometry remains useful when a tile is absent.
              }
            }
          }),
        );
        abort.signal.throwIfAborted();
        const tiles = map.tiles.flatMap((tile) => {
          const src = images.get(tile.resource);
          return src
            ? [{ src, corners: tile.corners, area: tile.area, cell: tile.cell }]
            : [];
        });
        if (
          !tiles.length &&
          !map.floors.some((floor) => projectedFloor(floor).indices.length)
        )
          throw new Error(
            "The selected client has no usable raid minimap or floor geometry",
          );
        const result: LocalMapResult = {
          manifest: {
            map: map.map,
            bounds: map.bounds,
            areas: map.areas,
            tiles,
            floors: map.floors,
          },
          missingTiles: map.tiles.length - tiles.length,
        };
        this.retainedBytes.set(
          result,
          imageBytes +
            map.floors.reduce(
              (sum, floor) =>
                sum + floor.vertices.length * 64 + floor.indices.length * 8,
              0,
            ),
        );
        return result;
      } catch (error) {
        release();
        throw error;
      }
    })();
    return { ready, release };
  }
  dispose() {
    this.disposed = true;
    this.entries.clear();
    for (const release of [...this.sessions]) release();
  }
}

let provider: MapProvider | undefined;
let maps: LocalMapAssets | undefined;
const listeners = new Set<() => void>();
export function installLocalMaps(next: MapProvider) {
  if (provider === next) return;
  maps?.dispose();
  provider = next;
  maps = new LocalMapAssets(next);
  for (const listener of listeners) listener();
}
/** Invalidate decoded maps when the user explicitly clears prepared client assets. */
export function resetLocalMaps() {
  if (!provider) return;
  maps?.dispose();
  maps = new LocalMapAssets(provider);
  for (const listener of listeners) listener();
}
export function removeLocalMaps(previous: MapProvider) {
  if (provider !== previous) return;
  maps?.dispose();
  maps = undefined;
  provider = undefined;
  for (const listener of listeners) listener();
}
export const getLocalMaps = () => maps;
export function subscribeLocalMaps(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
