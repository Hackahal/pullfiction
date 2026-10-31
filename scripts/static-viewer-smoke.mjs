// Initialize the packaged WASM through its actual gzip loader without starting
// Bevy or requesting a GPU. This is a local module check, not browser QA.
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/static-viewer-smoke.mjs RELEASE_DIRECTORY");
const release = await realpath(resolve(process.argv[2]));
const wasmUrl = pathToFileURL(resolve(release, "pullfiction_viewer_bg.wasm.gz"));
const originalFetch = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).href, wasmUrl.href, "The loader may only read its packaged gzip file");
    requests++;
    return new Response(await readFile(wasmUrl), { headers: { "Content-Type": "application/gzip" } });
  };
  const viewer = await import(pathToFileURL(resolve(release, "pullfiction_viewer.js")));
  assert.equal(typeof viewer.start, "function");
  viewer.enableRendererIdentity();
  const wasm = await viewer.default();
  assert.ok(wasm.memory instanceof WebAssembly.Memory);
  assert.equal(requests, 1);
  assert.equal(viewer.rendererArtifactIdentity()?.wasmSha256, createHash("sha256").update(gunzipSync(await readFile(wasmUrl))).digest("hex"));
  assert.equal(await viewer.default(), wasm);
  assert.equal(requests, 1);
  console.log(`Static viewer initialized through gzip: ${Object.keys(wasm).length} WASM exports; no renderer start or network requests.`);
} finally {
  globalThis.fetch = originalFetch;
}
