import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFrames, framePerformance } from "./frame-performance";
import { assetProgress } from "./loading-progress";

test("frame cadence includes long stalls in elapsed time and percentiles", () => {
  const sample = summarizeFrames(
    [...Array(59).fill(1000 / 60), 200],
    "renderer",
  )!;
  assert.ok(sample.fps < 51);
  assert.equal(sample.worst, 200);
  assert.equal(sample.p99, 200);
  assert.equal(sample.slow, 1);
  assert.equal(sample.frames, 60);
  assert.equal(summarizeFrames([NaN, 0, -1], "browser"), null);
});
test("performance subscription releases its listener", () => {
  let calls = 0;
  const off = framePerformance.subscribe(() => calls++);
  framePerformance.publish(summarizeFrames([16, 17], "renderer"));
  assert.equal(calls, 1);
  off();
  framePerformance.publish(null);
  assert.equal(calls, 1);
});
test("loading progress rejects unknown totals, invalid counters and text-only phases", () => {
  assert.equal(assetProgress({ message: "Loading" }), null);
  assert.equal(
    assetProgress({ completedBytes: 2, totalBytes: 1, activeFiles: 1 }),
    null,
  );
  assert.equal(
    assetProgress({ completedBytes: 0, totalBytes: 0, activeFiles: 1 }),
    null,
  );
  assert.deepEqual(
    assetProgress({ completedBytes: 5, totalBytes: 10, activeFiles: 1 }),
    { completedBytes: 5, totalBytes: 10, activeFiles: 1 },
  );
});
