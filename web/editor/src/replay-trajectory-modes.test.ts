import test from "node:test";
import assert from "node:assert/strict";
import {
  levitateLaunches,
  recordedTransferEvidence,
  recordedTransfers,
  slowFallModes,
  type MovementModeActor,
} from "./replay-trajectory-modes";
import type { Actor } from "./types";
const compatible = (actor: Actor): MovementModeActor => actor;
void compatible;
const player = (
  key: string,
  samples: MovementModeActor["samples"] = [],
  extra: Partial<MovementModeActor> = {},
): MovementModeActor => ({ key, type: "Player", samples, ...extra });
const npc = (
  key: string,
  spell: number,
  end = 1000,
  target: string | null = null,
  extra: Partial<NonNullable<MovementModeActor["casts"]>[number]> = {},
): MovementModeActor => ({
  key,
  type: "NPC",
  samples: [],
  casts: [
    {
      spell,
      end,
      target,
      outcome: "completed",
      timingSource: "recorded",
      ...extra,
    },
  ],
});
const travel: MovementModeActor["samples"] = [
  [900, 0, 0, null],
  [1500, 18, 0, null],
  [2000, 30, 0, null],
  [2100, 30.7, 0, null],
];
const pair = () => [
  npc("caster-a", 28338, 1000, "a"),
  npc("caster-b", 28339, 1000, "b"),
];

test("slow fall combines initial overlapping auras with exact scoped changes", () => {
  const actor = player("a", [], {
    initialAuras: [1706, 999],
    auras: [
      [20, { spell: 130 }],
      [30, { spell: 1706, remove: true }],
      [40, { spell: 130, remove: true }],
      [60, { spell: 1706 }],
      [80, { spell: 1706, remove: true }],
    ],
  });
  assert.deepEqual(slowFallModes(actor, 10, 70), [
    [10, true],
    [40, false],
    [60, true],
  ]);
  assert.deepEqual(slowFallModes(actor, 45, 90), [
    [45, false],
    [60, true],
    [80, false],
  ]);
  assert.deepEqual(slowFallModes(actor, 81, 90), []);
  assert.deepEqual(slowFallModes(actor, 40, 45), []);
});

test("aura resets and deaths clear state without stale resurrection effects", () => {
  const actor = player("a", [], {
    initialAuras: [130],
    auras: [
      [20, { reset: [999] }],
      [30, { reset: [1706, 130] }],
      [40, { spell: 1706 }],
      [70, { spell: 130 }],
    ],
    deaths: [
      [40, true],
      [60, false],
      [80, true],
    ],
  });
  assert.deepEqual(slowFallModes(actor, 0, 100), [
    [0, true],
    [20, false],
    [30, true],
    [40, false],
    [70, true],
    [80, false],
  ]);
  assert.deepEqual(slowFallModes(actor, 45, 65), []);
  assert.deepEqual(
    slowFallModes(player("a", [], { auras: [[10, { spell: 999 }]] }), 0, 100),
    [],
  );
  assert.deepEqual(slowFallModes(actor, 100, 0), []);
});

test("paired recorded explicit targets retain cast start and source completion times", () => {
  assert.deepEqual(
    [
      ...recordedTransfers(
        [player("a", travel), player("b", travel), ...pair()],
        [],
      ),
    ],
    [
      ["a", [[1000, 2000]]],
      ["b", [[1000, 2000]]],
    ],
  );
});

test("last pre-cast melee player victim wins over pets, spells and later damage", () => {
  const actors = [
    player("a", travel),
    player("b", travel),
    player("other", travel),
    { ...player("pet", travel), type: "Pet" },
    npc("caster-a", 28338),
    npc("caster-b", 28339),
  ];
  const combat = [
    { t: 950, kind: "damage", source: "caster-a", target: "pet", melee: true },
    { t: 800, kind: "damage", source: "caster-a", target: "a", melee: true },
    { t: 900, kind: "damage", source: "caster-b", target: "b", melee: true },
    {
      t: 600,
      kind: "damage",
      source: "caster-a",
      target: "other",
      melee: true,
    },
    {
      t: 980,
      kind: "damage",
      source: "caster-a",
      target: "other",
      melee: false,
    },
    { t: 990, kind: "HEAL", source: "caster-a", target: "other", melee: true },
    {
      t: 1001,
      kind: "damage",
      source: "caster-a",
      target: "other",
      melee: true,
    },
  ];
  assert.deepEqual([...recordedTransfers(actors, combat).keys()], ["a", "b"]);
});

