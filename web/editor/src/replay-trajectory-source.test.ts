import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrajectorySource,
  lookupTrajectorySource,
  type TrajectoryActorSource,
  type TrajectorySample,
} from "./replay-trajectory-source";

const source = (
  samples: readonly TrajectorySample[],
  extra: Partial<TrajectoryActorSource> = {},
): TrajectoryActorSource => ({ key: "4:1", samples, ...extra });

test("adjacent intervals share one canonical observation and preserve raw Z evidence", () => {
  const samples: TrajectorySample[] = [
    [0, 1, 2, null],
    [1000, 2, 3, 0],
    [2000, 3, 4, -20],
    [3000, 4, 5, 50],
  ];
  const before = JSON.stringify(samples);
  const index = buildTrajectorySource(source(samples));
  assert.equal(index.components.length, 1);
  assert.deepEqual(
    index.observations.map((o) => o.zSource),
    ["missing", "recorded", "recorded", "recorded"],
  );
  index.observations.forEach((o, i) => {
    assert.equal(o.raw, samples[i]);
    assert.equal(o.index, i);
    assert.equal(o.componentId, index.components[0].id);
  });
  assert.equal(index.intervals[0].toIndex, index.intervals[1].fromIndex);
  assert.equal(JSON.stringify(samples), before);
  assert.equal(Object.isFrozen(samples[0]), false);
});

test("long gaps and speed split physics, while short sparse gaps retain their classification", () => {
  const index = buildTrajectorySource(
    source([
      [0, 0, 0, null],
      [2000, 70, 0, null],
      [7001, 70, 0, null],
      [8001, 105.001, 0, null],
    ]),
  );
  assert.equal(index.components.length, 3);
  assert.deepEqual(
    index.intervals.map((i) => i.boundaries.map((b) => b.kind)),
    [[], ["gap"], ["speed"]],
  );
  assert.equal(index.intervals[1].sparse, true);
  assert.deepEqual(index.intervals[1].boundaries[0], {
    kind: "gap",
    time: 7001,
    fromIndex: 1,
    toIndex: 2,
  });
  assert.equal(index.components[0].lastSampleIndex, 1);
  assert.equal(index.components[1].firstSampleIndex, 2);
});

test("only completed recorded Blink splits short movement and retains completion time", () => {
  const index = buildTrajectorySource(
    source(
      [
        [0, 0, 0, null],
        [1000, 2, 0, null],
        [2000, 3, 0, null],
      ],
      {
        casts: [
          {
            spell: 1953,
            end: 100,
            outcome: "interrupted",
            timingSource: "recorded",
          },
          {
            spell: 1953,
            end: 200,
            outcome: "completed",
            timingSource: "estimated",
          },
          {
            spell: 1953,
            end: 450,
            outcome: "completed",
            timingSource: "recorded",
          },
          {
            spell: 999,
            end: 1500,
            outcome: "completed",
            timingSource: "recorded",
          },
        ],
      },
    ),
  );
  assert.equal(index.components.length, 2);
  assert.deepEqual(index.intervals[0].boundaries, [
    { kind: "blink", time: 450, eventIndex: 2, fromIndex: 0, toIndex: 1 },
  ]);
  assert.equal(
    lookupTrajectorySource(index, 449)?.interval?.boundaries[0].time,
    450,
  );
  assert.equal(
    lookupTrajectorySource(index, 450)?.interval?.boundaries[0].time,
    450,
  );
  assert.equal(index.intervals[1].boundaries.length, 0);
});

test("actual life changes and zone boundaries retain every event inside their source interval", () => {
  const index = buildTrajectorySource(
    source(
      [
        [0, 0, 0, null],
        [1000, 1, 0, null],
        [2000, 2, 0, null],
        [3000, 3, 0, null],
      ],
      {
        deaths: [
          [0, false],
          [200, false],
          [500, true],
          [600, true],
          [750, false],
          [1500, false],
          [2200, true],
        ],
        positionBreaks: [1000, 2500],
      },
    ),
  );
  assert.equal(index.components.length, 3);
  assert.deepEqual(
    index.intervals[0].boundaries.map((b) => [b.kind, b.time, b.dead]),
    [
      ["life", 500, true],
      ["life", 750, false],
      ["zone", 1000, undefined],
    ],
  );
  assert.deepEqual(index.intervals[1].boundaries, []);
  assert.deepEqual(
    index.intervals[2].boundaries.map((b) => [b.kind, b.time]),
    [
      ["life", 2200],
      ["zone", 2500],
    ],
  );
});

