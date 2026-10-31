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

// Each visible map owns its URLs. Releasing a map also invalidates work still
// waiting in the reader or codec, so a late response cannot repopulate the map.
export class LocalMapAssets {
  private sessions = new Set<() => void>();
  private disposed = false;
  constructor(
    private provider: MapProvider,
    private ports: MapImagePorts = {
      decode: decodeLocalIcon,
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    },
  ) {}
  load(mapId: number, directory: string, signal?: AbortSignal): LocalMapLease {
    const abort = new AbortController();
    const urls = new Set<string>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      abort.abort();
      signal?.removeEventListener("abort", release);
      for (const url of urls) this.ports.revoke(url);
      urls.clear();
      this.sessions.delete(release);
    };
    this.sessions.add(release);
    signal?.addEventListener("abort", release, { once: true });
    if (this.disposed || signal?.aborted) release();
    const ready = (async () => {
      try {
        abort.signal.throwIfAborted();
        const map = await this.provider.map(mapId, directory);
        abort.signal.throwIfAborted();
        validMap(map, mapId);
        const resources = [...new Set(map.tiles.map((tile) => tile.resource))];
        const images = new Map<string, string>();
        let next = 0;
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
        return {
          manifest: {
            map: map.map,
            bounds: map.bounds,
            areas: map.areas,
            tiles,
            floors: map.floors,
          },
          missingTiles: map.tiles.length - tiles.length,
        };
      } catch (error) {
        release();
        throw error;
      }
    })();
    return { ready, release };
  }
  dispose() {
    this.disposed = true;
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
