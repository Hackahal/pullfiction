import type { BrowserAssetBridge } from "./browser-assets";

export interface IconRequest {
  icon?: string;
  spell?: number;
  item?: number;
  iconFile?: number;
}
type IconProvider = Pick<BrowserAssetBridge, "read" | "catalog">;
type Entry = {
  resource: string;
  promise: Promise<string | undefined>;
  url?: string;
  users: number;
  touched: number;
};
export type IconLease = { url: Promise<string | undefined>; release(): void };
export type IconPorts = {
  decode(bytes: Uint8Array): Promise<Blob>;
  create(blob: Blob): string;
  revoke(url: string): void;
};
const positiveID = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;

// Only icon paths are accepted. A recorded URL never becomes a network request.
export function recordedIconResource(icon?: string): string | undefined {
  if (!icon) return undefined;
  const value = icon.trim().replaceAll("\\", "/").toLowerCase();
  if (/^id:[1-9]\d*$/.test(value) && positiveID(Number(value.slice(3))))
    return value;
  const stem = value
    .replace(/^interface\/icons\//, "")
    .replace(/\.(?:blp|png|jpe?g)$/, "");
  return /^[a-z0-9_-]{1,160}$/.test(stem)
    ? `interface/icons/${stem}.blp`
    : undefined;
}
export function iconRequestKey(request: IconRequest) {
  return JSON.stringify([
    request.iconFile ?? null,
    request.spell ?? null,
    request.item ?? null,
    recordedIconResource(request.icon) ?? null,
  ]);
}
let codec: Promise<any> | undefined;
export async function decodeLocalIcon(bytes: Uint8Array): Promise<Blob> {
  if (bytes.byteLength > 4 * 1024 * 1024)
    throw new Error("Icon exceeds the local image limit");
  if (
    bytes.byteLength < 20 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "BLP2"
  )
    throw new Error("Invalid local icon texture");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(12, true),
    height = header.getUint32(16, true);
  if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024))
    throw new Error("Invalid local icon dimensions");
  codec ??= (async () => {
    const path = "/archive/pullfiction_asset_codec.js";
    const module = await import(/* @vite-ignore */ path);
    await module.default();
    return module;
  })().catch((error) => {
    codec = undefined;
    throw error;
  });
  const module = await codec;
  const texture = module.decode_texture(bytes);
  try {
    const { width, height } = texture;
    if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024))
      throw new Error("Invalid local icon dimensions");
    const pixels = texture.pixels();
    if (pixels.length !== width * height * 4)
      throw new Error("Invalid local icon pixels");
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Local image encoding is unavailable");
    context.putImageData(
      new ImageData(new Uint8ClampedArray(pixels), width, height),
      0,
      0,
    );
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    texture.free();
  }
}

// Cache resources rather than visible rows. Hundreds of casts can share one
// read, decode and blob URL. Idle entries are bounded; mounted images keep leases.
export class LocalIconCache {
  private entries = new Map<string, Entry>();
  private disposed = false;
  private clock = 0;
  constructor(
    private provider: IconProvider,
    private ports: IconPorts = {
      decode: decodeLocalIcon,
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    },
    private idleLimit = 128,
  ) {}

  private async candidates(request: IconRequest) {
    const resources: string[] = [];
    if (positiveID(request.iconFile)) resources.push(`id:${request.iconFile}`);
    if (positiveID(request.spell) || positiveID(request.item)) {
      const kind = positiveID(request.spell) ? "spells" : "items";
      const id = kind === "spells" ? request.spell : request.item;
      try {
        const catalog = await this.provider.catalog(kind);
        const file = catalog[kind]?.[String(id)]?.iconFile;
        if (positiveID(file)) resources.push(`id:${file}`);
      } catch {
        /* A missing optional icon keeps its authored placeholder. */
      }
    }
    const recorded = recordedIconResource(request.icon);
    if (recorded) resources.push(recorded);
    return [...new Set(resources)];
  }
  private entry(resource: string): Entry {
    let entry = this.entries.get(resource);
    if (!entry) {
      entry = {
        resource,
        promise: Promise.resolve(undefined),
        users: 0,
        touched: ++this.clock,
      };
      this.entries.set(resource, entry);
      const target = entry;
      target.promise = (async () => {
        try {
          const bytes = await this.provider.read(resource);
          if (this.disposed || this.entries.get(resource) !== target) return;
          const blob = await this.ports.decode(bytes);
          if (this.disposed || this.entries.get(resource) !== target) return;
          const url = this.ports.create(blob);
          target.url = url;
          return url;
        } catch {
          return undefined;
        } finally {
          this.prune();
        }
      })();
    }
    entry.touched = ++this.clock;
    return entry;
  }
  acquire(request: IconRequest): IconLease {
    let released = false;
    let held: Entry | undefined;
    const releaseEntry = () => {
      if (held) {
        held.users--;
        held.touched = ++this.clock;
        held = undefined;
      }
      this.prune();
    };
    const url = (async () => {
      const resources = await this.candidates(request);
      for (const resource of resources) {
        if (this.disposed || released) return;
        held = this.entry(resource);
        held.users++;
        const value = await held.promise;
        if (this.disposed || released) return;
        if (value) return value;
        releaseEntry();
      }
      return undefined;
    })();
    return {
      url,
      release: () => {
        if (!released) {
          released = true;
          releaseEntry();
        }
      },
    };
  }
  private prune() {
    const idle = [...this.entries.values()]
      .filter((entry) => !entry.users)
      .sort((a, b) => a.touched - b.touched);
    for (const entry of idle.slice(
      0,
      Math.max(0, idle.length - this.idleLimit),
    )) {
      if (entry.url) this.ports.revoke(entry.url);
      this.entries.delete(entry.resource);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values())
      if (entry.url) this.ports.revoke(entry.url);
    this.entries.clear();
  }
}
let provider: IconProvider | undefined;
let cache: LocalIconCache | undefined;
const listeners = new Set<() => void>();
export function installLocalIcons(next: IconProvider) {
  if (provider === next) return;
  cache?.dispose();
  provider = next;
  cache = new LocalIconCache(next);
  for (const listener of listeners) listener();
}
export function removeLocalIcons(previous: IconProvider) {
  if (provider !== previous) return;
  cache?.dispose();
  cache = undefined;
  provider = undefined;
  for (const listener of listeners) listener();
}
export const getLocalIcons = () => cache;
export const subscribeLocalIcons = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
