import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanTimecode, planRangeLabel } from "./plan-timecode";

test("Plan boundaries accept run timecode, seconds and an explicit open bound", () => {
  for (const text of ["5:05.125", "305.125", "305,125"])
    assert.deepEqual(parsePlanTimecode(text), { valid: true, value: 305125 });
  assert.deepEqual(parsePlanTimecode("35:04.2"), {
    valid: true,
    value: 2104200,
  });
  assert.deepEqual(parsePlanTimecode(" "), { valid: true, value: null });
  for (const text of [
    "5:",
    "5:60",
    "-1",
    "1e",
    "5:05.0001",
    "9007199254740991",
  ])
    assert.deepEqual(parsePlanTimecode(text), { valid: false }, text);
});

test("Plan timing uses the same exact range labels for closed and open bounds", () => {
  assert.equal(planRangeLabel(291591, 306469), "4:51.591 – 5:06.469");
  assert.equal(planRangeLabel(null, 306469), "Beginning – 5:06.469");
  assert.equal(planRangeLabel(0, null), "0:00.000 – End");
  assert.equal(planRangeLabel(null, null), "Always visible");
});
