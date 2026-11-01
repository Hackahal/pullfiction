import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrajectorySource,
  type TrajectorySample,
} from "./replay-trajectory-source";
import {
  buildTrajectoryPacket,
  type TrajectoryMovementSource,
  type TrajectoryPacketInput,
} from "./replay-trajectory-packets";

function input(
  samples: readonly TrajectorySample[] = [
    [100, 0, 0, null],
    [1100, 7, 0, null],
  ],
  extra: Partial<TrajectoryMovementSource> = {},
): TrajectoryPacketInput {
  const actor = { key: "4:1", samples, ...extra };
  const index = buildTrajectorySource(actor);
  return {
    source: "report:fight",
    map: 533,
    actor,
    index,
    component: index.components[0],
    initialHeights: [20, 10],
  };
}

test("packet preserves exact raw tuples, timestamps and explicit seed Z including zero", () => {
  for (const z of [0, -15, 20]) {
    const data = input([
      [17, 1, 2, z],
      [1017, 3, 4, null],
      [1717, 4, 5, -2],
    ]);
    const before = JSON.stringify(data);
    const packet = buildTrajectoryPacket(data)!;
    assert.deepEqual(packet.initial_heights, [z]);
    packet.samples.forEach((raw, i) =>
      assert.equal(raw, data.actor.samples[i]),
    );
    assert.deepEqual(
      packet.samples.map((s) => [s[0], s[3]]),
      [
        [17, z],
        [1017, null],
        [1717, -2],
      ],
    );
    assert.equal(packet.source, data.source);
    assert.equal(packet.actor, data.actor.key);
    assert.equal(packet.component, data.component.id);
    assert.equal(packet.map, 533);
    assert.equal(JSON.stringify(data), before);
  }
});

test("near-identical geometry heights preserve the three-seed budget and first-ranked exact value", () => {
  const data = input();
  assert.deepEqual(
    buildTrajectoryPacket({
      ...data,
      initialHeights: [317, 317.00001, 304, 293],
    })?.initial_heights,
    [317, 304, 293],
  );
  assert.deepEqual(
    buildTrajectoryPacket({
      ...data,
      initialHeights: [0, 0.05, -0.04, 0.051, 10],
    })?.initial_heights,
    [0, 0.051, 10],
  );
  assert.deepEqual(
    buildTrajectoryPacket({
      ...input([[100, 0, 0, 317.00001]]),
      initialHeights: [317, 304, 293],
    })?.initial_heights,
    [317.00001],
  );
});

test("missing Z uses at most three finite distinct ranked geometry seeds or stays pending", () => {
  const data = input();
  assert.deepEqual(
    buildTrajectoryPacket({
      ...data,
      initialHeights: [NaN, 30, 30, Infinity, -2, 0, 10],
    })?.initial_heights,
    [30, -2, 0],
  );
  assert.equal(buildTrajectoryPacket({ ...data, initialHeights: [] }), null);
  assert.equal(
    buildTrajectoryPacket({ ...data, initialHeights: [NaN, Infinity] }),
    null,
  );
});

test("ordinary movement has endpoint progress and a fixed travel budget", () => {
  const packet = buildTrajectoryPacket(input())!;
  assert.deepEqual(packet.profiles, [
    {
      travel_budget: 7,
      run_speed: 7,
      progress: [
        [100, 0],
        [1100, 1],
      ],
    },
  ]);
  assert.equal(packet.profiles.length, packet.samples.length - 1);
});

test("Sprint profile retains aura knots and integrated progress instead of seek-time sampling", () => {
  const data = input(
    [
      [100, 0, 0, null],
      [1100, 5, 0, null],
      [2100, 10, 0, null],
    ],
    {
      movement: {
        profile: [
          [0, 1, 0],
          [600, 1.5, 600],
          [1600, 1, 2100],
        ],
        blinks: [],
      },
    },
  );
  const packet = buildTrajectoryPacket(data)!;
  assert.deepEqual(packet.profiles[0], {
    travel_budget: 8.75,
    run_speed: 10.5,
    progress: [
      [100, 0],
      [600, 0.4],
      [1100, 1],
    ],
  });
  assert.deepEqual(packet.profiles[1], {
    travel_budget: 8.75,
    run_speed: 10.5,
    progress: [
      [1100, 0],
      [1600, 0.6],
      [2100, 1],
    ],
  });
  for (const ignoredSeek of [2100, 500, 100, 1200, 500]) {
    void ignoredSeek;
    assert.deepEqual(buildTrajectoryPacket(data), packet);
  }
});

