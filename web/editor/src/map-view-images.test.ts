import test from "node:test";
import assert from "node:assert/strict";
import {
  MapViewImages,
  mapActorIconKey,
  localMapImageUrl,
} from "./map-view-images";
import type { IconRequest } from "./local-icons";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const images = new Map<string, HTMLImageElement>();
  const made: HTMLImageElement[] = [];
  let changes = 0;
  const loader = new MapViewImages(images, () => {
    const image = {
      src: "",
      onload: null,
      onerror: null,
      removeAttribute(name: string) {
        if (name === "src") image.src = "";
      },
    } as unknown as HTMLImageElement;
    made.push(image);
    return image;
  });
  return {
    images,
    made,
    loader,
    changed: () => {
      changes++;
    },
    count: () => changes,
  };
}
function icons(url: Promise<string | undefined>) {
  const acquired: IconRequest[] = [];
  let releases = 0;
  return {
    acquired,
    releases: () => releases,
    acquire(request: IconRequest) {
      acquired.push(request);
      return {
        url,
        release() {
          releases++;
        },
      };
    },
  };
}

test("Original atlas keys, custom icons, tile blobs and native PNG portraits resolve locally", async () => {
  const f = fixture(),
    cache = icons(Promise.resolve("blob:mark"));
  const art = new Map([
    ["/game-ui/class-icons.png", "blob:classes"],
    ["/game-ui/raid-icons.png", "blob:raids"],
  ]);
  const portrait = "data:image/png;base64,iVBORw0KGgo=";
  const keys = [
    "/game-ui/class-icons.png",
    "/game-ui/raid-icons.png",
    "/game-ui/icons/spell_fire_flamebolt.png",
    "blob:tile",
    portrait,
    "https://remote.example/icon.png",
    "/game-ui/unavailable.png",
    "data:image/svg+xml,<svg/>",
  ];
  const context = { browser: true, art, icons: cache };
  f.loader.update(keys, context, f.changed);
  await Promise.resolve();
  assert.deepEqual([...f.images.keys()].sort(), keys.slice(0, 5).sort());
  assert.equal(f.images.get("/game-ui/class-icons.png")?.src, "blob:classes");
  assert.equal(f.images.get("/game-ui/raid-icons.png")?.src, "blob:raids");
  assert.equal(
    f.images.get("/game-ui/icons/spell_fire_flamebolt.png")?.src,
    "blob:mark",
  );
  assert.equal(f.images.get(portrait)?.src, portrait);
  assert.deepEqual(cache.acquired, [{ icon: "spell_fire_flamebolt" }]);
  const first = f.images.get("/game-ui/class-icons.png");
  f.loader.update(keys, context, f.changed);
  assert.equal(f.images.get("/game-ui/class-icons.png"), first);
  assert.equal(cache.acquired.length, 1);
  assert.equal(f.made.length, 5);
  f.loader.dispose();
  assert.equal(f.images.size, 0);
  assert.equal(cache.releases(), 1);
  assert.ok(
    f.made.every(
      (image) =>
        image.onload === null && image.onerror === null && image.src === "",
    ),
  );
});

test("Replacing a source detaches old images and ignores late icon reads and onload callbacks", async () => {
  const f = fixture(),
    wait = deferred<string>(),
    a = icons(wait.promise),
    b = icons(Promise.resolve("blob:new-mark"));
  const key = "/game-ui/icons/inv_misc_head_dragon_01.png",
    atlas = "/game-ui/class-icons.png";
  f.loader.update(
    [key, atlas],
    { browser: true, art: new Map([[atlas, "blob:old-atlas"]]), icons: a },
    f.changed,
  );
  const old = f.images.get(atlas)!,
    oldLoad = old.onload!;
  f.loader.update(
    [key, atlas],
    { browser: true, art: new Map([[atlas, "blob:new-atlas"]]), icons: b },
    f.changed,
  );
  const before = f.count();
  oldLoad.call(old, {} as Event);
  assert.equal(f.count(), before);
  assert.equal(old.src, "");
  assert.equal(a.releases(), 1);
  wait.resolve("blob:old-mark");
  await Promise.resolve();
  assert.equal(f.images.get(key)?.src, "blob:new-mark");
  assert.equal(f.images.get(atlas)?.src, "blob:new-atlas");
  assert.ok(f.made.every((image) => image.src !== "blob:old-mark"));
  f.loader.dispose();
  assert.equal(b.releases(), 1);
});

test("Removal and disposal release pending leases and prevent late Image allocation", async () => {
  const f = fixture(),
    wait = deferred<string>(),
    cache = icons(wait.promise);
  const context = { browser: true, icons: cache },
    key = "/game-ui/icons/spell_frost_frostbolt02.png";
  f.loader.update([key], context, f.changed);
  f.loader.update([], context, f.changed);
  assert.equal(cache.releases(), 1);
  wait.resolve("blob:removed");
  await Promise.resolve();
  assert.equal(f.made.length, 0);
  const second = deferred<string>(),
    other = icons(second.promise);
  f.loader.update([key], { browser: true, icons: other }, f.changed);
  f.loader.dispose();
  f.loader.dispose();
  second.resolve("blob:disposed");
  await Promise.resolve();
  assert.equal(f.images.size, 0);
  assert.equal(f.made.length, 0);
  assert.equal(other.releases(), 1);
  // React's development effect replay can establish a new lifetime after cleanup.
  f.loader.update(["blob:reopened"], { browser: true }, f.changed);
  assert.equal(f.images.get("blob:reopened")?.src, "blob:reopened");
  f.loader.dispose();
});

test("Native reference mode retains original URLs and browser mode cannot request external artwork", () => {
  const f = fixture(),
    atlas = "/game-ui/class-icons.png";
  f.loader.update([atlas], { browser: false }, f.changed);
  assert.equal(f.images.get(atlas)?.src, atlas);
  f.loader.update(
    [atlas, "https://remote.example/art.png"],
    { browser: true },
    f.changed,
  );
  assert.equal(f.images.size, 0);
  assert.ok(localMapImageUrl("data:image/png;base64,AA=="));
  assert.ok(localMapImageUrl("blob:local"));
  assert.equal(localMapImageUrl("data:image/svg+xml,<svg/>"), false);
  assert.equal(localMapImageUrl("https://remote.example/art.png"), false);
});

test("Actor fallback keys retain the original icon selection without changing token geometry", () => {
  assert.equal(
    mapActorIconKey({
      type: "NPC",
      class: "Boss",
      icon: "custom-icon-Spell_Fire_FlameBolt.jpg",
    }),
    "/game-ui/icons/spell_fire_flamebolt.png",
  );
  assert.equal(
    mapActorIconKey({ type: "NPC", class: "Boss" }),
    "/game-ui/icons/inv_misc_head_dragon_01.png",
  );
  assert.equal(
    mapActorIconKey({ type: "Pet", class: "" }),
    "/game-ui/icons/ability_hunter_pet_wolf.png",
  );
  assert.equal(
    mapActorIconKey({
      type: "NPC",
      class: "",
      icon: "https://bad.example/asset.png",
    }),
    "/game-ui/icons/inv_misc_monsterhead_02.png",
  );
});
