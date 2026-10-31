import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedClientAssetCache } from "./client-cache";
import type { ClientReader } from "./browser-assets";

function fixture(key = "a".repeat(32)) {
  const calls: string[] = [];
  const reader: ClientReader = {
    build: {
      product: "wow_classic_era",
      version: "1.15.9.12345",
      buildKey: key,
    },
    read: async (name) => {
      calls.push(`read:${name}`);
      return { bytes: new Uint8Array([1, 2, 3]).buffer };
    },
    model: async (name) => {
      calls.push(`model:${name}`);
      return { bytes: new Uint8Array([4, 5]).buffer };
    },
    world: async (name) => {
      calls.push(`world:${name}`);
      return { bytes: new Uint8Array([6, 7]).buffer };
    },
    map: async (id) => ({
      map: id,
      bounds: [0, 0, 1, 1],
      areas: [],
      floors: [],
      tiles: [],
    }),
    catalog: async (kind) => {
      calls.push(`catalog:${kind}`);
      return { schema: 1, kind };
    },
    appearance: async () => ({
      recipe: { textures: [] },
      textures: [
        { pixels: new Uint8Array([8, 9]).buffer, width: 1, height: 1 },
      ],
    }),
    close: () => {
      calls.push("close");
    },
  };
  return { reader, calls };
}
test("Prepared bytes, catalogs, maps and appearance pixels survive closing and reopening the real IDB adapter", async () => {
  const factory = new IDBFactory(),
    f = fixture();
  const first = new IndexedClientAssetCache(factory, "converter-a");
  const source = await first.wrap(f.reader, () => assert.fail("live source"));
  await source.read("Fonts/test.ttf");
  await source.model("Model.m2");
  await source.world("Map.wmo");
  await source.map(409, "mc");
  await source.catalog("characters");
  await source.appearance({ sex: 0, race: 1 });
  assert.equal(await source.activate(), true);
  source.close();
  await first.close();
  const second = new IndexedClientAssetCache(factory, "converter-a");
  const restored = (await second.restore(() =>
    assert.fail("Every requested asset is cached"),
  ))!;
  assert.equal(restored.hasSource, false);
  assert.deepEqual(
    [...new Uint8Array((await restored.read("fonts\\TEST.ttf")).bytes)],
    [1, 2, 3],
  );
  assert.deepEqual(
    [...new Uint8Array((await restored.model("model.m2")).bytes)],
    [4, 5],
  );
  assert.deepEqual(
    [...new Uint8Array((await restored.world!("map.wmo")).bytes)],
    [6, 7],
  );
  assert.equal((await restored.map!(409, "mc")).map, 409);
  assert.equal((await restored.catalog("characters")).kind, "characters");
  assert.deepEqual(
    [
      ...new Uint8Array(
        (await restored.appearance({ race: 1, sex: 0 })).textures[0].pixels,
      ),
    ],
    [8, 9],
  );
  restored.close();
  await second.close();
});
test("An uncached request waits once and resumes against a matching selected client", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a"),
    f = fixture();
  const live = await cache.wrap(f.reader, () => {});
  await live.activate();
  live.close();
  let needed!: () => void;
  const prompt = new Promise<void>((r) => (needed = r));
  const restored = (await cache.restore(needed))!;
  const pending = restored.read("uncached.blp");
  await prompt;
  assert.equal(restored.needsSource, true);
  const next = fixture();
  restored.attach(next.reader);
  assert.deepEqual([...new Uint8Array((await pending).bytes)], [1, 2, 3]);
  assert.deepEqual(next.calls, ["read:uncached.blp"]);
  assert.equal(restored.needsSource, false);
  restored.close();
  await cache.close();
});
test("Different builds and converter revisions never provide each other's assets", async () => {
  const factory = new IDBFactory(),
    cache = new IndexedClientAssetCache(factory, "converter-a");
  const live = await cache.wrap(fixture().reader, () => {});
  await live.read("a.blp");
  await live.activate();
  live.close();
  const changedRevision = new IndexedClientAssetCache(factory, "converter-b");
  assert.equal(await changedRevision.restore(() => {}), null);
  let needed!: () => void;
  const prompt = new Promise<void>((r) => (needed = r));
  const restored = (await cache.restore(needed))!;
  const pending = restored.read("new.blp");
  await prompt;
  assert.throws(
    () => restored.attach(fixture("b".repeat(32)).reader),
    /different build/,
  );
  assert.equal(restored.hasSource, false);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  restored.close();
  await rejected;
  await cache.close();
  await changedRevision.close();
});
test("Only a confirmed missing resource is negative cached, while transient and partial results remain retryable", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a"),
    f = fixture();
  f.reader.read = async (resource) => {
    throw new DOMException(
      resource,
      resource === "missing.blp" ? "NotFoundError" : "EncryptedSectionError",
    );
  };
  f.reader.catalog = async () => ({ partial: true, rows: [] });
  const live = await cache.wrap(f.reader, () => {});
  await assert.rejects(live.read("missing.blp"), { name: "NotFoundError" });
  await assert.rejects(live.read("locked.blp"), {
    name: "EncryptedSectionError",
  });
  await live.catalog("talents");
  await live.activate();
  live.close();
  let needed!: () => void;
  const prompt = new Promise<void>((r) => (needed = r));
  const restored = (await cache.restore(needed))!;
  await assert.rejects(restored.read("missing.blp"), { name: "NotFoundError" });
  const pending = restored.read("locked.blp");
  const partial = restored.catalog("talents");
  await prompt;
  const next = fixture();
  restored.attach(next.reader);
  assert.equal((await partial).kind, "talents");
  await pending;
  restored.close();
  await cache.close();
});
test("A storage budget failure leaves the live reader working and does not advertise a complete cache", async () => {
  const cache = new IndexedClientAssetCache(
    new IDBFactory(),
    "converter-a",
    "small-cache",
    1,
  );
  const live = await cache.wrap(fixture().reader, () => {});
  assert.equal((await live.read("a.blp")).bytes.byteLength, 3);
  assert.equal(await live.activate(), false);
  assert.equal(await cache.restore(() => {}), null);
  live.close();
  await cache.close();
});
test("Clearing the asset cache invalidates pending sessions and preserves no active manifest", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  const live = await cache.wrap(fixture().reader, () => {});
  await live.read("a.blp");
  await live.activate();
  await cache.forget();
  await live.read("b.blp");
  assert.equal(await live.activate(), false);
  assert.equal(await cache.restore(() => {}), null);
  live.close();
  await cache.close();
});

