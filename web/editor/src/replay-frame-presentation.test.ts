import test from "node:test";
import assert from "node:assert/strict";
import { combatStateAt, frameCombatStateAt } from "./domain";
import { ReplayFramePresentation } from "./replay-frame-presentation";
import type { Actor } from "./types";

test("frame aura snapshots are reused until the timeline or spell catalog changes", () => {
  const actor = {
    key: "1:1",
    auras: [
      [
        20,
        { spell: 5, name: "Log name", stack: 2, debuff: true, selfCast: true },
      ],
    ],
  } as Actor;
  const presentation = new ReplayFramePresentation();
  const abilities = new Map([[5, { name: "Client name", icon: "client.blp" }]]);
  const at = (t: number) => frameCombatStateAt(actor, t).auras;
  const forward = presentation.auras(at(20), abilities);
  assert.deepEqual(forward, {
    plate_auras: [
      {
        spell: 5,
        name: "Client name",
        icon: "client.blp",
        stack: 2,
        debuff: true,
      },
    ],
    auras: [5],
    self_auras: [5],
  });
  assert.equal(presentation.auras(at(21), abilities), forward);
  const inspection = combatStateAt(actor, 21);
  inspection.auras.length = 0;
  assert.equal(presentation.auras(at(21), abilities), forward);
  assert.deepEqual(presentation.auras(at(19), abilities).auras, []);
  const refreshed = presentation.auras(at(21), new Map());
  assert.equal(refreshed.plate_auras[0].name, "Log name");
  assert.equal(forward.plate_auras[0].name, "Client name");
});