test("unrecorded, interrupted, unpaired, mistimed and ambiguous casts establish no transfer", () => {
  const players = [player("a", travel), player("b", travel)];
  for (const casts of [
    [npc("caster-a", 28338, 1000, "a")],
    [npc("caster-a", 1953, 1000, "a"), npc("caster-b", 28339, 1000, "b")],
    [
      npc("caster-a", 28338, 1000, "a", { timingSource: "estimated" }),
      npc("caster-b", 28339, 1000, "b"),
    ],
    [
      npc("caster-a", 28338, 1000, "a", { outcome: "interrupted" }),
      npc("caster-b", 28339, 1000, "b"),
    ],
    [npc("caster-a", 28338, 1001, "a"), npc("caster-b", 28339, 1000, "b")],
    [npc("caster-a", 28338, 1000, "a"), npc("caster-b", 28339, 1000, "a")],
    [npc("caster-a", 28338, 1000, "a"), npc("caster-a", 28339, 1000, "b")],
    [...pair(), npc("caster-c", 28338, 1000, "b")],
    [
      { ...npc("caster-a", 28338, 1000, "a"), type: "Player" },
      npc("caster-b", 28339, 1000, "b"),
    ],
  ])
    assert.equal(recordedTransfers([...players, ...casts], []).size, 0);
});

test("missing, expired and explicitly non-player targets are never guessed", () => {
  for (const [target, time] of [
    [null, -4001],
    [null, 1001],
    ["pet", 900],
  ] as const) {
    const actors = [
      player("a", travel),
      player("b", travel),
      npc("caster-a", 28338, 1000, target),
      npc("caster-b", 28339, 1000, "b"),
    ];
    assert.equal(
      recordedTransfers(actors, [
        {
          t: time,
          kind: "damage",
          source: "caster-a",
          target: "a",
          melee: true,
        },
      ]).size,
      0,
    );
  }
  assert.equal(
    recordedTransfers(
      [
        player("a", travel),
        player("b", travel),
        npc("caster-a", 28338),
        npc("caster-b", 28339),
      ],
      [],
    ).size,
    0,
  );
});

test("ordinary movement and inadequate or late endpoint evidence have no fallback", () => {
  for (const samples of [
    [
      [900, 0, 0, null],
      [1500, 4, 0, null],
      [2000, 7, 0, null],
    ],
    [
      [900, 0, 0, null],
      [1500, 18, 0, null],
    ],
    [
      [900, 0, 0, null],
      [1500, 18, 0, null],
      [7500, 20, 0, null],
    ],
    [
      [0, 0, 0, null],
      [100, 20, 0, null],
      [900, 21, 0, null],
      [1500, 22, 0, null],
    ],
    [
      [900, 0, 0, null],
      [1500, 18, 0, null],
      [2000, 25, 0, null],
    ],
  ] satisfies MovementModeActor["samples"][])
    assert.equal(
      recordedTransfers(
        [player("a", samples), player("b", samples), ...pair()],
        [],
      ).size,
      0,
    );
});

test("duplicate and stale microintervals cannot prematurely end rapid travel", () => {
  const samples: MovementModeActor["samples"] = [
    [900, 0, 0, null],
    [1500, 18, 0, null],
    [1500, 18, 0, null],
    [1550, 18, 0, null],
    [1600, 18.1, 0, null],
    [2000, 30, 0, null],
    [2079, 30.605, 0, null],
  ];
  assert.deepEqual(
    recordedTransfers(
      [player("a", samples), player("b", samples), ...pair()],
      [],
    ).get("a"),
    [[1000, 2000]],
  );
  const stopped: MovementModeActor["samples"] = [
    [900, 0, 0, null],
    [1500, 18, 0, null],
    [1600, 18, 0, null],
  ];
  assert.deepEqual(
    recordedTransfers(
      [player("a", stopped), player("b", stopped), ...pair()],
      [],
    ).get("a"),
    [[1000, 1500]],
  );
});

test("generic coordinates reproduce both verified source-time completion patterns", () => {
  const a: MovementModeActor["samples"] = [
    [702559, 0, 0, null],
    [704477, 40, 0, null],
    [705891, 70, 0, null],
    [706082, 75, 0, null],
    [707465, 85.1, 0, null],
  ];
  const b: MovementModeActor["samples"] = [
    [702650, 0, 0, null],
    [703647, 20, 0, null],
    [704636, 40, 0, null],
    [705112, 50, 0, null],
    [705279, 55, 0, null],
    [705568, 62, 0, null],
    [705647, 62.605, 0, null],
  ];
  const combat = [
    { t: 702222, kind: "damage", source: "caster-a", target: "a", melee: true },
    { t: 702225, kind: "damage", source: "caster-b", target: "b", melee: true },
  ];
  assert.deepEqual(
    [
      ...recordedTransfers(
        [
          player("a", a),
          player("b", b),
          npc("caster-a", 28338, 702763),
          npc("caster-b", 28339, 702763),
        ],
        combat,
      ),
    ],
    [
      ["a", [[702763, 706082]]],
      ["b", [[702763, 705568]]],
    ],
  );
});

