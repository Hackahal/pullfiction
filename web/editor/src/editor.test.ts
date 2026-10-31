import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { DockWorkspace, DOCK_STORAGE } from "./DockWorkspace";
import {
  defaultDock,
  migrateFullHeightLeft,
  paneIds,
  type PaneId,
} from "./dock-model";
import { EditorController } from "./controller";
import { PageProperties } from "./Planning";
test("Timeline page details can select empty and notes-only pages", () => {
  const controller = new EditorController();
  controller.setWorkspaceMode("plan");
  controller.updateStep({ name: "Empty page" });
  controller.addStep();
  controller.updateStep({ name: "Notes page", notes: "Use the north wall" });
  controller.addStep();
  const markup = renderToString(
    createElement(PageProperties, {
      state: controller.getSnapshot(),
      controller,
    }),
  );
  const selector = markup.match(
    /<select[^>]*aria-label="Plan page"[^>]*>[\s\S]*?<\/select>/,
  )?.[0];
  assert.ok(selector);
  assert.match(selector, />Empty page<\/option>/);
  assert.match(selector, />Notes page<\/option>/);
  assert.equal((selector.match(/<option /g) ?? []).length, 3);
  controller.stop();
});
test("Editor can render before the game starts, with its scene, tools and accessible transport", () => {
  const controller = new EditorController();
  const markup = renderToString(createElement(App, { controller }));
  assert.match(markup, /id="benilla"/);
  assert.match(markup, /aria-label="Tools"/);
  assert.match(markup, /aria-label="Play"/);
  assert.match(markup, /aria-label="Dockable workspace"/);
  assert.equal((markup.match(/id="benilla"/g) ?? []).length, 1);
  assert.match(markup, /class="dock-workspace solo"/);
  assert.match(markup, /data-pane="timeline"[^>]*style="display:none"/);
  assert.match(markup, /Workspace mode/);
  assert.match(markup, /aria-label="Camera mode"/);
  assert.match(
    markup,
    /<option value="free" selected="">Free camera<\/option>/,
  );
  assert.doesNotMatch(markup, />Character<|Character mode/);
  assert.match(markup, />Analyse<\/button>/);
  assert.doesNotMatch(markup, /aria-label="Mark editor"/);
  assert.match(markup, /Damage graph/);
  assert.match(markup, /Healing graph/);
  assert.doesNotMatch(
    markup,
    /class="tool-rail"|class="icon-button"|Current damage graph/,
  );
  assert.doesNotMatch(markup, /Bring in the raid|Plan the run\.|replay-roster/);
  controller.stop();
});

test("Drawing defaults stay left, Edits docks independently, and page details belong to the timeline", () => {
  const controller = new EditorController();
  controller.setWorkspaceMode("plan");
  controller.setPlanning(true);
  const markup = renderToString(createElement(App, { controller }));
  const nav = markup.slice(markup.indexOf("<nav"), markup.indexOf("</nav>"));
  assert.match(nav, /Place marker/);
  assert.match(nav, /Markings/);
  assert.match(nav, /Raid markers|Default stroke/);
  assert.doesNotMatch(nav, /aria-label="Mark editor"|Move handles/);
  assert.doesNotMatch(nav, /Step notes|Follow replay|Damage graph/);
  assert.match(markup, /aria-label="Edits panel"/);
  const sections = markup.split(/(?=<section data-pane=)/),
    edits = sections.find((p) =>
      p.startsWith('<section data-pane="playbook"'),
    )!;
  assert.match(edits, /^<section[^>]*display:flex/);
  assert.match(edits, /aria-label="Saved edits"/);
  assert.doesNotMatch(edits, /aria-label="Page layer"|aria-label="Pages"/);
  const properties = renderToString(
    createElement(PageProperties, {
      state: controller.getSnapshot(),
      controller,
    }),
  );
  assert.match(properties, /aria-label="Page layer"/);
  assert.doesNotMatch(
    properties,
    /aria-label="Saved edits"|aria-label="Find edits"/,
  );
  assert.doesNotMatch(markup, /edits-tabs|aria-label="Plan contents"/);
  assert.doesNotMatch(
    markup,
    /data-pane="pages"|aria-label="Move Pages panel"|aria-label="Close Pages"/,
  );
  assert.match(markup, /Page details/);

  assert.match(
    markup,
    /data-pane="playbook"[^>]*[\s\S]*?aria-label="Edits panel"/,
  );
  assert.match(markup, /role="button"[^>]*aria-label="Move Edits panel"/);
  assert.match(markup, /aria-label="Edits panel actions"/);
  assert.equal((markup.match(/aria-label="Close Edits"/g) ?? []).length, 1);

  assert.match(markup, /aria-label="Saved edits"/);
  assert.match(markup, /aria-label="Scene editing controls"/);
  assert.match(markup, /Click to select · Drag to draw/);
  assert.doesNotMatch(markup, /Alt-drag to draw|Alt-click to place/);
  assert.doesNotMatch(markup, /Select underneath|scene-selection-menu/);
  assert.match(markup, /Frame<\/button>/);
  assert.match(markup, /editor-canvas/);
  assert.match(markup, /data-cursor="default"/);
  controller.stop();
});

test("All raids can be selected immediately without a replay or a ready native client", () => {
  const controller = new EditorController();
  const markup = renderToString(createElement(App, { controller }));
  const selector = markup.match(
    /<select[^>]*aria-label="Raid map"[^>]*>[\s\S]*?<\/select>/,
  )?.[0];
  assert.ok(selector);
  assert.doesNotMatch(selector, /disabled/);
  for (const map of [409, 249, 469, 309, 509, 531, 533])
    assert.match(selector, new RegExp(`value="${map}"`));
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(controller.getSnapshot().replay, null);
  controller.stop();
});

