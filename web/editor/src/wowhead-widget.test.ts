import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  widgetReferenceUrl,
  renderWidgetReference,
  referenceContextHtml,
  wowheadDataset,
  ensureWowheadWidget,
  WOWHEAD_WIDGET_URL,
} from "./wowhead-widget";
import { WowheadReference } from "./WidgetReference";
import { GameVersionContext } from "./Wowhead";
import { ReferenceHover, GearIcon } from "./FocusWidgets";

test("widget references separate Era and SoD and distinguish aura text from spell casts", () => {
  assert.equal(
    wowheadDataset("spell", 400624, "sod", { buff: true }),
    "domain=classic&spell=400624&dataEnv=4&buff=1",
  );
  assert.equal(
    wowheadDataset("spell", 116, "vanilla"),
    "domain=classic&spell=116",
  );
  assert.equal(wowheadDataset("item", -1, "sod"), undefined);
});
test("item context includes actual enchant and equipped pieces without confusing rune enchantments for spell IDs", () => {
  assert.equal(
    wowheadDataset("item", 100, "sod", {
      gear: {
        id: 100,
        slot: 0,
        permanentEnchant: 7634,
        temporaryEnchant: 6875,
      },
      equipped: [
        { id: 200, slot: 1 },
        { id: 100, slot: 0 },
        { id: 200, slot: 2 },
      ],
    }),
    "domain=classic&item=100&dataEnv=4&ench=7634&pcs=100:200",
  );
});
test("hover anchors carry widget references directly with no custom popup or loading timer", () => {
  const html = renderToString(
    createElement(
      GameVersionContext.Provider,
      { value: "sod" },
      createElement(ReferenceHover, {
        kind: "spell",
        id: 400624,
        title: "Hot Streak",
        buff: true,
        children: createElement(
          "a",
          { href: "https://www.wowhead.com/classic/spell=400624" },
          "Buff",
        ),
      }),
    ),
  );
  assert.match(
    html,
    /data-wowhead="domain=classic&amp;spell=400624&amp;dataEnv=4&amp;buff=1"/,
  );
  assert.match(html, /aria-label="Hot Streak"/);
  assert.doesNotMatch(html, /focus-tooltip|Loading|wowhead-reference/);
});
test("gear and its recorded rune have independent widget references", () => {
  const html = renderToString(
    createElement(GearIcon, {
      gear: {
        id: 100,
        slot: 9,
        name: "Gloves",
        icon: "inv_gauntlets_17",
        quality: 4,
      },
      rune: { slot: 9, enchant: 6875, name: "Water Shield", spellId: 408510 },
    }),
  );
  assert.match(html, /data-wowhead="domain=classic&amp;item=100"/);
  assert.match(html, /data-wowhead="domain=classic&amp;spell=408510"/);
  assert.match(html, /aria-label="Rune: Water Shield"/);
});
test("hosted widget loads once, keeps our icons/names and recovers from a failed load", async () => {
  const listeners = new Map<string, () => void>();
  let appended = 0,
    removed = 0;
  const script = {
    src: "",
    async: false,
    addEventListener: (kind: string, cb: () => void) => listeners.set(kind, cb),
    remove: () => removed++,
  };
  const host: { WH?: { Tooltips: object }; whTooltips?: unknown } = {};
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window"),
    oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: host,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => script, head: { append: () => appended++ } },
  });
  try {
    const first = ensureWowheadWidget();
    assert.equal(ensureWowheadWidget(), first);
    assert.equal(appended, 1);
    assert.equal(script.src, WOWHEAD_WIDGET_URL);
    assert.deepEqual(host.whTooltips, {
      colorLinks: false,
      iconizeLinks: false,
      renameLinks: false,
    });
    listeners.get("error")!();
    assert.equal(await first, false);
    assert.equal(removed, 1);
    const retry = ensureWowheadWidget();
    assert.equal(appended, 2);
    host.WH = { Tooltips: {} };
    listeners.get("load")!();
    assert.equal(await retry, true);
    assert.equal(await ensureWowheadWidget(), true);
    assert.equal(appended, 2);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("inline references use the hosted renderer, proper environment and their own aura mode", () => {
  const calls: unknown[][] = [];
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      WH: {
        Types: { ITEM: 3, SPELL: 6 },
        Tooltips: {
          replaceWithTooltip: (...args: unknown[]) => {
            calls.push(args);
            return true;
          },
        },
      },
    },
  });
  try {
    const element = {} as HTMLElement;
    assert.equal(
      renderWidgetReference(
        element,
        "spell",
        10157,
        "vanilla",
        false,
        "FOOTER",
      ),
      true,
    );
    assert.deepEqual(calls[0].slice(0, 6), [
      element,
      6,
      10157,
      2,
      undefined,
      {},
    ]);
    const transform = calls[0][6] as (
      html: string,
      entity: { data: { tooltip: string; buff: string } },
    ) => string;
    assert.equal(
      transform("wrong global aura mode", {
        data: { tooltip: "spell description", buff: "aura description" },
      }),
      "spell descriptionFOOTER",
    );
    renderWidgetReference(element, "spell", 10157, "sod", true, "");
    assert.equal(calls[1][3], 4);
    assert.deepEqual(calls[1][5], { buff: true });
    assert.equal(
      (calls[1][6] as typeof transform)("wrong spell mode", {
        data: { tooltip: "spell", buff: "aura" },
      }),
      "aura",
    );
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
test("logged context is text escaped and only validated class colours become styles", () => {
  const html = referenceContextHtml([
    { text: 'Mage <img src=x onerror=alert(1)> & "target"', color: "#40c7eb" },
    { text: "safe", color: "red; background:url(x)" },
  ]);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|background:url/);
  assert.match(html, /style="color:#40c7eb"/);
});
test("inline references keep an ordinary widget-enabled fallback link without the old HTML renderer", () => {
  const html = renderToString(
    createElement(
      GameVersionContext.Provider,
      { value: "sod" },
      createElement(WowheadReference, { kind: "spell", id: 10157 }),
    ),
  );
  assert.match(
    html,
    /data-wowhead="domain=classic&amp;spell=10157&amp;dataEnv=4"/,
  );
  assert.doesNotMatch(html, /wowhead-reference|Loading|wowhead-tooltip/);
});

test("embedded references open Wowhead in the correct environment rather than navigating the local editor", () => {
  assert.equal(
    widgetReferenceUrl("/classic/spell=10157/arcane-intellect", "sod"),
    "https://www.wowhead.com/classic/spell=10157/arcane-intellect?env=4",
  );
  assert.equal(
    widgetReferenceUrl("/classic/spell=116", "vanilla"),
    "https://www.wowhead.com/classic/spell=116",
  );
  assert.equal(widgetReferenceUrl("//other.example/path", "sod"), undefined);
  assert.equal(widgetReferenceUrl("javascript:", "vanilla"), undefined);
});
