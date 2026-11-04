import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { Library } from "./Library";
import { EditorController } from "./controller";
import type { Snapshot } from "./types";

test("asset recovery replaces blocking replay progress in the editor and library", () => {
  const controller = new EditorController(undefined, { projectStore: null });
  const patch = (values: Partial<Snapshot>) =>
    (controller as unknown as { patch(values: Partial<Snapshot>): void }).patch(
      values,
    );
  patch({
    browserAssets: true,
    clientStatus: "ready",
    sceneReady: true,
    clientNeedsFiles: true,
    busy: true,
    replayPreparation: { message: "Preparing replay", completed: 2, total: 3 },
  });
  const render = () => {
    const app = renderToStaticMarkup(createElement(App, { controller }));
    const library = renderToStaticMarkup(
      createElement(Library, {
        controller,
        state: controller.getSnapshot(),
        initialTab: "projects",
        close: () => {},
        share: () => {},
      }),
    );
    return new JSDOM(app + library).window;
  };
  try {
    const recovery = render();
    for (const selector of [
      ".viewport",
      ".library-backdrop:not(.library-landing)",
    ]) {
      const surface = recovery.document.querySelector(selector)!;
      const buttons = [...surface.querySelectorAll(".browser-client button")];
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        ["Retry download", "Cancel loading"],
      );
      assert.doesNotMatch(surface.textContent!, /Preparing replay/);
    }
    recovery.close();
    patch({ busy: false, buffering: true, bufferError: "Try replay again" });
    const buffering = render();
    assert.doesNotMatch(
      buffering.document.querySelector(".viewport")!.textContent!,
      /Try replay again/,
    );
    buffering.close();
    patch({ clientNeedsFiles: false });
    const restored = render();
    assert.match(
      restored.document.querySelector(".viewport")!.textContent!,
      /Try replay again/,
    );
    restored.close();
  } finally {
    controller.stop();
  }
});