test("buffer holes require coverage without creating components or changing IDs", () => {
  const samples: TrajectorySample[] = [
    [0, 0, 0, null],
    [1000, 1, 0, null],
    [2000, 2, 0, null],
  ];
  const partial = buildTrajectorySource(
    source(samples, {
      bufferedRanges: [
        [0, 400],
        [600, 1000],
        [1500, 2000],
      ],
    }),
  );
  const full = buildTrajectorySource(
    source(samples, {
      bufferedRanges: [
        [0, 1000],
        [1000, 2000],
      ],
    }),
  );
  assert.equal(partial.components.length, 1);
  assert.deepEqual(partial.components[0].missingCoverage, [
    [400, 600],
    [1000, 1500],
  ]);
  assert.deepEqual(partial.intervals[1].missingCoverage, [[1000, 1500]]);
  assert.equal(full.components[0].id, partial.components[0].id);
  assert.deepEqual(full.components[0].missingCoverage, []);
  assert.deepEqual(
    buildTrajectorySource(source(samples, { bufferedRanges: [] })).components[0]
      .missingCoverage,
    [[0, 2000]],
  );
  assert.deepEqual(
    buildTrajectorySource(source([[10, 0, 0, null]], { bufferedRanges: [] }))
      .components[0].missingCoverage,
    [[10, 10]],
  );
});

test("append and unrelated new components preserve IDs; a real earlier origin changes its ID", () => {
  const samples: TrajectorySample[] = [
    [100, 0, 0, null],
    [1000, 1, 0, null],
    [7000, 2, 0, null],
  ];
  const original = buildTrajectorySource(source(samples));
  const appended = buildTrajectorySource(
    source([...samples, [8000, 3, 0, null], [14000, 4, 0, null]]),
  );
  assert.deepEqual(
    appended.components.slice(0, 2).map((c) => c.id),
    original.components.map((c) => c.id),
  );
  const earlier = buildTrajectorySource(source([[0, 0, 0, null], ...samples]));
  assert.notEqual(earlier.components[0].id, original.components[0].id);
  assert.equal(earlier.components[1].id, original.components[1].id);
  assert.notEqual(
    buildTrajectorySource(source(samples, { key: "4:2" })).components[0].id,
    original.components[0].id,
  );
});

test("lookup is stable across forward, reversed, repeated and shuffled seeks", () => {
  const index = buildTrajectorySource(
    source([
      [0, 0, 0, null],
      [1000, 1, 0, null],
      [4000, 2, 0, null],
    ]),
  );
  const times = [-1, 0, 1, 999, 1000, 1001, 3999, 4000, 5000];
  const expected = new Map(
    times.map((t) => [t, lookupTrajectorySource(index, t)]),
  );
  for (const t of [...times, ...[...times].reverse(), 1001, 0, 5000, 999, 4000])
    assert.deepEqual(lookupTrajectorySource(index, t), expected.get(t));
  assert.equal(lookupTrajectorySource(index, 1000)?.observation.index, 1);
  assert.equal(lookupTrajectorySource(index, -1)?.interval, null);
  assert.equal(lookupTrajectorySource(index, 5000)?.interval, null);
  assert.equal(
    lookupTrajectorySource(buildTrajectorySource(source([])), 10),
    null,
  );
  assert.throws(() => lookupTrajectorySource(index, NaN), /lookup time/);
});

