import test from "node:test";
import assert from "node:assert/strict";
import {
  dockDropAt,
  applyDockDrop,
  dockLeft,
  migrateFullHeightLeft,
  defaultDock,
  readPanels,
  parseDock,
  moveDock,
  resizeDock,
  dockGeometry,
  paneIds,
  type PaneId,
  type Edge,
} from "./dock-model";
function ids(n: ReturnType<typeof defaultDock>): string[] {
  return "pane" in n ? [n.pane] : [...ids(n.a), ...ids(n.b)];
}
test("Default workspace puts damage left of timeline in an equal lower split", () => {
  const g = dockGeometry(
    defaultDock(),
    new Set<PaneId>(["scene", "damage", "timeline"]),
    1000,
    700,
  );
  assert.equal(g.panes.damage!.width, g.panes.timeline!.width);
  assert.ok(g.panes.damage!.x < g.panes.timeline!.x);
  assert.equal(g.panes.damage!.y, g.panes.timeline!.y);
  assert.ok(g.panes.scene!.y < g.panes.damage!.y);
});
test("Docking every panel on every edge preserves all unique pane identities", () => {
  const root = defaultDock();
  for (const source of paneIds)
    for (const target of paneIds)
      for (const edge of ["left", "right", "top", "bottom"] as Edge[]) {
        const moved = moveDock(root, source, target, edge);
        assert.deepEqual(ids(moved).sort(), [...paneIds].sort());
        assert.deepEqual(parseDock(JSON.stringify(moved)), moved);
        if (source !== target) {
          const g = dockGeometry(moved, new Set(paneIds), 1000, 700).panes,
            a = g[source]!,
            b = g[target]!;
          if (edge === "left") assert.ok(a.x < b.x);
          if (edge === "right") assert.ok(a.x > b.x);
          if (edge === "top") assert.ok(a.y < b.y);
          if (edge === "bottom") assert.ok(a.y > b.y);
        }
      }
  assert.deepEqual(root, defaultDock());
});
test("Closing a panel collapses empty space without deleting its saved placement", () => {
  const root = moveDock(defaultDock(), "inspector", "timeline", "left");
  const hidden = dockGeometry(
    root,
    new Set<PaneId>(["scene", "damage", "timeline"]),
    1000,
    700,
  );
  assert.equal(hidden.panes.inspector, undefined);
  const shown = dockGeometry(root, new Set(paneIds), 1000, 700);
  assert.ok(shown.panes.inspector!.x < shown.panes.timeline!.x);
  assert.equal(ids(root).length, paneIds.length);
});
test("Malformed saved layouts reset safely; split resizing clamps and survives save/restore", () => {
  for (const value of [
    "bad",
    "null",
    "{}",
    JSON.stringify({ pane: "scene" }),
    JSON.stringify({ ...defaultDock(), ratio: NaN }),
    JSON.stringify({
      axis: "row",
      ratio: 0.5,
      a: { pane: "scene" },
      b: { pane: "scene" },
    }),
  ])
    assert.deepEqual(parseDock(value), defaultDock());
  const root = defaultDock(),
    resized = resizeDock(root, "", 2);
  assert.equal("pane" in resized ? 0 : resized.ratio, 0.9);
  assert.deepEqual(parseDock(JSON.stringify(resized)), resized);
  assert.deepEqual(root, defaultDock());
});

test("Fresh panel visibility is game only, and saved visibility rejects unknown or duplicated panels", async () => {
  const { readPanels } = await import("./dock-model");
  assert.deepEqual(readPanels(null), []);
  assert.deepEqual(readPanels("bad"), []);
  assert.deepEqual(readPanels('["damage","scene","damage","healing","bad"]'), [
    "damage",
    "healing",
  ]);
});
test("Legacy five-panel dock placements migrate without losing their visible geometry", () => {
  const legacy = {
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
        b: { pane: "inspector" },
      },
    },
    b: {
      axis: "row",
      ratio: 0.5,
      a: { pane: "damage" },
      b: { pane: "timeline" },
    },
  };
  const restored = parseDock(JSON.stringify(legacy));
  assert.equal(ids(restored).length, paneIds.length);
  const geometry = dockGeometry(
    restored,
    new Set<PaneId>(["scene", "damage", "timeline"]),
    1000,
    700,
  );
  assert.equal(geometry.panes.damage!.width, geometry.panes.timeline!.width);
});

