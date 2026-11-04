import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LocalClientFiles } from "../src/local-client-files";

// Isolate independent file latency. Synchronous decoding and GPU work are excluded.
const names = Array.from({ length: 24 }, (_, index) => `file-${index}`);
async function measure(parallel: boolean) {
  let active = 0;
  let peak = 0;
  const files = new LocalClientFiles({
    async read(name) {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return new TextEncoder().encode(name);
    },
  }, "benchmark");
  const start = performance.now();
  if (parallel) await files.prepare(names);
  else for (const name of names) await files.read(name);
  const elapsedMs = performance.now() - start;
  const hash = createHash("sha256");
  for (const name of names) hash.update(files.readSync(name));
  return { elapsedMs, peakReads: peak, bytesSha256: hash.digest("hex") };
}
const trials = [];
for (let i = 0; i < 5; i++) {
  const before = i % 2 ? undefined : await measure(false);
  const after = await measure(true);
  const baseline = before ?? await measure(false);
  if (baseline.bytesSha256 !== after.bytesSha256) throw Error("Prepared bytes differ");
  trials.push({ before: baseline, after });
}
console.log(JSON.stringify({ files: names.length, readLatencyMs: 20, trials }, null, 2));
