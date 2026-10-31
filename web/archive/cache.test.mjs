import test from "node:test";
import assert from "node:assert/strict";
import { assetCache, cachedAsset } from "./cache.mjs";
const build = {
  product: "wow_classic_era",
  version: "1.15.9.70003",
  buildKey: "a".repeat(32),
};

function storageFixture() {
  const files = new Map();
  function directory(prefix) {
    return {
      async getDirectoryHandle(name) {
        return directory(`${prefix}/${name}`);
      },
      async getFileHandle(name, { create = false } = {}) {
        const path = `${prefix}/${name}`;
        if (!create && !files.has(path))
          throw new DOMException("Missing", "NotFoundError");
        return {
          async getFile() {
            return new Blob([files.get(path)]);
          },
          async createWritable() {
            let bytes;
            return {
              async write(value) {
                bytes = value.slice();
              },
              async close() {
                files.set(path, bytes);
              },
              async abort() {},
            };
          },
          async move(newName) {
            files.set(`${prefix}/${newName}`, files.get(path));
            files.delete(path);
          },
        };
      },
      async removeEntry(name) {
        files.delete(`${prefix}/${name}`);
      },
      async *entries() {
        for (const path of files.keys())
          if (path.startsWith(prefix + "/"))
            yield [path.slice(prefix.length + 1), {}];
      },
    };
  }
  return {
    files,
    storage: {
      async getDirectory() {
        return directory("");
      },
    },
  };
}

test("converted assets persist across cache instances without mixing client builds", async () => {
  const { storage } = storageFixture();
  const first = await assetCache(build, "v1", storage);
  assert.equal(await first.get("id:123"), null);
  assert.equal(await first.put("id:123", new Uint8Array([1, 2, 3])), true);
  const second = await assetCache(build, "v1", storage);
  assert.deepEqual(await second.get("id:123"), new Uint8Array([1, 2, 3]));
  const other = await assetCache(
    { ...build, buildKey: "b".repeat(32) },
    "v1",
    storage,
  );
  assert.equal(await other.get("id:123"), null);
  assert.equal(
    await (await assetCache(build, "v2", storage)).get("id:123"),
    null,
  );
});

test("a damaged or incomplete local cache entry is never accepted as an asset", async () => {
  const { storage, files } = storageFixture(),
    cache = await assetCache(build, "v1", storage);
  await cache.put("id:123", new Uint8Array([1, 2, 3]));
  const key = [...files.keys()][0];
  files.get(key)[37] ^= 0xff;
  assert.equal(await cache.get("id:123"), null);
  files.set(key, new Uint8Array([1, 2]));
  assert.equal(await cache.get("id:123"), null);
});

test("clear only removes the selected build's local converted cache", async () => {
  const { storage } = storageFixture(),
    first = await assetCache(build, "v1", storage),
    second = await assetCache(build, "v2", storage);
  await first.put("id:123", new Uint8Array([1]));
  await second.put("id:123", new Uint8Array([2]));
  await first.clear();
  assert.equal(await first.get("id:123"), null);
  assert.deepEqual(await second.get("id:123"), new Uint8Array([2]));
});

test("unsupported browser storage is optional", async () => {
  assert.equal(await assetCache(build, "v1", {}), null);
});

test("unreadable or unwritable optional cache still loads the actual client model", async () => {
  let conversions = 0;
  const bytes = new Uint8Array([1, 2, 3]);
  const failing = {
    async get() {
      throw new DOMException("Unavailable", "NotReadableError");
    },
    async put() {
      throw new DOMException("Full", "QuotaExceededError");
    },
  };
  const result = await cachedAsset(failing, "id:123", () => {
    conversions++;
    return bytes;
  });
  assert.deepEqual(result, { bytes, cached: false });
  assert.equal(conversions, 1);
  const hit = await cachedAsset(
    {
      async get() {
        return bytes;
      },
    },
    "id:123",
    () => {
      throw new Error("Must not reconvert");
    },
  );
  assert.deepEqual(hit, { bytes, cached: true });
});