test("Playbook can dock on any scene edge, resize, hide and restore its saved position", () => {
  for (const edge of ["left", "right", "top", "bottom"] as Edge[]) {
    const layout = moveDock(defaultDock(), "playbook", "scene", edge);
    const restored = parseDock(JSON.stringify(layout));
    const geometry = dockGeometry(
      restored,
      new Set<PaneId>(["scene", "playbook"]),
      1200,
      800,
    );
    assert.ok(geometry.panes.playbook);
    assert.equal(geometry.dividers.length, 1);
    const divider = geometry.dividers[0];
    const resized = resizeDock(restored, divider.path, 0.3);
    const after = dockGeometry(
      resized,
      new Set<PaneId>(["scene", "playbook"]),
      1200,
      800,
    );
    assert.notDeepEqual(after.panes.playbook, geometry.panes.playbook);
    assert.equal(
      dockGeometry(resized, new Set<PaneId>(["scene"]), 1200, 800).panes
        .playbook,
      undefined,
    );
    assert.deepEqual(parseDock(JSON.stringify(resized)), resized);
  }
});

test("Layouts saved before Playbook docking keep existing panel placements", () => {
  const oldLayout = coreLegacy();
  const restored = parseDock(JSON.stringify(oldLayout));
  assert.deepEqual(
    dockGeometry(
      restored,
      new Set<PaneId>(["scene", "damage", "timeline"]),
      1200,
      800,
    ).panes,
    dockGeometry(
      oldLayout,
      new Set<PaneId>(["scene", "damage", "timeline"]),
      1200,
      800,
    ).panes,
  );
  const visible = dockGeometry(
    restored,
    new Set<PaneId>(["scene", "playbook"]),
    1200,
    800,
  ).panes;
  assert.ok(visible.playbook!.x < visible.scene!.x);
  function coreLegacy() {
    const root = defaultDock();
    if ("pane" in root) throw Error("Expected split");
    if ("pane" in root.b || "pane" in root.b.a)
      throw Error("Expected legacy content");
    return root.b.a;
  }
});

test("Pointer docking resolves all target edges from geometry even over native canvas content", () => {
  const panes = {
    scene: { x: 100, y: 0, width: 800, height: 600 },
    playbook: { x: 0, y: 0, width: 90, height: 600 },
  };
  assert.deepEqual(dockDropAt(panes, "playbook", 105, 300), {
    pane: "scene",
    edge: "left",
  });
  assert.deepEqual(dockDropAt(panes, "playbook", 895, 300), {
    pane: "scene",
    edge: "right",
  });
  assert.deepEqual(dockDropAt(panes, "playbook", 500, 5), {
    pane: "scene",
    edge: "top",
  });
  assert.deepEqual(dockDropAt(panes, "playbook", 500, 595), {
    pane: "scene",
    edge: "bottom",
  });
  assert.equal(dockDropAt(panes, "playbook", 40, 300), null);
  assert.equal(dockDropAt(panes, "playbook", 950, 300), null);
});

test("Run timeline docks at the bottom by default and can move and resize like other panes", () => {
  const visible = new Set<PaneId>(["scene", "run"]),
    base = defaultDock();
  let g = dockGeometry(base, visible, 1200, 800);
  assert.ok(g.panes.run!.y > g.panes.scene!.y);
  const moved = moveDock(base, "run", "scene", "left");
  g = dockGeometry(moved, visible, 1200, 800);
  assert.ok(g.panes.run!.x < g.panes.scene!.x);
  const divider = dockGeometry(base, visible, 1200, 800).dividers.find(
    (d) => d.axis === "column",
  )!;
  const resized = resizeDock(base, divider.path, 0.5),
    r = dockGeometry(resized, visible, 1200, 800);
  assert.ok(
    r.panes.run!.height >
      dockGeometry(base, visible, 1200, 800).panes.run!.height,
  );
  assert.deepEqual(parseDock(JSON.stringify(moved)), moved);
});

test("Retired Pages leaves collapse without resetting other saved docking positions", () => {
  const current = moveDock(defaultDock(), "playbook", "scene", "right");
  function legacy(node: ReturnType<typeof defaultDock>): unknown {
    return "pane" in node
      ? node.pane === "playbook"
        ? { axis: "column", ratio: 0.45, a: { pane: "pages" }, b: node }
        : node
      : { ...node, a: legacy(node.a), b: legacy(node.b) };
  }
  const restored = parseDock(JSON.stringify(legacy(current)));
  assert.deepEqual(restored, current);
  assert.ok(!ids(restored).includes("pages"));
  assert.deepEqual(readPanels('["pages","run","damage"]'), ["run", "damage"]);
});

test("Left zone spans the full height while Run and cast timelines stay in the main area", () => {
  const visible = new Set<PaneId>([
      "scene",
      "playbook",
      "run",
      "timeline",
      "damage",
    ]),
    root = defaultDock(),
    g = dockGeometry(root, visible, 1400, 900);
  assert.equal(g.panes.playbook!.x, 0);
  assert.equal(g.panes.playbook!.y, 0);
  assert.equal(g.panes.playbook!.x, 0);
  assert.equal(g.panes.playbook!.y + g.panes.playbook!.height, 900);
  assert.equal(g.panes.run!.x, g.panes.scene!.x);
  assert.ok(g.panes.run!.x > g.panes.playbook!.width);
  assert.ok(g.panes.timeline!.x > g.panes.playbook!.width);
  const resized = dockGeometry(resizeDock(root, "", 0.35), visible, 1400, 900);
  assert.ok(resized.panes.run!.x > g.panes.run!.x);
  assert.equal(resized.panes.run!.height, g.panes.run!.height);
  const collapsed = dockGeometry(
    root,
    new Set<PaneId>(["scene", "run"]),
    1400,
    900,
  );
  assert.equal(collapsed.panes.run!.x, 0);
  assert.equal(collapsed.panes.run!.width, 1400);
});

