import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalClientFiles,
  LocalFileMissing,
  LocalFileNotReady,
  installLocalClientFiles,
} from "./local-client-files";

test("original synchronous readers see byte-exact prepared files using archive name rules", async () => {
  let reads = 0;
  const files = new LocalClientFiles(
    {
      read: async (name) => {
        reads++;
        assert.equal(name, "fonts/frizqt__.ttf");
        return new Uint8Array([0, 1, 255, 128, 0]);
      },
    },
    "client-a",
  );
  assert.throws(() => files.readSync("Fonts\\FRIZQT__.TTF"), LocalFileNotReady);
  assert.throws(
    () => files.containsSync("Fonts\\FRIZQT__.TTF"),
    LocalFileNotReady,
  );
  await files.prepare(["Fonts\\FRIZQT__.TTF"]);
  assert.equal(files.containsSync("FONTS/FRIZQT__.ttf"), true);
  assert.deepEqual(
    [...files.readSync("FONTS/FRIZQT__.ttf")],
    [0, 1, 255, 128, 0],
  );
  files.readSync("Fonts/Frizqt__.ttf")[0] = 99;
  assert.equal(files.readSync("fonts/frizqt__.ttf")[0], 0);
  assert.equal(reads, 1);
  assert.deepEqual(files.preparationMisses, []);
});

test("streams deduplicate concurrent loads without sharing mutable returned bytes", async () => {
  let reads = 0;
  const files = new LocalClientFiles(
    {
      read: async () => {
        reads++;
        return new Uint8Array([0, 255]);
      },
    },
    "client-a",
  );
  const [first, second] = await Promise.all([
    files.read("World/a.wmo"),
    files.read("world\\A.WMO"),
  ]);
  assert.equal(reads, 1);
  first[0] = 42;
  assert.deepEqual([...second], [0, 255]);
  assert.equal(files.preparedBytes, 2);
  assert.throws(() => files.listSync(), /complete local client name index/);
});

test("conversion and incomplete-download failures stay retryable instead of poisoning absence", async () => {
  let reads = 0;
  const files = new LocalClientFiles(
    {
      read: async () => {
        if (!reads++) throw new Error("Client bytes unavailable locally");
        return new Uint8Array([17]);
      },
    },
    "client-a",
  );
  await assert.rejects(files.read("creature/a.m2"), /unavailable/);
  assert.throws(() => files.containsSync("creature/a.m2"), LocalFileNotReady);
  await files.prepare(["creature/a.m2"]);
  assert.equal(files.containsSync("creature/a.m2"), true);
  assert.equal(reads, 2);
});

test("only explicit missing-file results become stable absence", async () => {
  let reads = 0;
  const files = new LocalClientFiles(
    {
      read: async (name) => {
        reads++;
        throw new LocalFileMissing(name);
      },
    },
    "client-a",
  );
  await assert.rejects(files.read("interface/nope.blp"), LocalFileMissing);
  assert.equal(files.containsSync("interface/nope.blp"), false);
  assert.throws(() => files.readSync("interface/nope.blp"), LocalFileMissing);
  await assert.rejects(files.read("interface/nope.blp"), LocalFileMissing);
  assert.equal(reads, 1);
});

test("client sessions are isolated and disposed reads cannot repopulate a closed cache", async () => {
  let release!: (bytes: Uint8Array) => void;
  const files = new LocalClientFiles(
    {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    "client-a",
  );
  const uninstall = installLocalClientFiles(files);
  assert.throws(() => installLocalClientFiles(files), /already installed/);
  const read = files.read("world/a.wmo");
  await Promise.resolve();
  uninstall();
  release(new Uint8Array([8]));
  await assert.rejects(read, /closed/);
  assert.equal(files.preparedBytes, 0);
  const next = new LocalClientFiles(
    { read: async () => new Uint8Array([9]) },
    "client-b",
  );
  const removeNext = installLocalClientFiles(next);
  await next.prepare(["world/a.wmo"]);
  assert.equal(next.readSync("world/a.wmo")[0], 9);
  removeNext();
});

test("bounded preparation and cancellation fail explicitly", async () => {
  let reads = 0;
  const files = new LocalClientFiles(
    {
      read: async () => {
        reads++;
        return new Uint8Array([1, 2]);
      },
    },
    "client-a",
    1,
  );
  await assert.rejects(files.prepare(["a.blp"]), /memory budget/);
  assert.equal(files.preparedBytes, 0);
  assert.throws(() => files.containsSync("a.blp"), LocalFileNotReady);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.prepare(["b.blp"], controller.signal), {
    name: "AbortError",
  });
  assert.equal(reads, 1);
  for (const name of ["../a", "x/../a", "a?b", "https://example.com", "a\0b"])
    await assert.rejects(
      files.read(name),
      /Invalid local client resource name/,
    );
  assert.equal(reads, 1);
});

test("async native asset streams do not consume the synchronous preparation budget", async () => {
  const files = new LocalClientFiles(
    {
      read: async (name) =>
        new Uint8Array(name.endsWith(".ttf") ? 2 : 8).fill(7),
    },
    "stream-client",
    4,
  );
  await files.prepare(["fonts/core.ttf"]);
  for (let i = 0; i < 32; i++)
    assert.equal((await files.readStreaming(`world/map-${i}.wmo`)).length, 8);
  assert.equal(files.preparedBytes, 2);
  assert.deepEqual([...files.readSync("fonts/core.ttf")], [7, 7]);
  assert.throws(() => files.readSync("world/map-31.wmo"), LocalFileNotReady);
  await assert.rejects(files.prepare(["world/map-31.wmo"]), /memory budget/);
  assert.equal(files.preparedBytes, 2);
});

