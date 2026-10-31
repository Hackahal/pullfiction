import test from "node:test";
import assert from "node:assert/strict";
import {
  SMOKE_CASES,
  deterministicBatches,
  syntheticActor,
  validateRendererCase,
} from "./cases";

test("smoke fixtures are declarative and validate without replay data", () => {
  assert.equal(new Set(SMOKE_CASES.map((c) => c.id)).size, SMOKE_CASES.length);
  for (const c of SMOKE_CASES)
    assert.deepEqual(validateRendererCase(c), [], c.id);
  assert.ok(SMOKE_CASES.some((c) => c.content === "sod"));
  assert.ok(SMOKE_CASES.some((c) => c.mapId === 409));
});
test("bad samples, cameras and actor references cannot enter a batch silently", () => {
  const c = structuredClone(SMOKE_CASES[0]);
  c.timesMs = [0, 0, -1];
  c.camera.distance = NaN;
  c.actors.push(syntheticActor("subject"));
  c.effects = [
    {
      id: "effect",
      stage: "aura",
      casterId: "missing",
      startMs: -1,
      durationMs: 10,
    },
  ];
  const errors = validateRendererCase(c);
  for (const needle of [
    "timesMs",
    "camera",
    "duplicate actor",
    "unknown effect actor",
    "timing",
  ])
    assert.ok(
      errors.some((e) => e.includes(needle)),
      errors.join("; "),
    );
  assert.deepEqual(validateRendererCase(null), ["case must be an object"]);
});
test("batch order is stable across catalog ordering and input stays untouched", () => {
  const input = [...SMOKE_CASES].reverse();
  const before = input.map((c) => c.id);
  assert.deepEqual(
    deterministicBatches(input, 2),
    deterministicBatches(SMOKE_CASES, 2),
  );
  assert.deepEqual(
    input.map((c) => c.id),
    before,
  );
  assert.throws(() => deterministicBatches(input, 0));
  assert.throws(
    () => deterministicBatches([...input, input[0]], 2),
    /duplicate/,
  );
});
test("unresolved room viewpoint never advertises ready coverage", () => {
  const world = SMOKE_CASES.find((c) => c.category === "world")!;
  assert.equal(world.readiness?.status, "unverified");
  assert.match(world.readiness?.reason ?? "", /viewpoint/);
});