test("A newly selected build whose assets cannot be saved never reopens an older build silently", async () => {
  const cache = new IndexedClientAssetCache(
    new IDBFactory(),
    "converter-a",
    "replacement-cache",
    512,
  );
  const first = await cache.wrap(fixture().reader, () => {});
  await first.read("small.blp");
  assert.equal(await first.activate(), true);
  first.close();
  const next = fixture("b".repeat(32));
  next.reader.read = async () => ({ bytes: new ArrayBuffer(1024) });
  const second = await cache.wrap(next.reader, () => {});
  await second.read("large.blp");
  assert.equal(await second.activate(), false);
  assert.equal(await cache.restore(() => {}), null);
  second.close();
  await cache.close();
});

test("Known converter capability limits retain their error classification without asking for the same game files again", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a"),
    f = fixture();
  f.reader.model = async () => {
    const error = new Error("Extended texture stages are unsupported");
    error.name = "ClientUnsupportedError";
    throw error;
  };
  const live = await cache.wrap(f.reader, () => {});
  await assert.rejects(live.model("id:146309"), {
    name: "ClientUnsupportedError",
  });
  await live.activate();
  live.close();
  const restored = (await cache.restore(() =>
    assert.fail(
      "A fixed converter limit cannot be solved by selecting the same source",
    ),
  ))!;
  await assert.rejects(restored.model("id:146309"), {
    name: "ClientUnsupportedError",
    message: "Extended texture stages are unsupported",
  });
  restored.close();
  await cache.close();
});

