import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultSnap,
  snapPoint,
  transformPoint,
  contextOf,
} from "./editor-controls";
import { adjustedStepRange } from "./layer-model";
test("Relative snapping preserves imported offsets and terrain height", () => {
  const snap = { ...defaultSnap, position: true, yards: 5 };
  assert.deepEqual(
    snapPoint([12.8, 24.1, 17], [10.3, 20.3, 3], snap),
    [15.3, 25.3, 17],
  );
  assert.deepEqual(
    snapPoint([12.8, 24.1, 17], [10.3, 20.3, 3], { ...snap, mode: "grid" }),
    [15, 25, 17],
  );
  assert.deepEqual(
    snapPoint([12.8, 24.1, 17], [10.3, 20.3, 3], snap, true),
    [12.8, 24.1, 17],
  );
});
test("Ground transforms preserve altitude and group spacing", () => {
  const a = transformPoint([2, 0, 50], [0, 0, 2], Math.PI / 2, 2);
  assert.ok(Math.abs(a[0]) < 1e-9);
  assert.equal(a[1], 4);
  assert.equal(a[2], 50);
});
test("Focused timeline and playbook own keys even when nested in the scene", () => {
  const fake = (selector: string) =>
    ({
      closest: (q: string) =>
        q === selector
          ? {}
          : q === "[data-pane]"
            ? { getAttribute: () => "scene" }
            : null,
    }) as unknown as Element;
  assert.equal(contextOf(fake('[data-input-context="timeline"]')), "timeline");
  assert.equal(contextOf(fake('[data-input-context="playbook"]')), "playbook");
  assert.equal(contextOf(fake('[data-input-context="edits"]')), "edits");
  assert.equal(contextOf(fake('[data-input-context="scene"]')), "scene");
  assert.equal(contextOf(null), "other");
});
test("Step moves preserve duration and snap the nearest edge to playhead", () => {
  assert.deepEqual(
    adjustedStepRange(1000, 4000, 1600, "move", 10000, [5500], 200),
    { start: 2500, end: 5500, guide: 5500 },
  );
  const r = adjustedStepRange(1000, 4000, -9000, "move", 10000, [], 0);
  assert.equal(r.start, 0);
  assert.equal(r.end, 3000);
});
test("Step trims cannot cross opposite edge or go outside duration", () => {
  const a = adjustedStepRange(1000, 4000, 5000, "start", 10000, [], 0);
  assert.equal(a.start, 3900);
  assert.equal(a.end, 4000);
  const b = adjustedStepRange(1000, 4000, 20000, "end", 10000, [], 0);
  assert.equal(b.start, 1000);
  assert.equal(b.end, 10000);
});

test("Pages headers route page navigation while the Edits pane keeps its own keys", () => {
  const pane = (name: string) =>
    ({
      closest: (q: string) =>
        q === "[data-pane]" ? { getAttribute: () => name } : null,
    }) as unknown as Element;
  assert.equal(contextOf(pane("pages")), "playbook");
  assert.equal(contextOf(pane("playbook")), "edits");
});
