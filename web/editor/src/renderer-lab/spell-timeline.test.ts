import test from "node:test";
import assert from "node:assert/strict";
import { SMOKE_CASES } from "./cases";
import { applySpellActions, spellTimeline } from "./spell-timeline";

function fixture(
  stage: "cast" | "flight" | "aura" | "channel" | "summon",
  durationMs = 1500,
) {
  const c = structuredClone(SMOKE_CASES[2]);
  c.effects[0] = { ...c.effects[0], stage, startMs: 500, durationMs };
  return c;
}
const units = () =>
  ["caster", "target"].map((key) => ({
    key,
    cast: 0,
    channel: false,
    channel_target: null as string | null,
    auras: [] as number[],
    self_auras: [] as number[],
  }));

test("cast fixtures exercise windup and release at distinct authored ages", () => {
  const actions = spellTimeline(fixture("cast"));
  assert.deepEqual(
    actions.map((a) => [a.atMs, a.kind]),
    [
      [500, "cast-start"],
      [2000, "go"],
    ],
  );
  const bodies = units();
  assert.deepEqual(applySpellActions(bodies, actions.slice(0, 1)), {
    changed: true,
    events: [],
  });
  assert.equal(bodies[0].cast, 133);
  const released = applySpellActions(bodies, actions.slice(1));
  assert.equal(bodies[0].cast, 0);
  assert.deepEqual(released.events, [
    {
      kind: "go",
      spell: 133,
      source: "caster",
      target: "target",
      t: 2000,
      amount: 0,
    },
  ]);
});
test("self aura fixtures carry source provenance and remove it with the aura", () => {
  const c = fixture("aura");
  c.effects[0].targetId = "caster";
  const actions = spellTimeline(c),
    bodies = units();
  applySpellActions(bodies, actions.slice(0, 1));
  assert.deepEqual(bodies[0].self_auras, [133]);
  applySpellActions(bodies, actions.slice(1));
  assert.deepEqual(bodies[0].self_auras, []);
  const other = units();
  applySpellActions(other, spellTimeline(fixture("aura")).slice(0, 1));
  assert.deepEqual(other[1].self_auras, []);
});
test("launch and instant-cast fixtures emit one Go rather than a sample-boundary duplicate", () => {
  for (const c of [fixture("flight"), fixture("cast", 0)]) {
    const actions = spellTimeline(c);
    assert.deepEqual(
      actions.map((a) => [a.atMs, a.kind]),
      [[500, "go"]],
    );
  }
});
test("aura fixtures add/remove the target's ordinary active-aura snapshot", () => {
  const actions = spellTimeline(fixture("aura"));
  const bodies = units();
  applySpellActions(bodies, actions.slice(0, 1));
  assert.deepEqual(bodies[0].auras, []);
  assert.deepEqual(bodies[1].auras, [133]);
  applySpellActions(bodies, actions.slice(1));
  assert.deepEqual(bodies[1].auras, []);
});
test("channel fixtures use the native channel field and explicitly end it", () => {
  const actions = spellTimeline(fixture("channel"));
  const bodies = units();
  applySpellActions(bodies, actions.slice(0, 1));
  assert.equal(bodies[0].cast, 133);
  assert.equal(bodies[0].channel, true);
  assert.equal(bodies[0].channel_target, "target");
  applySpellActions(bodies, actions.slice(1));
  assert.equal(bodies[0].cast, 0);
  assert.equal(bodies[0].channel, false);
  assert.equal(bodies[0].channel_target, null);
});
test("channel fixtures retain only their explicit endpoint when retargeting", () => {
  const bodies = units();
  const first = spellTimeline(fixture("channel"))[0];
  applySpellActions(bodies, [first]);
  const second = structuredClone(first);
  second.effect.targetId = "caster";
  applySpellActions(bodies, [second]);
  assert.equal(bodies[0].channel_target, "caster");
  delete second.effect.targetId;
  applySpellActions(bodies, [second]);
  assert.equal(bodies[0].channel_target, null);
});
test("summon fixtures explicitly exercise the illustrative cue rather than claiming a summon model", () => {
  const actions = spellTimeline(fixture("summon"));
  assert.deepEqual(
    applySpellActions(units(), actions).events.map((e) => e.kind),
    ["summon-cue"],
  );
});
test("unsupported stages and missing native hosts cannot earn rendering credit", () => {
  const c = fixture("cast");
  c.effects[0].stage = "impact";
  assert.throws(() => spellTimeline(c), { name: "RendererFixtureUnsupported" });
  c.effects[0].stage = "cast";
  c.actors[0].kind = "synthetic";
  assert.throws(() => spellTimeline(c), /native character or creature host/);
});
test("raw models cannot bypass lifecycle validation by also specifying a spell", () => {
  for (const stage of [
    "cast",
    "flight",
    "aura",
    "channel",
    "summon",
    "model",
  ] as const) {
    const c = fixture("cast");
    Object.assign(c.effects[0], { modelFileId: 123, stage });
    assert.throws(() => spellTimeline(c), /raw model lifecycle/);
  }
  const c = fixture("cast");
  c.effects = [
    {
      id: "raw",
      modelFileId: 123,
      stage: "model",
      startMs: 0,
      durationMs: 1000,
    },
  ];
  assert.deepEqual(spellTimeline(c), []);
  c.effects[0].startMs = 500;
  assert.throws(() => spellTimeline(c), /raw model lifecycle/);
});