test("Planning without a log displays ordered layer pages on the run navigator and has no standalone timeline", () => {
  const c = new EditorController();
  c.setWorkspaceMode("plan");
  c.addLayer();
  const markup = renderToString(createElement(App, { controller: c }));
  assert.match(markup, /aria-label="Plan steps"/);
  assert.match(markup, /Layer 1 name/);
  assert.match(markup, /Layer 2 name/);
  assert.match(markup, /\+ Layer/);
  assert.doesNotMatch(
    markup,
    /class="plan-timeline"|class="run-ruler"|Step start seconds/,
  );
  c.stop();
});

test("Plan keeps Focus hidden even when it was saved open, and puts actor marking controls on the left", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key.includes("workspace.panels")
          ? '["inspector","run"]'
          : key.includes("runNavigator.docked")
            ? "1"
            : null,
      setItem: () => {},
    },
  });
  const c = new EditorController();
  try {
    c.setWorkspaceMode("plan");
    c.addPlanActor("Healer", "Priest");
    const plan = renderToString(createElement(App, { controller: c })),
      nav = plan.slice(plan.indexOf("<nav"), plan.indexOf("</nav>"));
    assert.doesNotMatch(plan, /class="focus-units"/);
    assert.match(nav, /aria-label="Raid markers"/);
    assert.match(nav, /Mark Healer: Skull/);
    assert.doesNotMatch(nav, /Default stroke/);
    c.setTool("circle");
    const drawing = renderToString(createElement(App, { controller: c }));
    assert.match(
      drawing.slice(drawing.indexOf("<nav"), drawing.indexOf("<\/nav>")),
      /Default stroke/,
    );
    assert.doesNotMatch(nav, /Draw on selected actor/);
    assert.match(plan, /aria-label="Move Run timeline panel"/);
    c.setWorkspaceMode("analyse");
    const analysis = renderToString(createElement(App, { controller: c }));
    assert.match(analysis, /class="focus-units"/);
  } finally {
    c.stop();
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("Run timeline keeps ruler, bosses and mobs in pinned groups above the layer tracks", () => {
  const c = new EditorController();
  c.installReplay({
    report: { code: "TEST", title: "Raid" },
    fight: {
      id: 1,
      name: "Lucifron",
      encounterID: 663,
      startTime: 1000,
      endTime: 11000,
      gameZone: { name: "Molten Core" },
      friendlyPlayers: [1],
    },
    actors: [
      { id: 1, name: "Mage", type: "Player", subType: "Mage" },
      { id: 2, name: "Lucifron", type: "NPC", gameID: 12118 },
    ],
    abilities: [],
    events: [],
  } as never);
  const markup = renderToString(createElement(App, { controller: c }));
  assert.match(markup, /data-pane="run"/);
  assert.match(markup, /class="run-fixed-labels"/);
  assert.match(markup, /class="run-fixed-tracks"/);
  assert.ok(
    markup.indexOf('class="run-bosses"') <
      markup.indexOf('class="plan-layer-tracks"'),
  );
  c.stop();
});

test("Retired Pages never reopens from old visibility preferences while Edits remains independent", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key.includes("workspace.panels") ? '["pages","run"]' : "1",
      setItem() {},
    },
  });
  const c = new EditorController();
  try {
    c.setWorkspaceMode("plan");
    c.setPlanning(true);
    const markup = renderToString(createElement(App, { controller: c }));
    assert.doesNotMatch(markup, /data-pane="pages"|>Pages<|plan-step-strip/);
    assert.match(markup, /Page details/);
    assert.match(markup, /data-pane="playbook"[^>]*display:flex/);
  } finally {
    c.stop();
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("Saved v1 workspaces upgrade the left column once; v2 restores later custom pane placements", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  // A real v1 shape, independent of the current default tree and new panes.
  const legacy = {
    axis: "column",
    ratio: 0.7,
    a: {
      axis: "row",
      ratio: 0.3,
      a: { pane: "playbook" },
      b: {
        axis: "column",
        ratio: 0.6,
        a: {
          axis: "row",
          ratio: 0.65,
          a: { pane: "scene" },
          b: {
            axis: "row",
            ratio: 0.6,
            a: { pane: "analysis" },
            b: {
              axis: "column",
              ratio: 0.5,
              a: { pane: "inspector" },
              b: {
                axis: "column",
                ratio: 0.5,
                a: { pane: "healing" },
                b: {
                  axis: "column",
                  ratio: 0.5,
                  a: { pane: "resources" },
                  b: { pane: "events" },
                },
              },
            },
          },
        },
        b: {
          axis: "row",
          ratio: 0.5,
          a: { pane: "damage" },
          b: { pane: "timeline" },
        },
      },
    },
    b: { pane: "run" },
  } as ReturnType<typeof defaultDock>;
  const visible = new Set<PaneId>(["scene", "playbook", "run"]);
  const render = (current: string | null, old: string | null) => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) =>
          key === `${DOCK_STORAGE}.plan`
            ? current
            : key === "pullfiction.workspace.layout.v1.plan"
              ? old
              : null,
        setItem() {},
      },
    });
    return renderToString(
      createElement(DockWorkspace, {
        mode: "plan",
        onOpen() {},
        onReset() {},
        panels: paneIds.map((id) => ({
          id,
          title: id,
          content: id,
          visible: visible.has(id),
        })),
      }),
    );
  };
  try {
    const upgraded = render(null, JSON.stringify(legacy)),
      restored = render(JSON.stringify(migrateFullHeightLeft(legacy)), null),
      custom = render(JSON.stringify(legacy), null);
    assert.equal(upgraded, restored);
    assert.notEqual(custom, upgraded);
    assert.match(upgraded, /Dock in left zone/);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
