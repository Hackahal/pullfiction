import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalIconCache,
  recordedIconResource,
  decodeLocalIcon,
  installLocalIcons,
  removeLocalIcons,
  getLocalIcons,
  subscribeLocalIcons,
} from "./local-icons";

function fixture(idleLimit = 128) {
  const reads: string[] = [],
    decodes: number[] = [],
    created: string[] = [],
    revoked: string[] = [],
    catalogs: string[] = [];
  const provider = {
    async read(resource: string) {
      reads.push(resource);
      if (resource === "id:404") throw new Error("Missing client icon");
      return new Uint8Array([reads.length]);
    },
    async catalog(kind: string) {
      catalogs.push(kind);
      return {
        [kind]: {
          133: { iconFile: 9001 },
          7: { iconFile: 9001 },
          404: { iconFile: 404 },
        },
      };
    },
  };
  const cache = new LocalIconCache(
    provider,
    {
      async decode(bytes) {
        decodes.push(bytes[0]);
        return new Blob([Uint8Array.from(bytes)]);
      },
      create() {
        const url = `blob:local-${created.length}`;
        created.push(url);
        return url;
      },
      revoke(url) {
        revoked.push(url);
      },
    },
    idleLimit,
  );
  return { cache, provider, reads, decodes, created, revoked, catalogs };
}

test("Recorded icon names resolve only inside selected client storage", () => {
  assert.equal(
    recordedIconResource("Spell_Fire_Flamebolt.jpg"),
    "interface/icons/spell_fire_flamebolt.blp",
  );
  assert.equal(
    recordedIconResource("Interface\\Icons\\inv_helmet_52.blp"),
    "interface/icons/inv_helmet_52.blp",
  );
  assert.equal(recordedIconResource("id:135846"), "id:135846");
  for (const unsafe of [
    "https://cdn.example/icon.jpg",
    "../icon.blp",
    "/game-ui/icon.png",
    "interface/../icon.blp",
    "id:0",
    "id:4294967296",
    "spell?x=1",
    "a\u0000b",
  ])
    assert.equal(recordedIconResource(unsafe), undefined);
});

test("Icon cache is selective and shares a single local read/decode/blob across spell and item metadata", async () => {
  const f = fixture();
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.catalogs, []);
  const a = f.cache.acquire({ spell: 133, icon: "spell_fire_flamebolt.jpg" });
  const b = f.cache.acquire({ item: 7, icon: "inv_helmet_52" });
  assert.deepEqual(await Promise.all([a.url, b.url]), [
    "blob:local-0",
    "blob:local-0",
  ]);
  assert.deepEqual(f.reads, ["id:9001"]);
  assert.equal(f.decodes.length, 1);
  a.release();
  b.release();
  const again = f.cache.acquire({ spell: 133 });
  assert.equal(await again.url, "blob:local-0");
  assert.equal(f.reads.length, 1);
  again.release();
  f.cache.dispose();
  assert.deepEqual(f.revoked, ["blob:local-0"]);
});

test("Missing metadata icons fall back to recorded local paths and failures do not reread every frame", async () => {
  const f = fixture();
  const a = f.cache.acquire({ spell: 404, icon: "spell_fire_flamebolt" });
  assert.equal(await a.url, "blob:local-0");
  a.release();
  const b = f.cache.acquire({ spell: 404, icon: "spell_fire_flamebolt" });
  await b.url;
  assert.deepEqual(f.reads, [
    "id:404",
    "interface/icons/spell_fire_flamebolt.blp",
  ]);
  b.release();
  const unknown = f.cache.acquire({ icon: "https://remote.example/icon.png" });
  assert.equal(await unknown.url, undefined);
  unknown.release();
  f.cache.dispose();
});

test("Idle URLs are bounded, mounted consumers keep their URLs, and disposal revokes the remainder", async () => {
  const f = fixture(1);
  const held = f.cache.acquire({ iconFile: 1 });
  const idle = f.cache.acquire({ iconFile: 2 });
  await Promise.all([held.url, idle.url]);
  idle.release();
  const newer = f.cache.acquire({ iconFile: 3 });
  await newer.url;
  newer.release();
  assert.deepEqual(f.revoked, ["blob:local-1"]);
  assert.equal(await held.url, "blob:local-0");
  held.release();
  f.cache.dispose();
  f.cache.dispose();
  assert.equal(new Set(f.revoked).size, 3);
  assert.equal(f.revoked.length, 3);
});

test("Provider removal during an icon read prevents late blob allocation", async () => {
  let read!: (bytes: Uint8Array) => void;
  let created = 0,
    decoded = 0;
  const provider = {
    read: () =>
      new Promise<Uint8Array>((resolve) => {
        read = resolve;
      }),
    catalog: async () => ({}),
  };
  const cache = new LocalIconCache(provider, {
    decode: async () => {
      decoded++;
      return new Blob();
    },
    create: () => {
      created++;
      return "blob:late";
    },
    revoke: () => {},
  });
  const lease = cache.acquire({ iconFile: 1 });
  await Promise.resolve();
  cache.dispose();
  read(new Uint8Array([1]));
  assert.equal(await lease.url, undefined);
  assert.equal(created, 0);
  assert.equal(decoded, 0);
  lease.release();
});

test("Switching selected clients replaces the icon cache and notifies mounted consumers", () => {
  const a = fixture(),
    b = fixture();
  let changes = 0;
  const unsubscribe = subscribeLocalIcons(() => {
    changes++;
  });
  installLocalIcons(a.provider);
  const first = getLocalIcons();
  installLocalIcons(a.provider);
  assert.equal(getLocalIcons(), first);
  installLocalIcons(b.provider);
  assert.notEqual(getLocalIcons(), first);
  removeLocalIcons(a.provider);
  assert.ok(getLocalIcons());
  removeLocalIcons(b.provider);
  assert.equal(getLocalIcons(), undefined);
  assert.equal(changes, 3);
  unsubscribe();
  a.cache.dispose();
  b.cache.dispose();
});

test("Oversized or invalid icon textures are rejected before codec startup", async () => {
  await assert.rejects(
    decodeLocalIcon(new Uint8Array(4 * 1024 * 1024 + 1)),
    /limit/,
  );
  await assert.rejects(
    decodeLocalIcon(new Uint8Array([0])),
    /Invalid local icon/,
  );
  const bytes = new Uint8Array(20);
  bytes.set(new TextEncoder().encode("BLP2"));
  const header = new DataView(bytes.buffer);
  header.setUint32(12, 4096, true);
  header.setUint32(16, 4096, true);
  await assert.rejects(decodeLocalIcon(bytes), /dimensions/);
});

test("Evicting an abandoned pending icon cannot allocate an untracked blob later", async () => {
  let read!: (bytes: Uint8Array) => void;
  let created = 0;
  const provider = {
    read: () =>
      new Promise<Uint8Array>((resolve) => {
        read = resolve;
      }),
    catalog: async () => ({}),
  };
  const cache = new LocalIconCache(
    provider,
    {
      decode: async () => new Blob(),
      create: () => {
        created++;
        return "blob:orphan";
      },
      revoke: () => {},
    },
    0,
  );
  const lease = cache.acquire({ iconFile: 1 });
  await Promise.resolve();
  lease.release();
  read(new Uint8Array([1]));
  assert.equal(await lease.url, undefined);
  assert.equal(created, 0);
  cache.dispose();
});
