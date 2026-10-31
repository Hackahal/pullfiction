import test from "node:test";
import assert from "node:assert/strict";
import { animateChartRows } from "./chart-motion";

test("Rank changes animate both keyed rows from their old positions and preserve exact rank targets", () => {
  const calls: { key: string; frames: Keyframe[] }[] = [];
  const row = (key: string, top: number) => ({
    dataset: { series: key },
    offsetTop: top,
    animate(frames: Keyframe[] | PropertyIndexedKeyframes | null) {
      calls.push({ key, frames: frames as Keyframe[] });
      return {} as Animation;
    },
  });
  const result = animateChartRows(
    [row("b", 30), row("a", 60), row("c", 90)],
    new Map([
      ["a", 30],
      ["b", 60],
    ]),
    false,
  );
  assert.equal(result.animations.length, 3);
  assert.equal(calls[0].frames[0].transform, "translateY(30px)");
  assert.equal(calls[1].frames[0].transform, "translateY(-30px)");
  assert.equal(calls[2].frames[0].opacity, 0);
  assert.deepEqual(
    [...result.positions],
    [
      ["b", 30],
      ["a", 60],
      ["c", 90],
    ],
  );
  calls.length = 0;
  animateChartRows(
    [row("b", 30), row("a", 60), row("c", 90)],
    result.positions,
    false,
  );
  assert.equal(calls.length, 0);
  animateChartRows([row("a", 30), row("b", 60)], result.positions, true);
  assert.equal(calls.length, 0);
});
