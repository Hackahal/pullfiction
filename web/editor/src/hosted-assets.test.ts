import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  openHostedAssets,
  validateHostedManifest,
  type HostedManifest,
} from "./hosted-assets";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const raws = [new Uint8Array([9, 1, 2]), new Uint8Array([3, 4, 9])];
  const zipped = raws.map((raw) => new Uint8Array(gzipSync(raw)));
  const hashes = zipped.map(sha);
  const manifest: HostedManifest = {
    schema: 1,
    revision: "a".repeat(64),
    build: {
      product: "wow_classic_era",
      version: "1.15.9",
      buildKey: "b".repeat(32),
    },
    chunks: Object.fromEntries(
      hashes.map((h, i) => [
        h,
        { bytes: zipped[i].length, rawBytes: raws[i].length },
      ]),
    ),
    files: {
      "read:fonts/a.ttf": {
        parts: hashes.map((h, i) => ({
          chunk: h,
          offset: i === 0 ? 1 : 0,
          length: 2,
        })),
        bytes: 4,
        sha256: sha(new Uint8Array([1, 2, 3, 4])),
      },
    },
    appearanceInputs: [],
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/manifest.json") return Response.json(manifest);
    const index = hashes.findIndex((h) => path.includes(h));
    return index < 0
      ? new Response(null, { status: 404 })
      : new Response(zipped[index]);
  };
  return { manifest, calls, fetcher, zipped, hashes };
}
test("multipart reads verify slices, normalize names and deduplicate concurrent chunk requests", async () => {
  const f = fixture();
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache: null,
  });
  const results = await Promise.all([
    reader.read("Fonts\\A.ttf"),
    reader.read("fonts/a.ttf"),
  ]);
  assert.deepEqual([...new Uint8Array(results[0].bytes)], [1, 2, 3, 4]);
  assert.equal(f.calls.length, 3);
  await reader.read("fonts/a.ttf");
  assert.equal(f.calls.length, 3);
  await assert.rejects(reader.read("missing"), { name: "NotFoundError" });
  reader.close();
  await assert.rejects(reader.read("fonts/a.ttf"), { name: "AbortError" });
});
test("corrupt persistent chunks are discarded and verified downloads replace them", async () => {
  const f = fixture(),
    saved = new Map<string, Response>();
  let deletes = 0;
  const cache = {
    async match(key: RequestInfo | URL) {
      return saved.get(String(key))?.clone();
    },
    async put(key: RequestInfo | URL, response: Response) {
      saved.set(String(key), response);
    },
    async delete(key: RequestInfo | URL) {
      deletes++;
      return saved.delete(String(key));
    },
  };
  saved.set(
    `https://assets.example/chunks/${f.hashes[0]}.bin.gz`,
    new Response("corrupt"),
  );
  let reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache,
    memoryBytes: 0,
  });
  await reader.read("fonts/a.ttf");
  assert.equal(deletes, 1);
  reader.close();
  const count = f.calls.length;
  reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache,
  });
  await reader.read("fonts/a.ttf");
  assert.equal(f.calls.length, count + 1);
  reader.close();
});
test("transient network errors retry while integrity failures can recover on a later call", async () => {
  const f = fixture();
  let transient = true,
    corrupt = true;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).includes(f.hashes[0])) {
      if (transient) {
        transient = false;
        return new Response(null, { status: 503 });
      }
      if (corrupt) {
        corrupt = false;
        return new Response(new Uint8Array(f.zipped[0].length));
      }
    }
    return f.fetcher(url, options);
  };
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: fetcher,
    cache: null,
  });
  await assert.rejects(reader.read("fonts/a.ttf"), /integrity/);
  assert.deepEqual(
    [...new Uint8Array((await reader.read("fonts/a.ttf")).bytes)],
    [1, 2, 3, 4],
  );
  reader.close();
});
test("manifest bounds, appearance closure, resource hashes and origin policy fail closed", async () => {
  const f = fixture();
  const bounds = structuredClone(f.manifest);
  bounds.files["read:fonts/a.ttf"].parts[0].offset = 9;
  assert.throws(() => validateHostedManifest(bounds), /bounds/);
  const closure = structuredClone(f.manifest);
  closure.appearanceInputs = ["read:absent"];
  assert.throws(() => validateHostedManifest(closure), /closure/);
  await assert.rejects(
    openHostedAssets("http://assets.example", undefined, { fetch: f.fetcher }),
    /HTTPS/,
  );
  await assert.rejects(
    openHostedAssets("http://localhost:1234", undefined, { fetch: f.fetcher }),
    /HTTPS/,
  );
  f.manifest.files["read:fonts/a.ttf"].sha256 = "0".repeat(64);
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache: null,
  });
  await assert.rejects(reader.read("fonts/a.ttf"), /resource integrity/);
  reader.close();
});
test("abort cancels in-flight requests and does not become a missing resource", async () => {
  const f = fixture(),
    controller = new AbortController();
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).includes("manifest.json")) return f.fetcher(url, options);
    return new Promise((_resolve, reject) =>
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason),
        { once: true },
      ),
    );
  };
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: fetcher,
    cache: null,
    signal: controller.signal,
  });
  const pending = reader.read("fonts/a.ttf");
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  reader.close();
});

test("canonical model aliases resolve while catalog objects need no kind field", async () => {
  const f = fixture();
  const entry = f.manifest.files["read:fonts/a.ttf"];
  f.manifest.files["model:id:42"] = entry;
  f.manifest.aliases = { "character/test.m2": "id:42" };
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache: null,
  });
  assert.deepEqual(
    [...new Uint8Array((await reader.model("Character/Test.m2")).bytes)],
    [1, 2, 3, 4],
  );
  reader.close();
});