test("streaming and explicit preparation share in-flight reads and preserve independent ownership", async () => {
  let reads = 0,
    release!: (value: Uint8Array) => void;
  const files = new LocalClientFiles(
    {
      read: () => {
        reads++;
        return new Promise((r) => (release = r));
      },
    },
    "stream-client",
    4,
  );
  const streamed = files.readStreaming("world/a.wmo"),
    prepared = files.read("WORLD/a.wmo");
  await Promise.resolve();
  release(new Uint8Array([1, 2]));
  const [a, b] = await Promise.all([streamed, prepared]);
  assert.equal(reads, 1);
  assert.equal(files.preparedBytes, 2);
  a[0] = 9;
  b[1] = 8;
  assert.deepEqual([...files.readSync("world/a.wmo")], [1, 2]);
  const pending = files.readStreaming("world/b.wmo");
  await Promise.resolve();
  files.close();
  release(new Uint8Array([3]));
  await assert.rejects(pending, /closed/);
  assert.equal(files.preparedBytes, 0);
});

test("the actual wasm bridge uses transient async reads and retains the older-provider fallback", async () => {
  const { readFileSync } = await import("node:fs");
  const rust = readFileSync(
    new URL(
      "../../../crates/benilla-formats/src/browser_local.rs",
      import.meta.url,
    ),
    "utf8",
  );
  const inline = rust.match(/inline_js = "([\s\S]*?)"\)\]/)?.[1];
  assert.ok(inline, "wasm inline transport must remain inspectable");
  const bind = new Function(
    "globalThis",
    inline.replaceAll("export function", "function") +
      ";return {localFileRead,localFileReadSync};",
  );
  const calls: string[] = [];
  const api = bind({
    __pullfiction_local_files: {
      readStreaming: async () => {
        calls.push("stream");
        return new Uint8Array([1]);
      },
      read: async () => {
        calls.push("retain");
        return new Uint8Array([2]);
      },
      readSync: () => new Uint8Array([3]),
    },
  });
  assert.deepEqual([...(await api.localFileRead("world/a.wmo"))], [1]);
  assert.deepEqual([...api.localFileReadSync("fonts/a.ttf")], [3]);
  const old = bind({
    __pullfiction_local_files: {
      read: async () => {
        calls.push("fallback");
        return new Uint8Array([4]);
      },
    },
  });
  assert.deepEqual([...(await old.localFileRead("world/a.wmo"))], [4]);
  assert.deepEqual(calls, ["stream", "fallback"]);
});

test("streamed invalid, unavailable and absent files preserve retry and absence semantics", async () => {
  let n = 0;
  const files = new LocalClientFiles(
    {
      read: async () => {
        n++;
        if (n === 1) return {} as any;
        if (n === 2) throw new Error("Temporary");
        if (n === 3) throw new LocalFileMissing("world/a.wmo");
        return new Uint8Array([1]);
      },
    },
    "stream-client",
  );
  await assert.rejects(
    files.readStreaming("world/a.wmo"),
    /Invalid local client bytes/,
  );
  await assert.rejects(files.readStreaming("world/a.wmo"), /Temporary/);
  await assert.rejects(files.readStreaming("world/a.wmo"), LocalFileMissing);
  await assert.rejects(files.readStreaming("world/a.wmo"), LocalFileMissing);
  assert.equal(n, 3);
  assert.equal(files.containsSync("world/a.wmo"), false);
  assert.equal(files.preparedBytes, 0);
});

test("cancelling one read lease preserves other consumers and the final lease aborts its source", async () => {
  const signals: AbortSignal[] = [];
  let resolve!: (bytes: Uint8Array) => void;
  const files = new LocalClientFiles(
    {
      read: (_name, signal) => {
        signals.push(signal!);
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    "leases",
  );
  const abort = new AbortController();
  const a = files.readStreaming("a.blp", abort.signal);
  const b = files.readStreaming("a.blp");
  await Promise.resolve();
  abort.abort();
  await assert.rejects(a, { name: "AbortError" });
  assert.equal(signals[0].aborted, false);
  resolve(new Uint8Array([7]));
  assert.deepEqual([...(await b)], [7]);
  const next = new AbortController();
  const c = files.read("a.blp", next.signal);
  await Promise.resolve();
  next.abort();
  await assert.rejects(c, { name: "AbortError" });
  assert.equal(signals[1].aborted, true);
  resolve(new Uint8Array([8]));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(files.preparedBytes, 0);
  // A source which ignores AbortSignal cannot poison a later retry or cache.
  const d = files.readStreaming("a.blp");
  await Promise.resolve();
  resolve(new Uint8Array([9]));
  assert.deepEqual([...(await d)], [9]);
  assert.equal(signals.length, 3);
});

test("source close aborts all underlying streaming leases", async () => {
  let sourceSignal!: AbortSignal;
  const files = new LocalClientFiles(
    {
      read: (_name, signal) => {
        sourceSignal = signal!;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () =>
            reject(new Error("closed source")),
          ),
        );
      },
    },
    "close",
  );
  const pending = files.readStreaming("a.blp");
  await Promise.resolve();
  files.close();
  assert.equal(sourceSignal.aborted, true);
  await assert.rejects(pending, /closed/);
});

test("closing a client promptly releases consumers even when its source ignores cancellation", async () => {
  let release!: (bytes: Uint8Array) => void;
  const files = new LocalClientFiles(
    {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    "ignores-abort",
  );
  const pending = files.read("a.blp");
  await Promise.resolve();
  files.close();
  await assert.rejects(pending, /closed/);
  release(new Uint8Array([1]));
  await Promise.resolve();
  assert.equal(files.preparedBytes, 0);
});
