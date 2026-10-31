import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalMapAssets,
  getLocalMaps,
  installLocalMaps,
  removeLocalMaps,
  localMapResource,
  mapAreaBounds,
  projectedFloor,
  localFloorHeight,
  resetLocalMaps,
  subscribeLocalMaps,
  type LocalMap,
  type MapImagePorts,
} from "./local-map";
import { mapPoint, mapScreen } from "./map-model";

function mapFixture(): LocalMap {
  return {
    map: 409,
    bounds: [-40, -20, -20, -10],
    areas: [
      { id: "room:0", name: "Lower floor", height: 5 },
      { id: "room:1", name: "Upper floor", height: 15 },
    ],
    tiles: [
      {
        resource: "id:10",
        area: "room:0",
        corners: [
          [20, 40],
          [20, 30],
          [10, 30],
          [10, 40],
        ],
      },
      {
        resource: "id:11",
        area: "room:0",
        corners: [
          [20, 30],
          [20, 20],
          [10, 20],
          [10, 30],
        ],
      },
    ],
    floors: [
      {
        area: "room:0",
        vertices: [
          [20, 40, 5],
          [20, 20, 5],
          [10, 20, 5],
          [20, 40, 7],
        ],
        indices: [0, 1, 2, 0, 1, 3],
      },
      {
        area: "room:1",
        vertices: [
          [18, 35, 15],
          [18, 25, 15],
          [12, 25, 15],
        ],
        indices: [0, 1, 2],
      },
    ],
  };
}
function fixture(map = mapFixture(), overrides: Partial<MapImagePorts> = {}) {
  const reads: string[] = [],
    created: string[] = [],
    revoked: string[] = [];
  const provider = {
    async map(mapId: number, directory: string) {
      assert.equal(mapId, 409);
      assert.equal(directory, "MoltenCore");
      return map;
    },
    async read(resource: string) {
      reads.push(resource);
      return new Uint8Array([Number(resource.slice(3))]);
    },
  };
  const assets = new LocalMapAssets(provider, {
    decode: async () => new Blob(),
    create: () => {
      const url = `blob:tile-${created.length}`;
      created.push(url);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
    ...overrides,
  });
  return { assets, provider, reads, created, revoked };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Local minimap references reject network URLs, absolute paths and traversal", () => {
  for (const path of [
    "https://example.org/map.blp",
    "//example.org/map.blp",
    "/maps/a.blp",
    "textures/../a.blp",
    "./a.blp",
    "a.blp?cache=1",
    "id:0",
    "id:4294967296",
  ])
    assert.throws(() => localMapResource(path), /Invalid local/);
  assert.equal(
    localMapResource("Textures\\Minimap\\local.blp"),
    "Textures/Minimap/local.blp",
  );
  assert.equal(localMapResource("id:4294967295"), "id:4294967295");
});

test("Local map preserves source image orientation, adjacent edges and WoW floor coordinates", async () => {
  const f = fixture();
  const lease = f.assets.load(409, "MoltenCore");
  const { manifest, missingTiles } = await lease.ready;
  assert.deepEqual(f.reads, ["id:10", "id:11"]);
  assert.equal(missingTiles, 0);
  assert.deepEqual(manifest.bounds, [-40, -20, -20, -10]);
  assert.deepEqual(manifest.tiles[0].corners[1], manifest.tiles[1].corners[0]);
  assert.deepEqual(manifest.tiles[0].corners[2], manifest.tiles[1].corners[3]);
  const camera = { x: -30, y: -15, scale: 2 };
  const [tl, tr, br, bl] = manifest.tiles[0].corners.map((point) =>
    mapScreen(mapPoint(...point), camera, 400, 300),
  );
  assert.ok(tl[0] < tr[0] && tl[1] === tr[1], "source U points right");
  assert.ok(bl[1] > tl[1] && br[1] > tr[1], "source V points down");
  assert.deepEqual(mapAreaBounds(manifest, "room:1"), [-35, -18, -25, -12]);
  const projected = projectedFloor(manifest.floors![0]);
  assert.deepEqual(projected.vertices[0], [-40, -20]);
  assert.deepEqual(projected.indices, [0, 1, 2], "vertical faces are excluded");
  assert.equal(
    manifest.floors![1].vertices[0][2],
    15,
    "floor height is retained",
  );
  lease.release();
  lease.release();
  assert.deepEqual(f.revoked, []);
  f.assets.dispose();
  assert.deepEqual(f.revoked, f.created);
});

