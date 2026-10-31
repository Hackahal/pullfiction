import type { MarkGeometry } from "./annotation-model";
import type { Point } from "./types";
export function selectionMode(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): "replace" | "add" | "toggle" {
  return e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";
}
export function inSelectionBox(
  g: MarkGeometry,
  a: number[],
  b: number[],
  screen: (p: Point) => number[],
): boolean {
  const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
    max = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const inside = (p: number[]) =>
    p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  if (inside(screen(g.anchor))) return true;
  return g.paths.some((path) =>
    path.some((p, i) => {
      if (!i) return inside(screen(p));
      const start = screen(path[i - 1]),
        end = screen(p);
      let lo = 0,
        hi = 1;
      for (let axis = 0; axis < 2; axis++) {
        const d = end[axis] - start[axis];
        if (Math.abs(d) < 1e-9) {
          if (start[axis] < min[axis] || start[axis] > max[axis]) return false;
        } else {
          const u = (min[axis] - start[axis]) / d,
            v = (max[axis] - start[axis]) / d;
          lo = Math.max(lo, Math.min(u, v));
          hi = Math.min(hi, Math.max(u, v));
          if (lo > hi) return false;
        }
      }
      return true;
    }),
  );
}
