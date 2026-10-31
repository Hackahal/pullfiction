import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

test("static viewer decompresses gzip, preserves exports, coalesces initialization, and retries failure", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pullfiction-static-loader-")));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "pullfiction_viewer.js"), await readFile(new URL("./static-viewer-loader.mjs", import.meta.url)));
    await writeFile(join(directory, "pullfiction_viewer.bindgen.js"), `
      export const marker = "wasm-bindgen export";
      export default async function init(options) { return new Uint8Array(options.module_or_path); }
    `);
    const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
    let downloads = 0;
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).pathname, join(directory, "pullfiction_viewer_bg.wasm.gz"));
      downloads++;
      if (downloads === 1) return new Response("unavailable", { status: 503 });
      return new Response(gzipSync(bytes), { headers: { "Content-Type": "application/gzip" } });
    };
    const loader = await import(pathToFileURL(join(directory, "pullfiction_viewer.js")));
    assert.equal(loader.marker, "wasm-bindgen export");
    await assert.rejects(loader.default(), /503/);
    const first = loader.default();
    const second = loader.default();
    assert.equal(first, second);
    assert.deepEqual(await first, bytes);
    assert.equal(downloads, 2);
    assert.deepEqual(await loader.default(), bytes);
    assert.equal(downloads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
