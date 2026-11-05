import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";
import { Analysis } from "./Analysis";
import { EditorController } from "./controller";
import { normalizeReplay, enrichCombat } from "./domain";
import type { RawReplay, RecordedEventDetail } from "./types";

function eventReplay() {
  return enrichCombat(
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
}

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
  const replay = eventReplay();
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

test("Combat event details stay in their panel, focus the tray and restore the selected source", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    MouseEvent: dom.window.MouseEvent,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const controller = new EditorController();
  const seeks: number[] = [];
  const selections: (RecordedEventDetail | null)[] = [];
  const onEventSelection = (event: RecordedEventDetail | null) =>
    selections.push(event);
  const focused: string[] = [];
  controller.focusRecordedActor = (key) => {
    focused.push(key);
    return true;
  };
  controller.canFocusRecordedActor = (key) => key === "1:1";
  controller.seek = (time) => {
    seeks.push(time);
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    const replay = eventReplay();
    const state = {
      ...controller.getSnapshot(),
      replay,
      time: 2000,
      playing: false,
      workspaceMode: "analyse" as const,
    };
    const prePullReplay = {
      ...replay,
      chapters: [{ id: 1, name: "Boss", start: 1000, end: 10000 }],
      raw: {
        ...replay.raw,
        events: [
          {
            timestamp: 500,
            type: "damage",
            sourceID: 1,
            targetID: 2,
            abilityGameID: 133,
            amount: 100,
          },
          ...replay.raw.events,
        ],
      },
    };
    await act(async () =>
      root.render(
        createElement(Analysis, {
          state: { ...state, replay: prePullReplay, time: 0 },
          controller,
          close() {},
          preset: { view: "events" },
          onEventSelection,
        }),
      ),
    );
    const firstMatch = Array.from(
      dom.window.document.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Go to first match"));
    assert.ok(firstMatch);
    await act(async () => firstMatch.click());
    assert.deepEqual(seeks.splice(0), [1000]);
    assert.equal(
      dom.window.document.activeElement?.getAttribute("aria-label"),
      "Recorded event list",
    );
    await act(async () =>
      root.render(
        createElement(Analysis, {
          state,
          controller,
          close() {},
          preset: { view: "events" },
          onEventSelection,
        }),
      ),
    );
    const trigger = dom.window.document.querySelector<HTMLElement>(
      ".combat-event-ability button",
    )!;
    assert.ok(trigger);
    assert.equal(
      trigger.closest(".combat-event-list")?.querySelector("[data-wowhead]"),
      null,
    );
    await act(async () => trigger.click());
    const tray = dom.window.document.querySelector<HTMLElement>(
      '[aria-label="Selected combat event"]',
    )!;
    assert.ok(tray?.closest(".analysis-panel"));
    assert.match(
      tray.querySelector<HTMLAnchorElement>(".widget-reference a")?.href ?? "",
      /wowhead\.com\/classic\/spell=133/,
    );
    assert.equal(trigger.getAttribute("aria-controls"), tray.id);
    assert.equal(dom.window.document.activeElement, tray);
    assert.match(tray.textContent ?? "", /Fireball.*Mage.*Boss.*100/);
    assert.equal(selections.at(-1)?.t, 1000);
    assert.equal(selections.at(-1)?.name, "Fireball");
    assert.deepEqual(seeks, []);
    assert.equal(controller.getSnapshot().detail, null);
    const source = tray.querySelector<HTMLButtonElement>(
      '[aria-label="Focus source: Mage"]',
    )!;
    const target = tray.querySelector<HTMLButtonElement>(
      '[aria-label="Focus target: Boss"]',
    )!;
    assert.equal(source.getAttribute("aria-disabled"), "false");
    assert.equal(target.getAttribute("aria-disabled"), "true");
    await act(async () => {
      source.click();
      target.click();
    });
    assert.deepEqual(focused, ["1:1"]);
    assert.deepEqual(seeks, []);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    await act(async () =>
      tray
        .querySelector<HTMLElement>('[title="Jump playhead to event"]')!
        .click(),
    );
    assert.deepEqual(seeks, [1000]);
    await act(async () =>
      tray.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(
      dom.window.document.querySelector('[aria-label="Selected combat event"]'),
      null,
    );
    assert.equal(dom.window.document.activeElement, trigger);
    assert.equal(selections.at(-1), null);
    await act(async () => trigger.click());
    await act(async () =>
      root.render(
        createElement(Analysis, {
          state: { ...state, replay: eventReplay() },
          controller,
          close() {},
          preset: { view: "events" },
          onEventSelection,
        }),
      ),
    );
    assert.equal(
      dom.window.document.querySelector('[aria-label="Selected combat event"]'),
      null,
    );
    assert.equal(selections.at(-1), null);
  } finally {
    await act(async () => root.unmount());
    controller.stop();
    dom.window.close();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