test("invalid observations and ordered parallel records fail explicitly without normalization", () => {
  const invalid: TrajectorySample[][] = [
    [
      [1, 0, 0, null],
      [0, 0, 0, null],
    ],
    [
      [0, 0, 0, null],
      [0, 1, 1, null],
    ],
    [[NaN, 0, 0, null]],
    [[0, Infinity, 0, null]],
    [[0, 0, 0, NaN]],
    [[0, 0, 0, undefined] as unknown as TrajectorySample],
  ];
  for (const samples of invalid)
    assert.throws(
      () => buildTrajectorySource(source(samples)),
      /Invalid trajectory source/,
    );
  assert.throws(
    () =>
      buildTrajectorySource(
        source([], {
          deaths: [
            [10, true],
            [0, false],
          ],
        }),
      ),
    /out of order/,
  );
  assert.throws(
    () => buildTrajectorySource(source([], { positionBreaks: [2, 1] })),
    /out of order/,
  );
  assert.throws(
    () => buildTrajectorySource(source([], { bufferedRanges: [[10, 0]] })),
    /reversed/,
  );
  assert.throws(
    () =>
      buildTrajectorySource(
        source([], {
          casts: [
            {
              spell: 1953,
              end: Infinity,
              outcome: "completed",
              timingSource: "recorded",
            },
          ],
        }),
      ),
    /Blink event/,
  );
});

test("unloaded long intervals retain the chronological origin until coverage classifies the gap", () => {
  const samples: TrajectorySample[] = [
    [0, 0, 0, null],
    [1000, 1, 0, null],
    [10000, 900, 0, null],
    [11000, 901, 0, null],
  ];
  const partial = buildTrajectorySource(
    source(samples, {
      bufferedRanges: [
        [0, 1000],
        [10000, 11000],
      ],
    }),
  );
  assert.equal(partial.components.length, 1);
  assert.equal(partial.components[0].firstTime, 0);
  assert.deepEqual(partial.components[0].missingCoverage, [[1000, 10000]]);
  assert.equal(
    partial.observations[2].componentId,
    partial.observations[0].componentId,
  );
  assert.deepEqual(partial.intervals[1].boundaries, []);
  assert.equal(partial.intervals[1].sparse, false);
  const verified = buildTrajectorySource(
    source(samples, { bufferedRanges: [[0, 11000]] }),
  );
  assert.equal(verified.components.length, 2);
  assert.equal(verified.components[0].id, partial.components[0].id);
  assert.deepEqual(
    verified.intervals[1].boundaries.map((b) => b.kind),
    ["gap", "speed"],
  );
  assert.equal(verified.intervals[1].sparse, true);
});

test("recorded events inside a coverage hole keep exact timing but cannot reseed physics", () => {
  const samples: TrajectorySample[] = [
    [0, 0, 0, null],
    [1000, 1, 0, null],
    [10000, 2, 0, null],
    [11000, 3, 0, null],
  ];
  const partial = buildTrajectorySource(
    source(samples, {
      bufferedRanges: [
        [0, 1000],
        [10000, 11000],
      ],
      casts: [
        {
          spell: 1953,
          end: 5000,
          outcome: "completed",
          timingSource: "recorded",
        },
      ],
      deaths: [
        [6000, true],
        [7000, false],
      ],
      positionBreaks: [8000],
    }),
  );
  assert.equal(partial.components.length, 1);
  assert.deepEqual(
    partial.intervals[1].boundaries.map((b) => [b.kind, b.time]),
    [
      ["blink", 5000],
      ["life", 6000],
      ["life", 7000],
      ["zone", 8000],
    ],
  );
  assert.equal(
    partial.intervals[1].fromComponentId,
    partial.intervals[1].toComponentId,
  );
  assert.deepEqual(partial.components[0].missingCoverage, [[1000, 10000]]);
});

test("short sparse gaps preserve physical ownership, with strict bounded limits and hard events", () => {
  for (const [gap, distance, components] of [
    [2068, 16.7, 1],
    [5000, 40, 1],
    [5001, 40, 2],
    [5000, 40.001, 2],
  ]) {
    const samples: TrajectorySample[] = [
      [0, 0, 0, null],
      [gap, distance, 0, null],
    ];
    const index = buildTrajectorySource(source(samples));
    assert.equal(index.components.length, components);
    assert.equal(index.intervals[0].sparse, true);
    assert.deepEqual(
      index.intervals[0].boundaries.map((b) => b.kind),
      ["gap"],
    );
    assert.equal(index.observations[0].raw, samples[0]);
    assert.equal(index.observations[1].raw, samples[1]);
    assert.equal(
      buildTrajectorySource(source(samples, { positionBreaks: [1000] }))
        .components.length,
      2,
    );
  }
});
