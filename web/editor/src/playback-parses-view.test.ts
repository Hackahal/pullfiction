import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PredictedParses, savedParseOptions } from "./PredictedParses";
import { Analysis } from "./Analysis";
import { EditorController } from "./controller";
import type { Replay } from "./types";
function storage(t: any, value: any) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(value), setItem() {} },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}
const replay = {
  gameVersion: "sod",
  report: { code: "4aMcj6kb7TwAN9vq" },
  fight: {
    id: 14,
    name: "Patchwerk",
    encounterID: 201118,
    friendlyPlayers: [1],
    kill: true,
  },
  raw: { events: [], actors: [] },
  actors: [{ key: "1:1", id: 1, type: "Player", name: "Mage", class: "Mage" }],
  chapters: [],
  abilities: new Map(),
  duration: 50316,
} as unknown as Replay;
test("all WCL switches are present and persisted values are validated", (t) => {
  storage(t, {
    compare: "Rankings",
    timeframe: "Historical",
    bracket: "itemLevel",
  });
  assert.deepEqual(savedParseOptions(), {
    compare: "Rankings",
    timeframe: "Historical",
    bracket: "itemLevel",
  });
  const c = new EditorController();
  t.after(() => c.stop());
  const html = renderToString(
    createElement(PredictedParses, {
      state: {
        ...c.getSnapshot(),
        replay,
        selected: "1:1",
        time: 1000,
        wclConnected: true,
      },
      controller: c,
    }),
  );
  for (const label of [
    "Parse comparison",
    "Parse timeframe",
    "Parse bracket",
    "Parses",
    "Rankings",
    "Historical",
    "Today",
    "Overall",
    "Item level",
  ])
    assert.ok(html.includes(label), label);
  assert.match(html, /Prediction unavailable for/);
  assert.match(html, /selected WCL result appears at the end/);
});
test("unranked, disconnected and pre-pull states explain missing predictions", (t) => {
  const c = new EditorController();
  t.after(() => c.stop());
  const render = (r: Replay | null, connected = false) =>
    renderToString(
      createElement(PredictedParses, {
        state: {
          ...c.getSnapshot(),
          replay: r,
          time: 1000,
          wclConnected: connected,
        },
        controller: c,
      }),
    );
  assert.match(render(replay), /Connect Warcraft Logs/);
  assert.match(render(null), /Move playback into a boss fight/);
  assert.match(
    render({ ...replay, fight: { ...replay.fight, kill: false } }, true),
    /This pull is a wipe/,
  );
});
test("Analysis exposes the parse view and can reopen it as the saved view", (t) => {
  storage(t, { view: "parses" });
  const c = new EditorController();
  t.after(() => c.stop());
  const html = renderToString(
    createElement(Analysis, {
      state: { ...c.getSnapshot(), replay, time: 1000 },
      controller: c,
      close() {},
    }),
  );
  assert.match(html, /Predicted parses/);
  assert.match(html, /Damage meter/);
});
test("invalid remembered options fall back to WCL report defaults", (t) => {
  storage(t, { compare: "wrong", timeframe: "yesterday", bracket: "rank" });
  assert.deepEqual(savedParseOptions(), {
    compare: "Parses",
    timeframe: "Today",
    bracket: "overall",
  });
});