test("episodes are chronological and deduplicated without modifying source inputs", () => {
  const samples: MovementModeActor["samples"] = [
    ...travel,
    [7900, 31, 0, null],
    [8500, 49, 0, null],
    [9000, 61, 0, null],
    [9100, 61.7, 0, null],
  ];
  const actors = [
    player("a", samples, {
      initialAuras: [1706],
      auras: [[50, { reset: [] }]],
    }),
    player("b", samples),
    npc("caster-a", 28338, 8000, "a"),
    npc("caster-b", 28339, 8000, "b"),
    ...pair(),
    ...pair(),
  ];
  const before = structuredClone(actors);
  assert.deepEqual(recordedTransfers(actors, []).get("a"), [
    [1000, 2000],
    [8000, 9000],
  ]);
  slowFallModes(actors[0], 0, 100);
  assert.deepEqual(actors, before);
});

test("death during observed travel invalidates that player's episode", () => {
  assert.equal(
    recordedTransfers(
      [
        player("a", travel, { deaths: [[1800, true]] }),
        player("b", travel),
        ...pair(),
      ],
      [],
    ).has("a"),
    false,
  );
});

test("speed, displacement, stationary-duration and victim-age bounds are exact", () => {
  const episodes = (samples: MovementModeActor["samples"]) =>
    recordedTransfers(
      [player("a", samples), player("b", samples), ...pair()],
      [],
    ).get("a");
  assert.equal(
    episodes([
      [1000, 0, 0, null],
      [2000, 16, 0, null],
      [3000, 28, 0, null],
    ]),
    undefined,
  );
  assert.deepEqual(
    episodes([
      [1000, 0, 0, null],
      [2000, 17, 0, null],
      [3000, 29, 0, null],
    ]),
    [[1000, 2000]],
  );
  assert.deepEqual(
    episodes([
      [1000, 0, 0, null],
      [2000, 17, 0, null],
      [2025, 17.25, 0, null],
    ]),
    [[1000, 2000]],
  );
  assert.equal(
    episodes([
      [1000, 0, 0, null],
      [2000, 17, 0, null],
      [2099, 17, 0, null],
    ]),
    undefined,
  );
  assert.deepEqual(
    episodes([
      [1000, 0, 0, null],
      [6900, 120, 0, null],
      [7000, 120, 0, null],
    ]),
    [[1000, 6900]],
  );
  const actors = [
    player("a", travel),
    player("b", travel),
    npc("caster-a", 28338),
    npc("caster-b", 28339, 1000, "b"),
  ];
  assert.equal(
    recordedTransfers(actors, [
      {
        t: -4000,
        kind: "damage",
        source: "caster-a",
        target: "a",
        melee: true,
      },
    ]).has("a"),
    true,
  );
  assert.equal(
    recordedTransfers(actors, [
      { t: 1000, kind: "damage", source: "caster-a", target: "a", melee: true },
    ]).size,
    0,
  );
});

test("only the production damage kind supplies melee victim evidence", () => {
  const actors = [
    player("a", travel),
    player("b", travel),
    npc("caster-a", 28338),
    npc("caster-b", 28339, 1000, "b"),
  ];
  for (const kind of ["go", "DAMAGE", "heal", "cast", ""]) {
    assert.equal(
      recordedTransfers(actors, [
        { t: 900, kind, source: "caster-a", target: "a", melee: true },
      ]).size,
      0,
    );
  }
  assert.equal(
    recordedTransfers(actors, [
      { t: 900, kind: "damage", source: "caster-a", target: "a", melee: true },
    ]).has("a"),
    true,
  );
});

