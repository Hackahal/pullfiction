import type { Actor } from "./types";
import type { IconLease, LocalIconCache } from "./local-icons";
import type { LocalUiArt } from "./local-ui-art";

// The original token's icon key, independent of drawing geometry and browser placeholders.
export function mapActorIconKey(
  actor: Pick<Actor, "type" | "class" | "icon">,
): string {
  const raw = actor.icon?.replace(/^custom-icon-/i, "");
  const stem = raw?.split(/[\\/]/).pop()?.split(".")[0];
  const icon =
    stem && /^(ability|spell|inv|achievement|trade)_/i.test(stem)
      ? stem.toLowerCase()
      : actor.type === "NPC" && actor.class === "Boss"
        ? "inv_misc_head_dragon_01"
        : actor.type === "Pet"
          ? "ability_hunter_pet_wolf"
          : "inv_misc_monsterhead_02";
  return `/game-ui/icons/${icon}.png`;
}

export function localMapImageUrl(url: string): boolean {
  return url.startsWith("blob:") || /^data:image\/png(?:;base64)?,/i.test(url);
}

type IconSource = Pick<LocalIconCache, "acquire">;
export type MapImageContext = {
  browser: boolean;
  art?: LocalUiArt;
  icons?: IconSource;
};
type Source = { url: string } | { cache: IconSource; icon: string };
type Entry = { source: Source; lease?: IconLease; image?: HTMLImageElement };

function source(key: string, context: MapImageContext): Source | undefined {
  if (!context.browser) return { url: key };
  const alias = context.art?.get(key);
  if (alias && localMapImageUrl(alias)) return { url: alias };
  if (localMapImageUrl(key)) return { url: key };
  const icon = /^\/game-ui\/icons\/([a-z0-9_-]+)\.png$/i.exec(key)?.[1];
  return icon && context.icons ? { cache: context.icons, icon } : undefined;
}
function same(a: Source, b: Source): boolean {
  return "url" in a && "url" in b
    ? a.url === b.url
    : "cache" in a && "cache" in b && a.cache === b.cache && a.icon === b.icon;
}

// Keep the renderer's original image-map keys; own only URL resolution and image/lease lifetime.
export class MapViewImages {
  private readonly entries = new Map<string, Entry>();
  private context?: MapImageContext;
  private changed?: () => void;

  constructor(
    private readonly images: Map<string, HTMLImageElement>,
    private readonly createImage = () => new Image(),
  ) {}

  update(
    keys: Iterable<string>,
    context: MapImageContext,
    changed: () => void,
  ) {
    this.changed = changed;
    const switched =
      this.context &&
      (this.context.browser !== context.browser ||
        this.context.art !== context.art ||
        this.context.icons !== context.icons);
    let removed = false;
    if (switched) {
      for (const key of this.entries.keys()) this.remove(key);
      removed = true;
    }
    this.context = context;
    const wanted = new Map<string, Source>();
    for (const key of keys) {
      const resolved = source(key, context);
      if (resolved) wanted.set(key, resolved);
    }
    for (const [key, entry] of this.entries) {
      const next = wanted.get(key);
      if (!next || !same(entry.source, next)) {
        this.remove(key);
        removed = true;
      }
    }
    for (const [key, resolved] of wanted) {
      if (this.entries.has(key)) continue;
      const entry: Entry = { source: resolved };
      this.entries.set(key, entry);
      if ("url" in resolved) this.load(key, entry, resolved.url);
      else {
        entry.lease = resolved.cache.acquire({ icon: resolved.icon });
        void entry.lease.url
          .then((url) => {
            if (url && localMapImageUrl(url)) this.load(key, entry, url);
          })
          .catch(() => {});
      }
    }
    if (removed) changed();
  }

  private load(key: string, entry: Entry, url: string) {
    if (this.entries.get(key) !== entry) return;
    const image = this.createImage();
    entry.image = image;
    this.images.set(key, image);
    image.onload = () => {
      if (this.entries.get(key) === entry) this.changed?.();
    };
    image.onerror = () => {
      if (this.entries.get(key) === entry) this.changed?.();
    };
    image.src = url;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image.removeAttribute("src");
      if (this.images.get(key) === entry.image) this.images.delete(key);
    }
    entry.lease?.release();
  }

  dispose() {
    for (const key of this.entries.keys()) this.remove(key);
    this.context = undefined;
    this.changed = undefined;
  }
}