test("Missing tile bytes retain real floor geometry and empty maps remain explicit errors", async () => {
  const map = mapFixture();
  map.tiles[0].resource = "https://example.org/map.blp";
  const f = fixture(map, {
    decode: async () => {
      throw new Error("missing texture");
    },
  });
  const lease = f.assets.load(409, "MoltenCore");
  const result = await lease.ready;
  assert.equal(result.manifest.tiles.length, 0);
  assert.equal(result.manifest.floors?.length, 2);
  assert.equal(result.missingTiles, 2);
  assert.deepEqual(f.reads, ["id:11"], "a URL never reaches the asset reader");
  lease.release();
  const empty = fixture({ ...mapFixture(), tiles: [], floors: [] });
  await assert.rejects(
    empty.assets.load(409, "MoltenCore").ready,
    /no usable raid/,
  );
});

test("Changing maps during metadata or texture decoding cannot publish stale blobs", async () => {
  const metadata = deferred<LocalMap>();
  let reads = 0;
  const assets = new LocalMapAssets({
    map: () => metadata.promise,
    read: async () => {
      reads++;
      return new Uint8Array();
    },
  });
  const pending = assets.load(409, "MoltenCore");
  pending.release();
  metadata.resolve(mapFixture());
  await assert.rejects(pending.ready, { name: "AbortError" });
  assert.equal(reads, 0);

  const decoded = deferred<Blob>(),
    entered = deferred<void>();
  const f = fixture(mapFixture(), {
    decode: async () => {
      entered.resolve();
      return decoded.promise;
    },
  });
  const abort = new AbortController();
  const lease = f.assets.load(409, "MoltenCore", abort.signal);
  await entered.promise;
  abort.abort();
  decoded.resolve(new Blob());
  await assert.rejects(lease.ready, { name: "AbortError" });
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.revoked, []);
});

test("Map release retains shared decoded tiles and client replacement invalidates the old generation", async () => {
  const f = fixture();
  const first = f.assets.load(409, "MoltenCore");
  await first.ready;
  const second = f.assets.load(409, "MoltenCore");
  await second.ready;
  first.release();
  assert.deepEqual(f.revoked, []);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.reads, ["id:10", "id:11"]);
  f.assets.dispose();
  assert.deepEqual(f.revoked, f.created);
  await assert.rejects(f.assets.load(409, "MoltenCore").ready, {
    name: "AbortError",
  });

  installLocalMaps(f.provider);
  const old = getLocalMaps()!;
  const next = fixture().provider;
  installLocalMaps(next);
  assert.notEqual(getLocalMaps(), old);
  removeLocalMaps(f.provider);
  assert.ok(
    getLocalMaps(),
    "removing an old client cannot remove its replacement",
  );
  await assert.rejects(old.load(409, "MoltenCore").ready, {
    name: "AbortError",
  });
  removeLocalMaps(next);
  assert.equal(getLocalMaps(), undefined);
});

test("Invalid floor indices and mismatched map responses fail before decoding", async () => {
  for (const invalid of [
    { ...mapFixture(), map: 533 },
    {
      ...mapFixture(),
      floors: [{ ...mapFixture().floors[0], indices: [0, 1, 100] }],
    },
    {
      ...mapFixture(),
      bounds: [0, 0, Infinity, 10] as [number, number, number, number],
    },
  ]) {
    const f = fixture(invalid);
    await assert.rejects(
      f.assets.load(409, "MoltenCore").ready,
      /Invalid local tactical map/,
    );
    assert.deepEqual(f.reads, []);
  }
});

test("Map edits use the actual triangle height and preserve a chosen stacked floor", () => {
  const map = { ...mapFixture(), tiles: [] };
  map.floors[0].vertices[2][2] = 10;
  assert.equal(localFloorHeight(map, 16, 30, "room:0"), 7);
  assert.equal(localFloorHeight(map, 16, 30, "room:1"), 15);
  assert.equal(localFloorHeight(map, 16, 30, "*", 14), 15);
  assert.equal(localFloorHeight(map, 16, 30, "*", 6), 7);
  assert.equal(localFloorHeight(map, 1000, 1000, "room:0"), undefined);
});

