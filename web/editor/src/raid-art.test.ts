import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RaidArt } from "./RaidArt";

test("a failed raid image does not suppress artwork when selecting another map", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(createElement(RaidArt, { map: 409, version: "vanilla" })),
    );
    const first = element.querySelector("img")!;
    assert.match(first.src, /zone-2000/);
    await act(async () => first.dispatchEvent(new dom.window.Event("error")));
    assert.equal(element.querySelector("img"), null);
    await act(async () =>
      root.render(createElement(RaidArt, { map: 469, version: "vanilla" })),
    );
    assert.match(element.querySelector("img")!.src, /zone-2002/);
    assert.equal(element.querySelector("img")!.alt, "Blackwing Lair");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved)
      value
        ? Object.defineProperty(globalThis, key, value)
        : Reflect.deleteProperty(globalThis, key);
  }
});