test("Levitate initial and reset-only aura context never launches", () => {
  assert.deepEqual(
    levitateLaunches(player("a", [], { initialAuras: [1706] }), 0, 100),
    [],
  );
  assert.deepEqual(
    levitateLaunches(
      player("a", [], {
        auras: [
          [20, { reset: [1706] }],
          [30, { spell: 1706 }],
        ],
      }),
      0,
      100,
    ),
    [],
  );
  assert.deepEqual(
    levitateLaunches(
      player("a", [], {
        initialAuras: [130],
        auras: [[20, { spell: 130 }]],
        casts: [
          {
            spell: 1706,
            end: 30,
            outcome: "completed",
            timingSource: "recorded",
          },
        ],
      }),
      0,
      100,
    ),
    [],
  );
});

test("actual Levitate grants launch once and removal permits reapplication", () => {
  const actor = player("a", [], {
    auras: [
      [20, { spell: 1706 }],
      [30, { spell: 1706 }],
      [40, { spell: 1706, remove: true }],
      [50, { spell: 1706 }],
      [60, { reset: [] }],
      [70, { spell: 1706 }],
    ],
  });
  const before = structuredClone(actor);
  assert.deepEqual(levitateLaunches(actor, 0, 100), [20, 50, 70]);
  assert.deepEqual(levitateLaunches(actor, 20, 50), [20, 50]);
  assert.deepEqual(levitateLaunches(actor, 21, 49), []);
  assert.deepEqual(levitateLaunches(actor, 70, 70), [70]);
  assert.deepEqual(levitateLaunches(actor, 100, 0), []);
  assert.deepEqual(actor, before);
});

test("death clears Levitate and suppresses a grant tied to its timestamp", () => {
  const actor = player("a", [], {
    initialAuras: [1706],
    auras: [
      [20, { spell: 1706 }],
      [30, { spell: 1706 }],
      [40, { spell: 1706, remove: true }],
      [50, { spell: 1706 }],
      [70, { spell: 1706 }],
    ],
    deaths: [
      [10, true],
      [15, false],
      [50, true],
      [60, false],
    ],
  });
  assert.deepEqual(levitateLaunches(actor, 0, 100), [20, 70]);
  assert.deepEqual(levitateLaunches(actor, 25, 100), [70]);
});

test("known paired targets retain unresolved starts until completion is observed", () => {
  const prefix = travel.slice(0, 2);
  const actors = [player("a", prefix), player("b", travel), ...pair()];
  assert.deepEqual(
    [...recordedTransferEvidence(actors, [])],
    [
      ["a", { complete: [], unresolved: [1000] }],
      ["b", { complete: [[1000, 2000]], unresolved: [] }],
    ],
  );
  assert.deepEqual([...recordedTransfers(actors, [])], [["b", [[1000, 2000]]]]);
  assert.deepEqual(
    recordedTransferEvidence([player("a", travel), ...actors.slice(1)], []).get(
      "a",
    ),
    { complete: [[1000, 2000]], unresolved: [] },
  );
  assert.deepEqual(
    recordedTransferEvidence(
      [player("a", travel, { deaths: [[1800, true]] }), ...actors.slice(1)],
      [],
    ).get("a"),
    { complete: [], unresolved: [1000] },
  );
});

test("unresolved transfer evidence never guesses missing pairs or unknown victims", () => {
  for (const casts of [
    [pair()[0]],
    [npc("caster-a", 28338), npc("caster-b", 28339, 1000, "b")],
    [...pair(), npc("caster-c", 28338, 1000, "b")],
  ]) {
    assert.equal(
      recordedTransferEvidence([player("a"), player("b"), ...casts], []).size,
      0,
    );
  }
});

test("complete and unresolved evidence are sorted, deduplicated and capped", () => {
  const casts = Array.from({ length: 130 }, (_, i) => {
    const time = 1000 + i * 8000;
    return [
      npc("caster-a", 28338, time, "a"),
      npc("caster-b", 28339, time, "b"),
    ];
  })
    .reverse()
    .flat();
  const samples = Array.from({ length: 130 }, (_, i) =>
    travel.map(([t, x, y, z]) => [t + i * 8000, x, y, z] as const),
  ).flat();
  const actors = [player("a", samples), player("b"), ...casts, ...casts];
  const before = structuredClone(actors);
  const evidence = recordedTransferEvidence(actors, []);
  assert.equal(evidence.get("a")?.complete.length, 128);
  assert.equal(evidence.get("b")?.unresolved.length, 128);
  assert.deepEqual(evidence.get("a")?.complete[0], [1000, 2000]);
  assert.deepEqual(evidence.get("a")?.complete[127], [1017000, 1018000]);
  assert.equal(evidence.get("b")?.unresolved[0], 1000);
  assert.equal(evidence.get("b")?.unresolved[127], 1017000);
  assert.deepEqual(actors, before);
});