test("Warm mounts reuse manifest, every floor and decoded URLs without reading metadata or tiles", async () => {
  let metadata = 0,
    decoded = 0;
  const f = fixture(mapFixture(), {
    decode: async () => {
      decoded++;
      return new Blob();
    },
  });
  const original = f.provider.map;
  f.provider.map = async (...args) => {
    metadata++;
    return original(...args);
  };
  const first = f.assets.load(409, "MoltenCore");
  const result = await first.ready;
  first.release();
  const warm = f.assets.load(409, "moltencore");
  assert.equal(await warm.ready, result);
  assert.equal(metadata, 1);
  assert.equal(decoded, 2);
  assert.equal(
    localFloorHeight((await warm.ready).manifest, 16, 30, "room:1"),
    15,
  );
  warm.release();
  f.assets.dispose();
  assert.deepEqual(f.revoked, f.created);
});

test("Concurrent consumers share a pending map and releasing one does not cancel the other", async () => {
  const metadata = deferred<LocalMap>();
  let calls = 0;
  const f = fixture();
  f.provider.map = async () => {
    calls++;
    return metadata.promise;
  };
  const first = f.assets.load(409, "MoltenCore"),
    second = f.assets.load(409, "MoltenCore");
  const rejected = assert.rejects(first.ready, { name: "AbortError" });
  first.release();
  metadata.resolve(mapFixture());
  await rejected;
  assert.equal((await second.ready).manifest.tiles.length, 2);
  assert.equal(calls, 1);
  second.release();
  f.assets.dispose();
});

test("Incomplete tile results retry on next mount instead of freezing missing images", async () => {
  let missing = true;
  const f = fixture(mapFixture(), {
    decode: async () => {
      if (missing) throw Error("locked");
      return new Blob();
    },
  });
  const first = f.assets.load(409, "MoltenCore");
  assert.equal((await first.ready).missingTiles, 2);
  first.release();
  missing = false;
  const retry = f.assets.load(409, "MoltenCore");
  assert.equal((await retry.ready).missingTiles, 0);
  assert.equal(f.reads.length, 4);
  retry.release();
  f.assets.dispose();
});

test("Idle LRU isolates raid directories, protects active leases and bounds retained bytes", async () => {
  const revoked: string[] = [];
  let id = 0,
    metadata = 0;
  const provider = {
    map: async (map: number) => {
      metadata++;
      return { ...mapFixture(), map };
    },
    read: async () => {
      const bytes = new Uint8Array(20),
        header = new DataView(bytes.buffer);
      bytes.set(new TextEncoder().encode("BLP2"));
      header.setUint32(12, 256, true);
      header.setUint32(16, 256, true);
      return bytes;
    },
  };
  const ports = {
    decode: async () => new Blob([new Uint8Array(1024)]),
    create: () => `blob:${id++}`,
    revoke: (url: string) => revoked.push(url),
  };
  const cache = new LocalMapAssets(provider, ports, 1, 128 * 1024 * 1024);
  const active = cache.load(409, "one");
  await active.ready;
  const second = cache.load(533, "two");
  await second.ready;
  second.release();
  const third = cache.load(409, "different-directory");
  await third.ready;
  third.release();
  assert.equal(metadata, 3);
  assert.equal(revoked.length, 2, "only the idle old raid is evicted");
  const same = cache.load(409, "one");
  await same.ready;
  same.release();
  assert.equal(metadata, 3, "active map survives eviction");
  active.release();
  cache.dispose();
  assert.equal(revoked.length, id);
  const tiny = new LocalMapAssets(provider, ports, 2, 400_000);
  const overBudget = tiny.load(409, "one");
  await overBudget.ready;
  overBudget.release();
  const before = metadata;
  const retried = tiny.load(409, "one");
  await retried.ready;
  assert.equal(metadata, before + 1, "oversized idle maps are evicted");
  retried.release();
  tiny.dispose();
});

test("Explicit cache clear invalidates decoded maps and notifies mounted consumers", async () => {
  const f = fixture();
  installLocalMaps(f.provider);
  const old = getLocalMaps()!;
  const lease = old.load(409, "MoltenCore");
  await lease.ready;
  let notifications = 0;
  const unsubscribe = subscribeLocalMaps(() => {
    notifications++;
  });
  resetLocalMaps();
  assert.equal(notifications, 1);
  unsubscribe();
  lease.release();
  assert.notEqual(getLocalMaps(), old);
  await assert.rejects(old.load(409, "MoltenCore").ready, {
    name: "AbortError",
  });
  const next = getLocalMaps()!.load(409, "MoltenCore");
  await next.ready;
  assert.equal(f.reads.length, 4);
  next.release();
  removeLocalMaps(f.provider);
});
