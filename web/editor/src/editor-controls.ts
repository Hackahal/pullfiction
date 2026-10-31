import type { Point } from "./types";
export interface SnapSettings {
  position: boolean;
  size: boolean;
  angle: boolean;
  mode: "grid" | "relative";
  yards: number;
  degrees: number;
}
export const defaultSnap: SnapSettings = {
  position: false,
  size: false,
  angle: false,
  mode: "relative",
  yards: 1,
  degrees: 15,
};
export type Transform = "move" | "rotate" | "scale";
export type InputContext =
  "scene" | "timeline" | "playbook" | "edits" | "other";
export function snapValue(n: number, increment: number) {
  return increment > 0 && Number.isFinite(increment)
    ? Math.round(n / increment) * increment
    : n;
}
export function snapPoint(
  p: Point,
  origin: Point | undefined,
  settings: SnapSettings,
  bypass = false,
): Point {
  if (!settings.position || bypass) return [...p];
  const base = settings.mode === "relative" && origin ? origin : [0, 0, 0];
  return [
    base[0] + snapValue(p[0] - base[0], settings.yards),
    base[1] + snapValue(p[1] - base[1], settings.yards),
    p[2],
  ];
}
export function transformPoint(
  p: Point,
  pivot: Point,
  angle: number,
  scale = 1,
): Point {
  const x = (p[0] - pivot[0]) * scale,
    y = (p[1] - pivot[1]) * scale;
  return [
    pivot[0] + x * Math.cos(angle) - y * Math.sin(angle),
    pivot[1] + x * Math.sin(angle) + y * Math.cos(angle),
    p[2],
  ];
}
export function groundPivot(points: Point[]): Point {
  if (!points.length) return [0, 0, 0];
  return points.reduce(
    (v, p) => v.map((n, i) => n + p[i] / points.length) as Point,
    [0, 0, 0] as Point,
  );
}
export function contextOf(target: Element | null): InputContext {
  if (target?.closest('[data-input-context="timeline"]')) return "timeline";
  if (target?.closest('[data-input-context="playbook"]')) return "playbook";
  if (target?.closest('[data-input-context="edits"]')) return "edits";
  const pane = target?.closest("[data-pane]")?.getAttribute("data-pane");
  if (pane === "pages") return "playbook";
  if (pane === "playbook") return "edits";
  if (pane === "timeline") return "timeline";
  if (pane === "scene" || target?.closest('[data-input-context="scene"]'))
    return "scene";
  return "other";
}
