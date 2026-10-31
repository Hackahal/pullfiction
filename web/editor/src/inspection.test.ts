import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TalentDistribution } from "./Inspection";
import { GearIcon } from "./FocusWidgets";
import type { Actor, Snapshot } from "./types";
const actor = { id: 1, class: "Warrior" } as Actor;
const state = {
  time: 0,
  replay: {
    duration: 1000,
    raw: {
      fight: { startTime: 0 },
      events: [
        {
          type: "combatantinfo",
          timestamp: 0,
          sourceID: 1,
          talents: [{ id: 17 }, { id: 34 }, { id: 0 }],
          talentTree: [],
        },
      ],
    },
  },
} as unknown as Snapshot;
test("equipment shows the recorded distribution without a talent tab or invented node allocations", () => {
  const html = renderToString(
    createElement(TalentDistribution, { actor, state, catalog: null }),
  );
  assert.match(html, /Arms: 17 points/);
  assert.match(html, /Fury: 34 points/);
  assert.match(html, /Protection: 0 points/);
  assert.doesNotMatch(html, /role="tab"/);
});
test("equipment identifies missing distribution instead of displaying a false zero build", () => {
  const html = renderToString(
    createElement(TalentDistribution, {
      actor,
      state: { ...state, replay: null },
      catalog: null,
    }),
  );
  assert.match(html, /Talent distribution not recorded/);
  assert.doesNotMatch(html, />0</);
});
test("equipped rune is included in the gear's accessible label and badge", () => {
  const html = renderToString(
    createElement(GearIcon, {
      gear: {
        id: 233608,
        slot: 9,
        name: "Wasphide Gauntlets",
        quality: 4,
        icon: "inv_gauntlets_17",
      },
      rune: { slot: 9, enchant: 6875, name: "Water Shield" },
    }),
  );
  assert.match(html, /Wasphide Gauntlets · Rune: Water Shield/);
  assert.match(html, /gear-rune-badge/);
});
