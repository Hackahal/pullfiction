import test from "node:test";
import assert from "node:assert/strict";
import { withReplayPoses } from "./replay-pose-phase";
import { poseAt } from "./domain";
import type { Actor } from "./types";
const actor = () =>
  ({
    key: "1:1",
    type: "Player",
    firstSeen: 0,
    lastSeen: 1000,
    samples: [
      [0, 0, 0, null],
      [1000, 10, 20, null],
    ],
    headings: [0, 1],
    deaths: [],
  }) as unknown as Actor;

test("a phase reuses only exact Actor/time/smooth queries, including null", () => {
  const a = actor(),
    b = actor();
  const calls: unknown[] = [];
  const read: typeof poseAt = (unit, time, smooth) => {
    calls.push([unit, time, smooth]);
    return poseAt(unit, time, smooth);
  };
  withReplayPoses((lookup) => {
    const first = lookup(a, 500, false);
    assert.deepEqual(first, poseAt(a, 500, false));
    assert.equal(lookup(a, 500, false), first);
    lookup(b, 500, false);
    lookup(a, 500, true);
    lookup(a, 500.000000001, true);
    lookup(a, 500, true);
    lookup(a, 500, undefined);
    assert.equal(lookup(a, -1, false), null);
    assert.equal(lookup(a, -1, false), null);
    assert.equal(calls.length, 7);
  }, read);
});

test("no quantization or signed-zero collapsing is introduced", () => {
  const a = actor(),
    times = [0, -0, Number.MIN_VALUE, 1, 1 + Number.EPSILON, NaN];
  let calls = 0;
  const read: typeof poseAt = () => {
    calls++;
    return null;
  };
  withReplayPoses((lookup) => {
    for (const time of times) {
      lookup(a, time, false);
      lookup(a, time, false);
    }
  }, read);
  assert.equal(calls, times.length);
});

test("same-time in-place sample/death changes are observed in the next phase", () => {
  const a = actor();
  const first = withReplayPoses((lookup) => lookup(a, 500, false));
  a.samples[0][1] = 5;
  a.deaths.push([400, true]);
  const next = withReplayPoses((lookup) => lookup(a, 500, false));
  assert.deepEqual(next, poseAt(a, 500, false));
  assert.notDeepEqual(next, first);
  assert.equal(next?.dead, true);
});

test("finally clears and deactivates the lookup on return and on exceptions", () => {
  const a = actor();
  for (const throws of [false, true]) {
    let calls = 0,
      escaped: typeof poseAt = poseAt;
    const read: typeof poseAt = (...args) => {
      calls++;
      return poseAt(...args);
    };
    const invoke = () =>
      withReplayPoses((lookup) => {
        escaped = lookup;
        lookup(a, 500, false);
        lookup(a, 500, false);
        if (throws) throw new Error("native publication failed");
        return "published";
      }, read);
    if (throws) assert.throws(invoke, /native publication failed/);
    else assert.equal(invoke(), "published");
    assert.equal(calls, 1);
    escaped(a, 500, false);
    escaped(a, 500, false);
    assert.equal(calls, 3, "an escaped lookup cannot keep a phase alive");
  }
});

test("a thrown pose calculation is retried and never cached as null", () => {
  const a = actor();
  let calls = 0;
  const read: typeof poseAt = (...args) => {
    if (++calls === 1) throw new Error("bad pose");
    return poseAt(...args);
  };
  withReplayPoses((lookup) => {
    assert.throws(() => lookup(a, 500, false), /bad pose/);
    assert.deepEqual(lookup(a, 500, false), poseAt(a, 500, false));
    lookup(a, 500, false);
    assert.equal(calls, 2);
  }, read);
});