test("physics evidence changes content while identity stays separate", () => {
  const data = input();
  const original = buildTrajectoryPacket(data)!;
  const variants = [
    { ...data, initialHeights: [10, 20] },
    { ...data, map: 0 },
    input([
      [100, 0, 0, null],
      [1100, 7.01, 0, null],
    ]),
    input([
      [100, 0, 0, null],
      [1100, 7, 0, 0],
    ]),
    input(undefined, { movement: { profile: [[0, 1.5, 0]] } }),
    input(undefined, {
      bufferedRanges: [
        [100, 400],
        [600, 1100],
      ],
    }),
  ];
  for (const changed of variants) {
    const packet = buildTrajectoryPacket(changed)!;
    assert.notEqual(packet.content, original.content);
    assert.equal(packet.component, original.component);
  }
  const partialA = buildTrajectoryPacket(
    input(undefined, {
      bufferedRanges: [
        [100, 400],
        [600, 1100],
      ],
    }),
  )!;
  const partialB = buildTrajectoryPacket(
    input(undefined, {
      bufferedRanges: [
        [100, 500],
        [600, 1100],
      ],
    }),
  )!;
  assert.equal(partialA.coverage_complete, false);
  assert.notEqual(partialA.content, partialB.content);
  assert.equal(
    buildTrajectoryPacket({ ...data, source: "another-report" })!.content,
    original.content,
  );
});

test("coverage never alters seeds and future components or presentation metadata do not invalidate content", () => {
  const data = input();
  const original = buildTrajectoryPacket(data)!;
  const actor = {
    ...data.actor,
    name: "Different name",
    samples: [...data.actor.samples, [7000, 1, 1, 200] as const],
    movement: {
      profile: [
        [0, 1, 0],
        [7000, 1.5, 7000],
      ] as const,
    },
  };
  const index = buildTrajectorySource(actor);
  const extended = buildTrajectoryPacket({
    ...data,
    actor,
    index,
    component: index.components[0],
  })!;
  assert.equal(extended.content, original.content);
  const missing = buildTrajectoryPacket(
    input(undefined, { bufferedRanges: [] }),
  )!;
  assert.deepEqual(missing.initial_heights, original.initial_heights);
  assert.equal(missing.coverage_complete, false);
  assert.notEqual(missing.content, original.content);
});

test("Blink boundaries are excluded from dense component profiles", () => {
  const data = input(
    [
      [0, 0, 0, null],
      [1000, 2, 0, null],
      [2000, 3, 0, null],
    ],
    {
      casts: [
        {
          spell: 1953,
          end: 500,
          outcome: "completed",
          timingSource: "recorded",
        },
      ],
      movement: { profile: [[0, 1, 0]], blinks: [[500]] },
    },
  );
  const before = buildTrajectoryPacket(data)!;
  const after = buildTrajectoryPacket({
    ...data,
    component: data.index.components[1],
  })!;
  assert.deepEqual(
    before.samples.map((s) => s[0]),
    [0],
  );
  assert.deepEqual(before.profiles, []);
  assert.deepEqual(
    after.samples.map((s) => s[0]),
    [1000, 2000],
  );
  assert.equal(after.profiles.length, 1);
});

test("mismatched identities and invalid movement evidence are rejected", () => {
  const data = input();
  assert.throws(
    () =>
      buildTrajectoryPacket({
        ...data,
        actor: { ...data.actor, key: "other" },
      }),
    /does not belong/,
  );
  assert.throws(
    () => buildTrajectoryPacket({ ...data, map: NaN }),
    /source\/map/,
  );
  assert.throws(
    () =>
      buildTrajectoryPacket(
        input(undefined, { movement: { profile: [[0, 0, 0]] } }),
      ),
    /movement profile/,
  );
  assert.throws(
    () =>
      buildTrajectoryPacket(
        input(undefined, {
          movement: {
            profile: [
              [0, 1, 0],
              [0, 1, 0],
            ],
          },
        }),
      ),
    /movement profile/,
  );
});

test("pending components with unloaded long spans and known Blink retain evidence without movement profiles", () => {
  const data = input(
    [
      [0, 0, 0, 0],
      [1000, 1, 0, null],
      [10000, 2, 0, null],
      [11000, 3, 0, -10],
    ],
    {
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
      movement: { profile: [[0, 1, 0]], blinks: [[5000]] },
    },
  );
  assert.equal(data.index.components.length, 1);
  const packet = buildTrajectoryPacket(data)!;
  assert.equal(packet.coverage_complete, false);
  assert.deepEqual(packet.samples, data.actor.samples);
  assert.deepEqual(packet.profiles, []);
  assert.deepEqual(packet.initial_heights, [0]);
});

