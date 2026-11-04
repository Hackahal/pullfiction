import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorController } from "./controller";
import { MapView } from "./MapView";

test("playback keeps the tactical terrain while zoom and resize redraw both layers", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  let resize!: (width: number, height: number) => void;
  let resolutionChange: (() => void) | undefined;
  const loadedImages: HTMLImageElement[] = [];
  const contexts = new WeakMap<
    HTMLCanvasElement,
    { reset: number; fill: number }
  >();
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    value(this: HTMLCanvasElement) {
      let counts = contexts.get(this);
      if (!counts) {
        counts = { reset: 0, fill: 0 };
        contexts.set(this, counts);
      }
      const state = counts;
      return new Proxy(
        { reset: () => state.reset++, fill: () => state.fill++ },
        { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
      );
    },
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    Image: function () {
      const image = dom.window.document.createElement("img");
      loadedImages.push(image);
      return image;
    },
    devicePixelRatio: 1,
    matchMedia: () => ({
      addEventListener(_kind: string, listener: () => void) {
        resolutionChange = listener;
      },
      removeEventListener(_kind: string, listener: () => void) {
        if (resolutionChange === listener) resolutionChange = undefined;
      },
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback: (entries: unknown[]) => void) {
        resize = (width, height) =>
          callback([{ contentRect: { width, height } }]);
      }
      observe() {
        resize(1198, 442);
      }
      disconnect() {}
    },
    Path2D: class {
      moveTo() {}
      lineTo() {}
      closePath() {}
    },
    fetch: async () =>
      Response.json({
        map: 409,
        bounds: [-20, -20, 20, 20],
        tiles: [
          {
            src: "/tile.png",
            area: "floor",
            corners: [
              [0, 0],
              [0, -2],
              [-2, -2],
              [-2, 0],
            ],
          },
        ],
        areas: [{ id: "floor", name: "Floor", height: 0 }],
        floors: [
          {
            area: "floor",
            vertices: [
              [0, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
            ],
            indices: [0, 1, 2],
          },
        ],
      }),
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
  const node = dom.window.document.getElementById("root")!;
  const root = createRoot(node);
  const controller = new EditorController(undefined, { browserAssets: false });
  const state = controller.getSnapshot();
  const render = (time: number) =>
    act(async () =>
      root.render(
        createElement(MapView, { controller, state: { ...state, time } }),
      ),
    );
  try {
    await render(0);
    const terrain = node.querySelector<HTMLCanvasElement>(
      "canvas[aria-hidden]",
    )!;
    const playback =
      node.querySelector<HTMLCanvasElement>("canvas[aria-label]")!;
    assert.equal(terrain.width, 1198);
    assert.equal(playback.width, 1198);
    assert.equal(playback.tabIndex, 0);
    assert.ok(contexts.get(terrain)!.fill > 0, "fixture floor was drawn");
    const prior = {
      terrain: contexts.get(terrain)!.reset,
      playback: contexts.get(playback)!.reset,
    };
    for (let frame = 1; frame <= 20; frame++) await render(frame * 50);
    assert.equal(contexts.get(terrain)!.reset, prior.terrain);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 20);
    await act(async () =>
      playback.dispatchEvent(
        new dom.window.WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -10,
          clientX: 600,
          clientY: 200,
        }),
      ),
    );
    assert.equal(contexts.get(terrain)!.reset, prior.terrain + 1);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 21);
    await act(async () => resize(900, 380));
    assert.equal(terrain.width, 900);
    assert.equal(playback.width, 900);
    assert.equal(contexts.get(terrain)!.reset, prior.terrain + 2);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 22);
    const finishImage = (path: string) => {
      const image = loadedImages.find(
        (image) => image.getAttribute("src") === path,
      );
      assert.ok(image, `missing ${path}`);
      image.onload?.(new dom.window.Event("load"));
    };
    await act(async () => finishImage("/game-ui/class-icons.png"));
    assert.equal(contexts.get(terrain)!.reset, prior.terrain + 2);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 23);
    await act(async () => finishImage("/tile.png"));
    assert.equal(contexts.get(terrain)!.reset, prior.terrain + 3);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 23);
    await act(async () => {
      Object.defineProperty(globalThis, "devicePixelRatio", { value: 2 });
      assert.ok(resolutionChange);
      resolutionChange();
    });
    assert.equal(terrain.width, 1800);
    assert.equal(playback.width, 1800);
    assert.equal(contexts.get(terrain)!.reset, prior.terrain + 4);
    assert.equal(contexts.get(playback)!.reset, prior.playback + 24);
  } finally {
    await act(async () => root.unmount());
    controller.stop();
    dom.window.close();
    for (const [key, value] of saved)
      value
        ? Object.defineProperty(globalThis, key, value)
        : Reflect.deleteProperty(globalThis, key);
  }
});
