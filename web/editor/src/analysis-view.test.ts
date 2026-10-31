import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Analysis } from "./Analysis";
import { EditorController } from "./controller";
import { normalizeReplay, enrichCombat } from "./domain";
import type { RawReplay } from "./types";

test("Ability meter rows retain full-width layout and hosted Wowhead references", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify({ view: "meter", group: "spell" }),
      setItem() {},
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const replay = enrichCombat(
    normalizeReplay(
      {
        report: { code: "test" },
        fight: {
          startTime: 0,
          endTime: 10000,
          friendlyPlayers: [1],
          gameZone: { name: "Molten Core" },
        },
        actors: [
          { id: 1, name: "Mage", type: "Player", subType: "Mage" },
          { id: 2, name: "Boss", type: "NPC" },
        ],
        abilities: [{ gameID: 133, name: "Fireball" }],
        events: [
          {
            timestamp: 1000,
            type: "damage",
            sourceID: 1,
            targetID: 2,
            abilityGameID: 133,
            amount: 100,
          },
        ],
      } as RawReplay,
      {},
    ),
    {},
  );
  const controller = new EditorController();
  t.after(() => controller.stop());
  const html = renderToString(
    createElement(Analysis, {
      state: {
        ...controller.getSnapshot(),
        replay,
        time: 2000,
        playing: false,
      },
      controller,
      close() {},
    }),
  );
  assert.match(
    html,
    /<a[^>]*class="meter-row"[^>]*data-wowhead="domain=classic(?:&amp;|&)spell=133"/,
  );
  assert.match(html, /class="analysis-reference"/);
  assert.doesNotMatch(html, /class="focus-icon-wrap"/);
  assert.match(html, /Current pull/);
  assert.match(html, /DPS/);
});
