import test from "node:test";
import assert from "node:assert/strict";
import { replayFloorAnchors } from "./replay-floor-anchors";
test("floor calibration covers reference raids and their Classic dungeon baselines without adding data to unsupported maps", () => {
  for (const map of [48, 90, 109, 249, 309, 409, 469, 509, 531, 533]) {
    const anchors = replayFloorAnchors(map);
    assert.ok(anchors.length > 0);
    assert.ok(
      anchors.every(
        (a) => a.point.length === 3 && a.point.every(Number.isFinite),
      ),
    );
  }
  assert.deepEqual(replayFloorAnchors(0), []);
  assert.deepEqual(replayFloorAnchors(2856), []);
  const a = replayFloorAnchors(533);
  a[0].point[0] = 0;
  assert.notEqual(replayFloorAnchors(533)[0].point[0], 0);
});
