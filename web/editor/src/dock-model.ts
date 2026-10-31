export const paneIds = [
  "scene",
  "analysis",
  "inspector",
  "damage",
  "timeline",
  "healing",
  "resources",
  "events",
  "playbook",
  "run",
  "speedrun",
] as const;
export type PaneId = (typeof paneIds)[number];
export type Edge = "left" | "right" | "top" | "bottom";
export type DockNode =
  | { pane: PaneId }
  | { axis: "row" | "column"; ratio: number; a: DockNode; b: DockNode };
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Divider extends Box {
  path: string;
  axis: "row" | "column";
  ratio: number;
  extent: number;
}
function coreDock(): DockNode {
  return {
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
  };
}
export function defaultDock(): DockNode {
  return {
    axis: "row",
    ratio: 0.25,
    a: { pane: "playbook" },
    b: {
      axis: "row",
      ratio: 0.72,
      a: { axis: "column", ratio: 0.74, a: coreDock(), b: { pane: "run" } },
      b: { pane: "speedrun" },
    },
  };
}

function containsPane(node: DockNode, pane: PaneId): boolean {
  return "pane" in node
    ? node.pane === pane
    : containsPane(node.a, pane) || containsPane(node.b, pane);
}
// Only upgrade the previous left-above-timeline arrangement. Custom v2 trees are not normalized.
export function migrateFullHeightLeft(root: DockNode): DockNode {
  if (
    "pane" in root ||
    root.axis !== "column" ||
    "pane" in root.a ||
    root.a.axis !== "row" ||
    containsPane(root.a.a, "scene") ||
    !containsPane(root.a.b, "scene") ||
    (!containsPane(root.b, "run") && !containsPane(root.b, "timeline"))
  )
    return root;
  return {
    axis: "row",
    ratio: root.a.ratio,
    a: root.a.a,
    b: { axis: "column", ratio: root.ratio, a: root.a.b, b: root.b },
  };
}
export function leftDockRatio(root: DockNode): number {
  return !("pane" in root) &&
    root.axis === "row" &&
    !containsPane(root.a, "scene")
    ? root.ratio
    : 0.25;
}
export function parseDock(value: string | null): DockNode {
  if (!value || value.length > 10000) return defaultDock();
  try {
    const ids = new Set<string>();
    function valid(n: any, depth = 0): boolean {
      if (!n || typeof n !== "object" || depth > 16) return false;
      if ("pane" in n) {
        if (
          (!paneIds.includes(n.pane) && n.pane !== "pages") ||
          ids.has(n.pane)
        )
          return false;
        ids.add(n.pane);
        return true;
      }
      return (
        ["row", "column"].includes(n.axis) &&
        Number.isFinite(n.ratio) &&
        n.ratio >= 0.1 &&
        n.ratio <= 0.9 &&
        valid(n.a, depth + 1) &&
        valid(n.b, depth + 1)
      );
    }
    const n = JSON.parse(value);
    if (
      !valid(n) ||
      !["scene", "analysis", "inspector", "damage", "timeline"].every((id) =>
        ids.has(id),
      )
    )
      return defaultDock();
    // Retire only the old Pages leaf; retain every other custom split and ratio.
    function prunePages(node: any): DockNode | null {
      if ("pane" in node) return node.pane === "pages" ? null : node;
      const a = prunePages(node.a),
        b = prunePages(node.b);
      return a && b ? { ...node, a, b } : (a ?? b);
    }
    // Insert the new timer beside Scene inside the restored tree. Wrapping the
    // root would hide the legacy v1 shape before migrateFullHeightLeft sees it.
    function addTimer(node: DockNode): DockNode {
      if ("pane" in node)
        return node.pane === "scene"
          ? { axis: "row", ratio: 0.72, a: node, b: { pane: "speedrun" } }
          : node;
      return { ...node, a: addTimer(node.a), b: addTimer(node.b) };
    }
    let restored: DockNode = prunePages(n) ?? defaultDock();
    for (const pane of paneIds)
      if (!ids.has(pane))
        restored =
          pane === "speedrun"
            ? addTimer(restored)
            : pane === "run"
              ? { axis: "column", ratio: 0.74, a: restored, b: { pane } }
              : pane === "playbook"
                ? { axis: "row", ratio: 0.25, a: { pane }, b: restored }
                : { axis: "row", ratio: 0.7, a: restored, b: { pane } };
    return restored;
  } catch {
    return defaultDock();
  }
}
function remove(n: DockNode, id: PaneId): DockNode | null {
  if ("pane" in n) return n.pane === id ? null : n;
  const a = remove(n.a, id),
    b = remove(n.b, id);
  return a && b ? { ...n, a, b } : (a ?? b);
}
export function moveDock(
  root: DockNode,
  source: PaneId,
  target: PaneId,
  edge: Edge,
): DockNode {
  if (source === target) return root;
  const trimmed = remove(root, source);
  if (!trimmed) return root;
  function insert(n: DockNode): DockNode {
    if ("pane" in n) {
      if (n.pane !== target) return n;
      const first = edge === "left" || edge === "top";
      return {
        axis: edge === "left" || edge === "right" ? "row" : "column",
        ratio: 0.5,
        a: first ? { pane: source } : n,
        b: first ? n : { pane: source },
      };
    }
    return { ...n, a: insert(n.a), b: insert(n.b) };
  }
  return insert(trimmed);
}
export interface DockDropTarget {
  pane: PaneId;
  edge: Edge;
  workspace?: true;
}
export function dockLeft(root: DockNode, source: PaneId): DockNode {
  const trimmed = remove(root, source);
  if (!trimmed) return root;
  if (
    !("pane" in trimmed) &&
    trimmed.axis === "row" &&
    !containsPane(trimmed.a, "scene") &&
    containsPane(trimmed.b, "scene")
  ) {
    return {
      ...trimmed,
      a: { axis: "column", ratio: 0.5, a: trimmed.a, b: { pane: source } },
    };
  }
  return {
    axis: "row",
    ratio: leftDockRatio(root),
    a: { pane: source },
    b: trimmed,
  };
}
export function applyDockDrop(
  root: DockNode,
  source: PaneId,
  target: DockDropTarget,
): DockNode {
  return target.workspace
    ? dockLeft(root, source)
    : moveDock(root, source, target.pane, target.edge);
}
export function resizeDock(
  root: DockNode,
  path: string,
  ratio: number,
): DockNode {
  if ("pane" in root) return root;
  if (!path) return { ...root, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  const key = path[0] as "a" | "b";
  return { ...root, [key]: resizeDock(root[key], path.slice(1), ratio) };
}
export function dockGeometry(
  root: DockNode,
  visible: Set<PaneId>,
  width: number,
  height: number,
) {
  const panes: Partial<Record<PaneId, Box>> = {},
    dividers: Divider[] = [];
  const gap = 5;
  function shown(n: DockNode): boolean {
    return "pane" in n ? visible.has(n.pane) : shown(n.a) || shown(n.b);
  }
  function place(n: DockNode, box: Box, path: string) {
    if ("pane" in n) {
      if (visible.has(n.pane)) panes[n.pane] = box;
      return;
    }
    const av = shown(n.a),
      bv = shown(n.b);
    if (!av || !bv) {
      if (av) place(n.a, box, path + "a");
      if (bv) place(n.b, box, path + "b");
      return;
    }
    const row = n.axis === "row",
      extent = Math.max(0, (row ? box.width : box.height) - gap),
      first = extent * n.ratio;
    const a = {
        ...box,
        width: row ? first : box.width,
        height: row ? box.height : first,
      },
      b = {
        x: box.x + (row ? first + gap : 0),
        y: box.y + (row ? 0 : first + gap),
        width: row ? extent - first : box.width,
        height: row ? box.height : extent - first,
      };
    dividers.push({
      x: box.x + (row ? first : 0),
      y: box.y + (row ? 0 : first),
      width: row ? gap : box.width,
      height: row ? box.height : gap,
      path,
      axis: n.axis,
      ratio: n.ratio,
      extent,
    });
    place(n.a, a, path + "a");
    place(n.b, b, path + "b");
  }
  place(
    root,
    { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) },
    "",
  );
  return { panes, dividers };
}
export function closestEdge(
  x: number,
  y: number,
  width: number,
  height: number,
): Edge {
  const distances: [Edge, number][] = [
    ["left", x / Math.max(1, width)],
    ["right", 1 - x / Math.max(1, width)],
    ["top", y / Math.max(1, height)],
    ["bottom", 1 - y / Math.max(1, height)],
  ];
  return distances.sort((a, b) => a[1] - b[1])[0][0];
}

export const PANEL_MIME = "application/x-pullfiction-panel";
export const VISIBILITY_STORAGE = "pullfiction.workspace.panels.v1";
export function readPanels(value: string | null): PaneId[] {
  if (value && value.length > 10000) return [];
  try {
    const ids = JSON.parse(value ?? "[]");
    return Array.isArray(ids)
      ? [
          ...new Set(
            ids.filter(
              (id): id is PaneId => paneIds.includes(id) && id !== "scene",
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function dockDropAt(
  panes: Partial<Record<PaneId, Box>>,
  source: PaneId | null,
  x: number,
  y: number,
  workspace?: Box,
): DockDropTarget | null {
  if (
    workspace &&
    x >= workspace.x &&
    x <= workspace.x + Math.min(24, workspace.width * 0.1) &&
    y >= workspace.y &&
    y <= workspace.y + workspace.height
  )
    return { pane: "scene", edge: "left", workspace: true };
  for (const id of paneIds) {
    const b = panes[id];
    if (id === source || !b) continue;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)
      return {
        pane: id,
        edge: closestEdge(x - b.x, y - b.y, b.width, b.height),
      };
  }
  return null;
}