test("null parts, inherited chunk IDs and noncanonical names are rejected", () => {
  const f = fixture();
  for (const part of [null, { chunk: "__proto__", offset: 0, length: 4 }]) {
    const m = structuredClone(f.manifest);
    (m.files["read:fonts/a.ttf"].parts as unknown[]) = [part];
    assert.throws(() => validateHostedManifest(m), /bounds/);
  }
  const m = structuredClone(f.manifest);
  m.files["read:../bad"] = m.files["read:fonts/a.ttf"];
  assert.throws(() => validateHostedManifest(m), /resource/);
  assert.throws(() => validateHostedManifest(null), /manifest/);
});

test("decompression rejects declared raw lengths that are smaller or larger than output", async () => {
  for (const rawBytes of [2, 4]) {
    const f = fixture();
    f.manifest.chunks[f.hashes[0]].rawBytes = rawBytes;
    f.manifest.files["read:fonts/a.ttf"].parts[0] = {
      chunk: f.hashes[0],
      offset: 0,
      length: 2,
    };
    const reader = await openHostedAssets("https://assets.example", undefined, {
      fetch: f.fetcher,
      cache: null,
    });
    await assert.rejects(reader.read("fonts/a.ttf"), /decompressed length/);
    reader.close();
  }
});

test("world paths retain legitimate directory spaces", async () => {
  const f = fixture();
  f.manifest.files["world:world/maps/stratholme raid/stratholme raid.wdt"] =
    f.manifest.files["read:fonts/a.ttf"];
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: f.fetcher,
    cache: null,
  });
  assert.deepEqual(
    [
      ...new Uint8Array(
        (await reader.world!("World/Maps/Stratholme Raid/Stratholme Raid.wdt"))
          .bytes,
      ),
    ],
    [1, 2, 3, 4],
  );
  reader.close();
});

test("appearance preloads sync inputs, reads dynamic textures asynchronously and serializes calls after failure", async () => {
  const { hostedAppearance } =
    await import("../../archive/hosted-appearance.mjs");
  const calls: string[] = [];
  let active = 0,
    peak = 0;
  const prepare = hostedAppearance(
    async (key: string) => {
      calls.push(key);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Uint8Array([1, 2]);
    },
    ["read:dbfilesclient/test.db2"],
    { product: "test", version: "1", buildKey: "a" },
    () => {},
    {
      converter: async (read: (key: string) => Uint8Array) => ({
        appearance(request: Record<string, unknown>) {
          if (request.missing) read("unprepared");
          assert.deepEqual([...read("DBFilesClient\\test.db2")], [1, 2]);
          return {
            textures: [{ type: 1, composite: false, layers: [{ file: 42 }] }],
          };
        },
      }),
      codec: async () => ({
        default: async () => {},
        decode_texture() {
          active++;
          peak = Math.max(peak, active);
          return {
            width: 1,
            height: 1,
            pixels: () => new Uint8Array([1, 2, 3, 4]),
            free() {
              active--;
            },
          };
        },
      }),
    },
  );
  await assert.rejects(prepare({ missing: true }), { name: "NotReadyError" });
  const results = await Promise.all([prepare({}), prepare({})]);
  assert.equal(results.length, 2);
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["dbfilesclient/test.db2", "id:42", "id:42"]);
  assert.deepEqual(
    [...new Uint8Array(results[0].textures[0].pixels)],
    [1, 2, 3, 4],
  );
});

test("response body connection resets share request retry budget and recover after exhaustion", async () => {
  const f = fixture();
  let requests = 0,
    failures = 1;
  const fetcher: typeof fetch = async (url, options) => {
    if (!String(url).includes(f.hashes[0])) return f.fetcher(url, options);
    requests++;
    if (failures-- > 0)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(f.zipped[0].slice(0, 2));
            controller.error(new TypeError("Connection reset"));
          },
        }),
      );
    return f.fetcher(url, options);
  };
  let reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: fetcher,
    cache: null,
    retries: 1,
  });
  await reader.read("fonts/a.ttf");
  assert.equal(requests, 2);
  reader.close();
  requests = 0;
  failures = 2;
  reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: fetcher,
    cache: null,
    retries: 1,
  });
  await assert.rejects(reader.read("fonts/a.ttf"), /Connection reset/);
  assert.equal(requests, 2);
  await reader.read("fonts/a.ttf");
  assert.equal(requests, 3);
  reader.close();
});

test("oversized response bodies fail without retry and unsupported resources retain explicit classification", async () => {
  const f = fixture();
  let requests = 0;
  f.manifest.unsupported = {
    "id:88": {
      status: "unsupported",
      reason: "Unimplemented model section",
      references: [],
    },
  };
  f.manifest.aliases = { "character/unsupported.m2": "id:88" };
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).includes(f.hashes[0])) {
      requests++;
      return new Response(new Uint8Array(f.zipped[0].length + 1));
    }
    return f.fetcher(url, options);
  };
  const reader = await openHostedAssets("https://assets.example", undefined, {
    fetch: fetcher,
    cache: null,
  });
  await assert.rejects(reader.read("fonts/a.ttf"), /integrity/);
  assert.equal(requests, 1);
  await assert.rejects(reader.model("character/unsupported.m2"), {
    name: "ClientUnsupportedError",
    message: /Unimplemented model section/,
  });
  await assert.rejects(reader.read("id:88"), {
    name: "ClientUnsupportedError",
  });
  await assert.rejects(reader.read("id:99"), { name: "NotFoundError" });
  reader.close();
});
