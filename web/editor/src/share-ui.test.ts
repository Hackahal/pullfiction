import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ShareDialog } from "./ShareDialog";
import { Turnstile } from "./Turnstile";
import { createTurnstileLoader, type TurnstileApi } from "./turnstile-loader";
import { saveOwnedShares, ownedShares, shareSnapshot } from "./share-client";
import { newProject } from "./project-store";
import { emptyPlan } from "./domain";
import type { EditorController } from "./controller";

async function mounted(
  run: (context: {
    dom: JSDOM;
    root: ReturnType<typeof createRoot>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost/",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    location: dom.window.location,
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
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ dom, root });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved)
      value
        ? Object.defineProperty(globalThis, key, value)
        : Reflect.deleteProperty(globalThis, key);
  }
}

test("successful remote deletion retains the warning when local record persistence fails", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await mounted(async ({ dom, root }) => {
      const share = {
        id: "a".repeat(32),
        deleteToken: "b".repeat(43),
        name: "Shared route",
      };
      saveOwnedShares([share], dom.window.localStorage);
      let remoteDeletes = 0;
      globalThis.fetch = async (_url, init) => {
        if (init?.method === "DELETE") {
          remoteDeletes++;
          return Response.json({ deleted: true });
        }
        return Response.json({ enabled: false });
      };
      const controller = {
        setTyping() {},
        setSceneFocused() {},
        getSnapshot: () => ({ playing: false }),
        projectShareSnapshot: async () =>
          shareSnapshot(newProject(emptyPlan())),
      } as unknown as EditorController;
      await act(async () =>
        root.render(
          createElement(ShareDialog, {
            controller,
            target: {},
            close() {},
            opened() {},
          }),
        ),
      );
      const dialog = dom.window.document.querySelector("dialog")!;
      assert.equal(dialog.getAttribute("role"), "dialog");
      assert.equal(dialog.getAttribute("aria-label"), "Share plan or run");
      const click = async (name: string) => {
        const button = [...dialog.querySelectorAll("button")].find(
          (button) => button.textContent === name,
        )!;
        assert.ok(button, name);
        await act(async () => button.click());
      };
      await click("Delete link");
      const prototype = Object.getPrototypeOf(dom.window.localStorage);
      const originalSet = prototype.setItem;
      prototype.setItem = () => {
        throw new Error("storage full");
      };
      try {
        await click("Confirm delete");
      } finally {
        prototype.setItem = originalSet;
      }
      assert.equal(remoteDeletes, 1);
      assert.match(
        dialog.querySelector('[role="status"]')!.textContent!,
        /local deletion record could not be cleared/,
      );
      assert.doesNotMatch(
        dialog.querySelector('[role="status"]')!.textContent!,
        /Existing local copies are unaffected/,
      );
      assert.equal(
        ownedShares(dom.window.localStorage).length,
        1,
        "failed persistence really leaves stale data",
      );
      assert.equal(
        dialog.querySelector('[aria-label="Links created in this browser"]'),
        null,
        "current UI removes the deleted link",
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Turnstile timeout removes script/handlers and retry ignores a delayed old callback", async (t) => {
  const dom = new JSDOM("<!doctype html><html><head></head></html>");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let api: TurnstileApi | undefined;
  const load = createTurnstileLoader(
    () => dom.window.document,
    () => api,
  );
  try {
    const first = load();
    assert.equal(
      load(),
      first,
      "closing/reopening during a pending load reuses one script",
    );
    const old = dom.window.document.querySelector("script")!;
    const delayed = old.onload!;
    const rejection = assert.rejects(first, /Verification did not load/);
    t.mock.timers.tick(15000);
    await rejection;
    assert.equal(old.onload, null);
    assert.equal(old.onerror, null);
    assert.equal(dom.window.document.querySelectorAll("script").length, 0);
    const second = load();
    const active = dom.window.document.querySelector("script")!;
    assert.notEqual(active, old);
    assert.equal(load(), second);
    assert.equal(dom.window.document.querySelectorAll("script").length, 1);
    delayed.call(old, new dom.window.Event("load"));
    assert.notEqual(
      active.onload,
      null,
      "stale callback cannot settle or clean the new attempt",
    );
    api = {
      render() {
        return "widget";
      },
      remove() {},
    };
    active.dispatchEvent(new dom.window.Event("load"));
    assert.equal(await second, api);
    assert.equal(active.onload, null);
    assert.equal(active.onerror, null);
    assert.equal(
      await load(),
      api,
      "ready library is reused without another script",
    );
    assert.equal(dom.window.document.querySelectorAll("script").length, 1);
  } finally {
    t.mock.timers.reset();
    dom.window.close();
  }
});

test("Turnstile load errors and a loaded script without an API both permit a clean retry", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head></html>");
  const load = createTurnstileLoader(
    () => dom.window.document,
    () => undefined,
  );
  try {
    for (const event of ["error", "load"]) {
      const pending = load();
      const script = dom.window.document.querySelector("script")!;
      const rejection = assert.rejects(pending, /Could not load|unavailable/);
      script.dispatchEvent(new dom.window.Event(event));
      await rejection;
      assert.equal(script.onload, null);
      assert.equal(script.onerror, null);
      assert.equal(dom.window.document.querySelectorAll("script").length, 0);
    }
  } finally {
    dom.window.close();
  }
});

test("widget callbacks after close cannot change token/error state; reopen reuses the ready library", async () => {
  await mounted(async ({ dom, root }) => {
    const calls: Record<string, unknown>[] = [],
      removed: string[] = [],
      tokens: string[] = [];
    dom.window.turnstile = {
      render(_container, options) {
        calls.push(options);
        return `widget-${calls.length}`;
      },
      remove(id) {
        removed.push(id);
      },
    };
    const onToken = (token: string) => tokens.push(token);
    await act(async () =>
      root.render(
        createElement(Turnstile, { siteKey: "public", attempt: 0, onToken }),
      ),
    );
    assert.equal(calls.length, 1);
    await act(async () => root.render(null));
    const count = tokens.length;
    await act(async () => {
      (calls[0].callback as (value: string) => void)("late token");
      (calls[0]["expired-callback"] as () => void)();
      (calls[0]["error-callback"] as () => void)();
    });
    assert.equal(tokens.length, count);
    assert.deepEqual(removed, ["widget-1"]);
    await act(async () =>
      root.render(
        createElement(Turnstile, { siteKey: "public", attempt: 1, onToken }),
      ),
    );
    assert.equal(calls.length, 2);
    assert.equal(dom.window.document.querySelectorAll("script").length, 0);
    await act(async () =>
      (calls[1].callback as (value: string) => void)("fresh token"),
    );
    assert.equal(tokens.at(-1), "fresh token");
  });
});