test("Attached sources reuse persisted assets without reading the installation twice", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  const f = fixture();
  const live = await cache.wrap(f.reader, () => assert.fail("live source"));
  await live.model("model.m2");
  await live.model("MODEL.m2");
  assert.deepEqual(f.calls, ["model:model.m2"]);
  live.close();
  await cache.close();
});

test("Background preparation waits for readiness, follows dependencies, and restores without a folder", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  const f = fixture();
  f.reader.catalog = async (kind) => {
    f.calls.push(`catalog:${kind}`);
    return kind === "creatures"
      ? { models: { 41: { fileDataID: 8 }, 42: { fileDataID: 9 } } }
      : {};
  };
  f.reader.model = async (name) => {
    f.calls.push(`model:${name}`);
    return { bytes: new TextEncoder().encode("\0__classic/10.blp\0").buffer };
  };
  f.reader.world = async (name) => {
    f.calls.push(`world:${name}`);
    return { bytes: new TextEncoder().encode("\0__classic/9.m2\0").buffer };
  };
  const live = await cache.wrap(f.reader, () => assert.fail("live source"));
  const abort = new AbortController();
  let ready = false,
    status = "";
  const work = live.prefetch({
    raids: [{ map: 409, directory: "mc" }],
    signal: abort.signal,
    ready: () => ready,
    progress: (value) => {
      status = value;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.calls.length, 0);
  await live.read("foreground.blp");
  ready = true;
  await work;
  assert.equal(f.calls[0], "read:foreground.blp");
  assert.ok(f.calls.includes("world:world/maps/mc/mc.wdt"));
  assert.ok(f.calls.includes("model:id:9"));
  assert.ok(f.calls.includes("read:id:10"));
  assert.ok(f.calls.indexOf("model:id:9") < f.calls.indexOf("model:id:8"));
  assert.match(status, /All supported/);
  await live.activate();
  live.close();
  const restored = (await cache.restore(() =>
    assert.fail("prefetched asset must be saved"),
  ))!;
  await restored.model("id:9");
  await restored.read("id:10");
  await restored.map(409, "mc");
  await restored.world("world/maps/mc/mc.wdt");
  restored.close();
  await cache.close();
});

test("Background preparation stops on cancellation and storage exhaustion", async () => {
  const cache = new IndexedClientAssetCache(
    new IDBFactory(),
    "converter-a",
    "small-prefetch",
    1,
  );
  const live = await cache.wrap(fixture().reader, () =>
    assert.fail("live source"),
  );
  let status = "";
  await live.prefetch({
    raids: [],
    signal: new AbortController().signal,
    ready: () => true,
    progress: (value) => {
      status = value;
    },
  });
  assert.match(status, /storage is full or unavailable/);
  const abort = new AbortController();
  const pending = live.prefetch({
    raids: [],
    signal: abort.signal,
    ready: () => false,
    progress: () => {},
  });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  live.close();
  await cache.close();
});

test("Foreground work blocks background queue advancement and shares an in-flight background asset", async () => {
  const cache = new IndexedClientAssetCache(new IDBFactory(), "converter-a");
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.reader.catalog = async (kind) => {
    f.calls.push(`catalog:${kind}`);
    if (kind === "world") {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return {};
  };
  const live = await cache.wrap(f.reader, () => assert.fail("live source"));
  const abort = new AbortController();
  const work = live.prefetch({
    raids: [],
    signal: abort.signal,
    ready: () => true,
    progress: () => {},
  });
  await waiting;
  const foreground = live.catalog("world");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.calls, ["catalog:world"]);
  release();
  await foreground;
  await work;
  assert.equal(f.calls.filter((call) => call === "catalog:world").length, 1);
  live.close();
  await cache.close();
});
