import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import test from "node:test";

test("static viewer decompresses gzip, preserves exports, coalesces initialization, and retries failure", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pullfiction-static-loader-")));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(join(directory, "pullfiction_viewer.js"), await readFile(new URL("./static-viewer-loader.mjs", import.meta.url)));
    await writeFile(join(directory, "pullfiction_viewer.bindgen.js"), `
      export const marker = "wasm-bindgen export";
      export const initInputs = [];
      export default async function init({ module_or_path: input }) {
        const streamed = input instanceof Response;
        initInputs.push(streamed ? input.headers.get("Content-Type") : "buffered");
        return new Uint8Array(streamed ? await input.arrayBuffer() : input);
      }
    `);
    const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const compressed = gzipSync(bytes);
    let downloads = 0;
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).pathname, join(directory, "pullfiction_viewer_bg.wasm.gz"));
      downloads++;
      if (downloads === 1) return new Response("unavailable", { status: 503 });
      const body = downloads === 2 ? compressed.subarray(0, compressed.length - 4) : compressed;
      return new Response(body, { headers: { "Content-Type": "application/gzip" } });
    };
    const loader = await import(pathToFileURL(join(directory, "pullfiction_viewer.js")));
    assert.equal(loader.marker, "wasm-bindgen export");
    await assert.rejects(loader.default(), /503/);
    await assert.rejects(loader.default(), "a truncated body must reject and allow a retry");
    const first = loader.default();
    const second = loader.default();
    assert.equal(first, second);
    assert.deepEqual(await first, bytes);
    assert.equal(downloads, 3);
    assert.deepEqual(await loader.default(), bytes);
    assert.equal(downloads, 3);
    assert.deepEqual(loader.initInputs, ["application/wasm", "application/wasm"]);
    assert.equal(loader.rendererArtifactIdentity(), null);
    const diagnostics = await import(`${pathToFileURL(join(directory, "pullfiction_viewer.js"))}?identity`);
    diagnostics.enableRendererIdentity();
    assert.deepEqual(await diagnostics.default(), bytes);
    assert.deepEqual(loader.initInputs, ["application/wasm", "application/wasm", "buffered"]);
    assert.deepEqual(diagnostics.rendererArtifactIdentity(), {
      schema: 1,
      wasmSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.equal(downloads, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