test("short sparse intervals retain raw evidence and request continuous estimated physics", () => {
  const data = input([
    [0, 0, 0, 0],
    [1000, 7, 0, null],
    [3068, 23, 0, null],
  ]);
  const packet = buildTrajectoryPacket(data)!;
  assert.equal(data.index.components.length, 1);
  assert.equal(packet.profiles[0].unrestricted, undefined);
  assert.equal(packet.profiles[1].unrestricted, true);
  assert.deepEqual(packet.samples, data.actor.samples);
  assert.deepEqual(packet.initial_heights, [0]);
  assert.equal(packet.profiles[1].progress[0][0], 1000);
  assert.equal(packet.profiles[1].progress.at(-1)![0], 3068);
});

test("known chronological prefixes exclude unloaded future observations without losing the source origin", () => {
  const samples: TrajectorySample[] = [
    ...Array.from(
      { length: 13 },
      (_, n) => [n * 1000, n * 3, 0, null] as const,
    ),
    [20000, 50, 0, null],
  ];
  const data = input(samples, {
    bufferedRanges: [
      [0, 12000],
      [20000, 20000],
    ],
  });
  const packet = buildTrajectoryPacket(data)!;
  assert.equal(data.index.components.length, 1);
  assert.equal(packet.coverage_complete, true);
  assert.equal(packet.samples.length, 13);
  assert.equal(packet.component, data.index.components[0].id);
  packet.samples.forEach((sample, i) => assert.equal(sample, samples[i]));
  assert.equal(packet.profiles.length, 12);
  const short = input(samples, {
    bufferedRanges: [
      [0, 9000],
      [20000, 20000],
    ],
  });
  assert.equal(buildTrajectoryPacket(short)!.coverage_complete, false);
});

test("recorded slow-fall state is scoped and included in immutable content identity", () => {
  const data = input(
    [
      [0, 0, 0, 0],
      [1000, 7, 0, null],
      [2000, 14, 0, null],
    ],
    {
      auras: [
        [500, { spell: 1706, remove: false }],
        [1500, { spell: 1706, remove: true }],
      ],
    },
  );
  const p = buildTrajectoryPacket(data)!;
  assert.deepEqual(p.slow_fall, [
    [0, false],
    [500, true],
    [1500, false],
  ]);
  assert.deepEqual(p.hover_launches, [500]);
  assert.equal(p.transfers, undefined);
  const plain = input(data.actor.samples);
  assert.notEqual(p.content, buildTrajectoryPacket(plain)!.content);
  assert.deepEqual(p.samples, data.actor.samples);
});

test("recorded transfer episodes retain source timestamps and change the packet identity", () => {
  const data = input([
    [0, 0, 0, 0],
    [1000, 0, 0, null],
    [2000, 25, 0, null],
    [3000, 50, 0, null],
    [4000, 57, 0, null],
  ]);
  const p = buildTrajectoryPacket({ ...data, transfers: [[1000, 3000]] })!;
  assert.deepEqual(p.transfers, [[1000, 3000]]);
  assert.notEqual(p.content, buildTrajectoryPacket(data)!.content);
  assert.deepEqual(p.samples, data.actor.samples);
});

test("a covered prefix cannot end midway through a known transfer episode", () => {
  const samples: TrajectorySample[] = [
    ...Array.from({ length: 25 }, (_, n) => [n * 1000, n, 0, null] as const),
    [40000, 30, 0, null],
  ];
  const data = input(samples, {
    bufferedRanges: [
      [0, 22000],
      [40000, 40000],
    ],
  });
  const p = buildTrajectoryPacket({ ...data, transfers: [[20000, 24000]] })!;
  assert.equal(p.coverage_complete, true);
  assert.equal(p.samples.at(-1)![0], 20000);
  assert.equal(p.transfers, undefined);
  p.samples.forEach((s, i) => assert.equal(s, samples[i]));
});

test("known unresolved effects distinguish missing coverage from a fully loaded conflict", () => {
  const samples: TrajectorySample[] = [
    [0, 0, 0, 0],
    [1000, 0, 0, null],
    [2000, 30, 0, null],
  ];
  const partial = input(samples, { bufferedRanges: [[0, 2000]] });
  const a = buildTrajectoryPacket({
    ...partial,
    unresolvedTransfers: [1000],
    coverageEnd: 10000,
  })!;
  assert.deepEqual(a.unresolved_transfers, [[1000, false]]);
  assert.equal(a.transfers, undefined);
  const full = input(samples, {
    bufferedRanges: [
      [0, 4000],
      [4000, 10000],
    ],
  });
  const b = buildTrajectoryPacket({
    ...full,
    unresolvedTransfers: [1000],
    coverageEnd: 10000,
  })!;
  assert.deepEqual(b.unresolved_transfers, [[1000, true]]);
  assert.notEqual(a.content, b.content);
  const ended = input(samples, { bufferedRanges: [[0, 2000]] });
  assert.deepEqual(
    buildTrajectoryPacket({
      ...ended,
      unresolvedTransfers: [1000],
      coverageEnd: 2000,
    })!.unresolved_transfers,
    [[1000, true]],
  );
});
