import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { openHostedAssets } from "../src/hosted-assets";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const raw = Array.from({ length: 8 }, (_, i) => new Uint8Array(4096).fill(i));
const compressed = raw.map((b) => new Uint8Array(gzipSync(b)));
const hashes = compressed.map(sha);
const manifest = {
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
      { bytes: compressed[i].length, rawBytes: raw[i].length },
    ]),
  ),
  files: {
    "read:bench.bin": {
      parts: hashes.map((h) => ({ chunk: h, offset: 0, length: 4096 })),
      bytes: 32768,
      sha256: sha(Buffer.concat(raw)),
    },
  },
  appearanceInputs: [],
};
const times = [];
let peak = 0;
for (let run = 0; run < 5; run++) {
  let active = 0;
  const reader = await openHostedAssets("https://assets.example", undefined, {
    cache: null,
    fetch: async (url: any) => {
      if (String(url).endsWith("manifest.json")) return Response.json(manifest);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      return new Response(
        compressed[hashes.findIndex((h) => String(url).includes(h))],
      );
    },
  });
  const start = performance.now();
  const result = await reader.read("bench.bin");
  times.push(performance.now() - start);
  if (!Buffer.from(result.bytes).equals(Buffer.concat(raw)))
    throw Error("Output mismatch");
  reader.close();
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    scenario: "8 chunks, 40ms latency per chunk, cold cache",
    medianMs: times[2],
    minMs: times[0],
    maxMs: times[4],
    peakConcurrent: peak,
    runs: times,
  }),
);