test("Legacy left-over-timeline layout migrates ratios and identities without resetting other arrangements", () => {
  const modern = defaultDock();
  if ("pane" in modern || "pane" in modern.b) throw Error("Expected main area");
  const legacy = {
    axis: "column",
    ratio: 0.68,
    a: { axis: "row", ratio: 0.31, a: modern.a, b: modern.b.a },
    b: modern.b.b,
  } as ReturnType<typeof defaultDock>;
  const upgraded = migrateFullHeightLeft(legacy);
  const visible = new Set<PaneId>(["scene", "playbook", "run"]),
    before = dockGeometry(legacy, visible, 1200, 800),
    after = dockGeometry(upgraded, visible, 1200, 800);
  assert.equal(after.panes.playbook!.width, before.panes.playbook!.width);
  assert.equal(after.panes.run!.height, before.panes.run!.height);
  assert.equal(after.panes.playbook!.y + after.panes.playbook!.height, 800);
  assert.ok(after.panes.run!.x > 0);
  assert.deepEqual(ids(upgraded).sort(), [...paneIds].sort());
  assert.deepEqual(migrateFullHeightLeft(upgraded), upgraded);
  assert.deepEqual(
    parseDock(JSON.stringify(legacy)),
    legacy,
    "ordinary restore preserves later custom layouts",
  );
  const custom = moveDock(modern, "run", "scene", "right");
  assert.deepEqual(migrateFullHeightLeft(custom), custom);
});

test("Workspace left-edge drops stack panes in one full-height column without duplicate identities", () => {
  let root = defaultDock();
  const visible = new Set<PaneId>(["scene", "playbook", "run", "damage"]),
    workspace = { x: 0, y: 0, width: 1200, height: 800 };
  let panes = dockGeometry(root, visible, 1200, 800).panes;
  for (const y of [0, 100, 799])
    assert.deepEqual(dockDropAt(panes, "damage", 10, y, workspace), {
      pane: "scene",
      edge: "left",
      workspace: true,
    });
  assert.equal(dockDropAt(panes, "damage", -1, 100, workspace), null);
  assert.equal(dockDropAt(panes, "damage", 10, 801, workspace), null);
  const drop = dockDropAt(panes, "damage", 10, 799, workspace)!;
  root = applyDockDrop(root, "damage", drop);
  let g = dockGeometry(root, visible, 1200, 800);
  assert.equal(g.panes.damage!.x, 0);
  assert.equal(g.panes.damage!.y + g.panes.damage!.height, 800);
  assert.ok(g.panes.run!.x > g.panes.damage!.width);
  for (const pane of ["damage", "playbook"] as PaneId[])
    root = dockLeft(root, pane);
  assert.deepEqual(ids(root).sort(), [...paneIds].sort());
  assert.deepEqual(parseDock(JSON.stringify(root)), root);
  g = dockGeometry(root, visible, 1200, 800);
  assert.ok(g.panes.run!.x > 0);
});

test("Speedrun timer defaults to a tall right panel and migrates without moving existing panes", () => {
  const root = defaultDock();
  const geometry = dockGeometry(
    root,
    new Set<PaneId>(["scene", "run", "speedrun"]),
    1000,
    700,
  ).panes;
  assert.equal(geometry.speedrun!.height, 700);
  assert.ok(geometry.speedrun!.x > geometry.scene!.x);
  const old = {
    axis: "column",
    ratio: 0.74,
    a: {
      axis: "row",
      ratio: 0.65,
      a: { pane: "scene" },
      b: {
        axis: "row",
        ratio: 0.6,
        a: { pane: "analysis" },
        b: { pane: "inspector" },
      },
    },
    b: {
      axis: "row",
      ratio: 0.5,
      a: { pane: "damage" },
      b: { pane: "timeline" },
    },
  } as const;
  const visible = new Set<PaneId>([
    "scene",
    "analysis",
    "inspector",
    "damage",
    "timeline",
  ]);
  assert.deepEqual(
    dockGeometry(parseDock(JSON.stringify(old)), visible, 1000, 700).panes,
    dockGeometry(old, visible, 1000, 700).panes,
  );
  assert.deepEqual(readPanels('["speedrun","speedrun"]'), ["speedrun"]);
});
