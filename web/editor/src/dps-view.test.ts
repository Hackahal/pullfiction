import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { normalizeReplay, enrichCombat } from "./domain";
import { Analysis } from "./Analysis";
import { DamageGraph } from "./DamageGraph";
import { EditorController } from "./controller";
import type { RawReplay } from "./types";
const replay = enrichCombat(
  normalizeReplay(
    {
      report: { code: "scope-oracle" },
      fight: {
        startTime: 0,
        endTime: 10000,
        friendlyPlayers: [1],
        gameZone: { name: "Molten Core" },
        chapters: [
          { id: 1, name: "First pull", startTime: 1000, endTime: 3000 },
          { id: 2, name: "Second pull", startTime: 6000, endTime: 8000 },
        ],
      },
      actors: [
        { id: 1, name: "Mage", type: "Player", subType: "Mage" },
        { id: 10, name: "Boss", type: "NPC" },
      ],
      abilities: [{ gameID: 133, name: "Fireball" }],
      events: [
        [1000, 10, 100],
        [1250, 1, 900],
        [2500, 10, 200],
        [7000, 10, 1000],
      ].map(([timestamp, targetID, amount]) => ({
        timestamp,
        targetID,
        amount,
        sourceID: 1,
        type: "damage",
        abilityGameID: 133,
      })),
    } as unknown as RawReplay,
    {},
  ),
  {},
);
function storage(t: any, getItem: (key: string) => string | null) {
  const d = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem, setItem() {} },
  });
  t.after(() => {
    if (d) Object.defineProperty(globalThis, "localStorage", d);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}
const body = (s: string) => s.match(/<tbody>(.*?)<\/tbody>/s)?.[1] ?? "";
test("Overall on a streamed single encounter waits for missing data in both meter and graph", (t) => {
  let view = "meter";
  storage(t, () => JSON.stringify({ window: "elapsed", view }));
  const c = new EditorController();
  t.after(() => c.stop());
  const partial = {
    ...replay,
    chapters: [],
    raw: {
      ...replay.raw,
      stream: {
        version: 1 as const,
        id: "single",
        revision: 1,
        full: [[0, 2000] as [number, number]],
        history: [],
        stateEvents: [],
        contextEvents: [],
        foreign: [],
        segments: 1,
        reportEnd: 10000,
      },
    },
  };
  for (view of ["meter", "graph"]) {
    const html = renderToString(
      createElement(Analysis, {
        state: {
          ...c.getSnapshot(),
          replay: partial,
          time: 4000,
          playing: false,
        },
        controller: c,
        close() {},
      }),
    );
    assert.match(html, /Loading this range/);
  }
});
test("Rendered Statistics and chart table use the same pull amount and exact DPS", (t) => {
  storage(t, () => null);
  const c = new EditorController();
  t.after(() => c.stop());
  for (const [clock, amount, dps] of [
    [1250, 100, 400],
    [2500, 300, 200],
    [4000, 300, 150],
  ]) {
    const state = { ...c.getSnapshot(), replay, time: clock, playing: false };
    const table = renderToString(
      createElement(DamageGraph, { state, controller: c, range: [0, 10000] }),
    );
    assert.ok(body(table).includes(`<td>${amount}</td>`));
    assert.ok(body(table).includes(`<td>${dps}</td>`));
    const meter = renderToString(
      createElement(Analysis, { state, controller: c, close() {} }),
    );
    const text = meter
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    assert.match(text, new RegExp(`${dps} DPS`));
    assert.doesNotMatch(meter, /NaN|Infinity/);
  }
  const state = { ...c.getSnapshot(), replay, time: 1000, playing: false };
  const zero = renderToString(
    createElement(DamageGraph, { state, controller: c, range: [0, 10000] }),
  );
  assert.ok(body(zero).includes("<td>—</td>"));
});
test("Historical chart defaults migrate once while v4 explicit choices remain valid", (t) => {
  let version = 3;
  storage(t, (key) =>
    key.endsWith(`.v${version}`)
      ? JSON.stringify({
          window: "timeline",
          hostility: "all",
          style: "bars",
          table: true,
        })
      : null,
  );
  const c = new EditorController();
  t.after(() => c.stop());
  const state = { ...c.getSnapshot(), replay, time: 2500, playing: false };
  const render = () =>
    renderToString(
      createElement(DamageGraph, { state, controller: c, range: [0, 10000] }),
    );
  const migrated = render();
  assert.match(migrated, /value="encounter" selected=""/);
  assert.match(migrated, /value="default" selected=""/);
  assert.match(migrated, /value="bars" selected=""/);
  assert.ok(body(migrated).includes("<td>300</td>"));
  version = 4;
  const explicit = render();
  assert.match(explicit, /value="timeline" selected=""/);
  assert.match(explicit, /value="all" selected=""/);
  assert.ok(body(explicit).includes("<td>1,200</td>"));
  assert.ok(body(explicit).includes("<td>480</td>"));
});
