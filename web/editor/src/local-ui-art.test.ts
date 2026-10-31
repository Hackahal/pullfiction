import test from "node:test";
import assert from "node:assert/strict";
import {
  installLocalUiArt,
  getLocalUiArt,
  subscribeLocalUiArt,
  type LocalUiArtPorts,
} from "./local-ui-art";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(name: string, changes: Partial<LocalUiArtPorts> = {}) {
  const reads: string[] = [],
    added: FontFace[] = [],
    removed: FontFace[] = [],
    urls: string[] = [],
    revoked: string[] = [],
    css: (string | undefined)[] = [];
  const face = { load: async () => face } as unknown as FontFace;
  const files = {
    readSync(resource: string) {
      reads.push(resource);
      return new Uint8Array([reads.length]);
    },
  };
  const ports: LocalUiArtPorts = {
    font: () => face,
    addFont: (face) => {
      added.push(face);
    },
    removeFont: (face) => {
      removed.push(face);
    },
    decode: async (bytes) => new Blob([Uint8Array.from(bytes)]),
    create: () => {
      const url = `blob:${name}-${urls.length}`;
      urls.push(url);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
    raidAtlas: (url) => {
      css.push(url);
    },
    ...changes,
  };
  return { files, ports, reads, added, removed, urls, revoked, css };
}

test("Local UI art publishes the original atlas aliases and releases each font/blob once", async () => {
  const f = fixture("first");
  let updates = 0;
  const unsubscribe = subscribeLocalUiArt(() => updates++);
  const release = await installLocalUiArt(f.files, f.ports);
  try {
    assert.deepEqual(f.reads, [
      "Fonts/FRIZQT__.TTF",
      "Interface/GLUES/CHARACTERCREATE/UI-CHARACTERCREATE-CLASSES.blp",
      "Interface/TargetingFrame/UI-RaidTargetingIcons.blp",
    ]);
    assert.equal(
      getLocalUiArt()?.get("/game-ui/class-icons.png"),
      "blob:first-0",
    );
    assert.equal(
      getLocalUiArt()?.get("/game-ui/raid-icons.png"),
      "blob:first-1",
    );
    assert.deepEqual(f.css, ["blob:first-1"]);
    assert.equal(f.added.length, 1);
    assert.equal(updates, 1);
    release();
    release();
    assert.equal(getLocalUiArt(), undefined);
    assert.deepEqual(f.revoked, ["blob:first-0", "blob:first-1"]);
    assert.equal(f.removed.length, 1);
    assert.deepEqual(f.css, ["blob:first-1", undefined]);
    assert.equal(updates, 2);
  } finally {
    release();
    unsubscribe();
  }
});

test("Replacing the client revokes old art without letting its cleanup remove the new aliases", async () => {
  const a = fixture("old"),
    b = fixture("new");
  const releaseA = await installLocalUiArt(a.files, a.ports);
  const releaseB = await installLocalUiArt(b.files, b.ports);
  try {
    releaseA();
    assert.equal(
      getLocalUiArt()?.get("/game-ui/class-icons.png"),
      "blob:new-0",
    );
    assert.deepEqual(a.revoked, ["blob:old-0", "blob:old-1"]);
    assert.deepEqual(b.revoked, []);
    assert.deepEqual(b.css, ["blob:new-1"]);
  } finally {
    releaseA();
    releaseB();
  }
});

test("An older pending decode cannot publish art after a newer client is installed", async () => {
  const wait = deferred<Blob>();
  const a = fixture("late", { decode: () => wait.promise }),
    b = fixture("current");
  const pending = installLocalUiArt(a.files, a.ports);
  await Promise.resolve();
  const releaseB = await installLocalUiArt(b.files, b.ports);
  wait.resolve(new Blob());
  const releaseA = await pending;
  try {
    assert.equal(
      getLocalUiArt()?.get("/game-ui/raid-icons.png"),
      "blob:current-1",
    );
    assert.deepEqual(a.urls, []);
    assert.deepEqual(a.added, []);
    releaseA();
    assert.equal(
      getLocalUiArt()?.get("/game-ui/raid-icons.png"),
      "blob:current-1",
    );
  } finally {
    releaseA();
    releaseB();
  }
});

test("Failed preparation leaves current art installed and leaks no new blobs or fonts", async () => {
  const a = fixture("held"),
    b = fixture("failed", {
      decode: async () => {
        throw new Error("BLP decode failed");
      },
    });
  const release = await installLocalUiArt(a.files, a.ports);
  try {
    await assert.rejects(
      installLocalUiArt(b.files, b.ports),
      /BLP decode failed/,
    );
    assert.equal(
      getLocalUiArt()?.get("/game-ui/class-icons.png"),
      "blob:held-0",
    );
    assert.deepEqual(b.urls, []);
    assert.deepEqual(b.added, []);
  } finally {
    release();
  }
});

test("Partial blob allocation is revoked when preparation cannot finish", async () => {
  let count = 0;
  const f = fixture("partial", {
    create: () => {
      if (count++) throw new Error("allocation failed");
      return "blob:partial";
    },
  });
  await assert.rejects(
    installLocalUiArt(f.files, f.ports),
    /allocation failed/,
  );
  assert.deepEqual(f.revoked, ["blob:partial"]);
  assert.deepEqual(f.added, []);
  assert.equal(getLocalUiArt(), undefined);
});
