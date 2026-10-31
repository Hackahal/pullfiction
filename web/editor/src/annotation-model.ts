import type { Annotation, Plan, PlanStep, Point } from "./types";
export const RAID_ICONS = [
  "Star",
  "Circle",
  "Diamond",
  "Triangle",
  "Moon",
  "Square",
  "Cross",
  "Skull",
];
export const RAID_ICON_COLORS = [
  "#ffe45c",
  "#ff9d34",
  "#c47bff",
  "#70e65d",
  "#a8d4ff",
  "#499fff",
  "#ff5d59",
  "#e9e5da",
];
export const MARK_ICONS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "ability_warrior_defensivestance",
  "spell_holy_flashheal",
  "spell_fire_fireball",
  "ability_hunter_snipershot",
  "spell_nature_sleep",
  "spell_holy_powerwordshield",
];
export interface MarkGeometry {
  id: string;
  type: string;
  anchor: Point;
  paths: Point[][];
  fill: Point[];
  triangles: Point[];
  color: string;
  width: number;
  label: string;
  icon: string;
  size: number;
  selected: boolean;
  handles: Point[];
  handleKinds?: string[];
  locked: boolean;
  actor?: string;
}
const at = (p: Point, dx: number, dy: number): Point => [
  p[0] + dx,
  p[1] + dy,
  p[2],
];
export function annotationGeometry(
  a: Annotation,
  selected = false,
): MarkGeometry {
  const p = a.points[0],
    q = a.points.at(-1) ?? p,
    dx = q[0] - p[0],
    dy = q[1] - p[1];
  const radius = a.size;
  const g: MarkGeometry = {
    id: a.id,
    type: a.type,
    anchor: [...p],
    paths: [],
    fill: [],
    triangles: [],
    color: a.color,
    width: a.width,
    label:
      a.type === "circle" && a.actor
        ? `${a.label} · ${a.size.toFixed(1)} yd`
        : a.label,
    icon: a.icon,
    size: a.size,
    selected,
    handles: a.points.map((p) => [...p]),
    locked: a.locked,
    actor: a.actor,
  };
  if (a.type === "circle") {
    g.fill = Array.from({ length: 48 }, (_, i) =>
      at(
        p,
        Math.cos((i * Math.PI) / 24) * radius,
        Math.sin((i * Math.PI) / 24) * radius,
      ),
    );
    g.paths = [[...g.fill, g.fill[0]]];
  } else if (a.type === "cone") {
    const angle = Math.atan2(dy, dx);
    g.fill = [
      p,
      ...Array.from({ length: 25 }, (_, i) =>
        at(
          p,
          Math.cos(angle - Math.PI / 6 + (i * Math.PI) / 72) * radius,
          Math.sin(angle - Math.PI / 6 + (i * Math.PI) / 72) * radius,
        ),
      ),
    ];
    g.paths = [[...g.fill, p]];
  } else if (a.type === "polygon") {
    g.fill = a.points.length > 2 ? a.points : [];
    g.paths = [a.points.length > 2 ? [...a.points, p] : a.points];
  } else if (["route", "arrow", "drawing"].includes(a.type)) {
    g.paths = [a.points];
    if (a.type !== "drawing" && a.points.length > 1) {
      for (let i = 1; i < a.points.length; i++) {
        const b = a.points[i],
          start = a.points[i - 1],
          d = Math.hypot(b[0] - start[0], b[1] - start[1]);
        if (d < 0.1) continue;
        const angle = Math.atan2(b[1] - start[1], b[0] - start[0]),
          length = Math.min(d * 0.35, Math.max(1, a.size * 0.65));
        g.paths.push([
          at(
            b,
            -Math.cos(angle - 0.45) * length,
            -Math.sin(angle - 0.45) * length,
          ),
          b,
          at(
            b,
            -Math.cos(angle + 0.45) * length,
            -Math.sin(angle + 0.45) * length,
          ),
        ]);
      }
    }
  }
  if (["circle", "cone"].includes(a.type)) {
    const angle = Math.atan2(dy, dx);
    g.handles = [p, at(p, Math.cos(angle) * radius, Math.sin(angle) * radius)];
  }
  if (g.fill.length > 2) g.triangles = triangulate(g.fill);
  return g;
}
// Ear clipping retains concave polygon boundaries. Reject self-intersecting or
// degenerate fills rather than drawing triangles outside the intended area.
export function triangulate(points: Point[]): Point[] {
  const cross = (a: Point, b: Point, c: Point) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = points.reduce((n, p, i) => {
    const q = points[(i + 1) % points.length];
    return n + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (Math.abs(area) < 1e-6) return [];
  const sign = Math.sign(area),
    indices = points.map((_, i) => i),
    out: Point[] = [];
  let tries = 0;
  while (indices.length > 2 && tries++ < points.length * points.length) {
    let found = false;
    for (let i = 0; i < indices.length; i++) {
      const a = points[indices[(i + indices.length - 1) % indices.length]],
        b = points[indices[i]],
        c = points[indices[(i + 1) % indices.length]];
      if (cross(a, b, c) * sign <= 1e-8) continue;
      if (
        indices.some((j) => {
          const p = points[j];
          return (
            p !== a &&
            p !== b &&
            p !== c &&
            cross(a, b, p) * sign >= -1e-8 &&
            cross(b, c, p) * sign >= -1e-8 &&
            cross(c, a, p) * sign >= -1e-8
          );
        })
      )
        continue;
      out.push(a, b, c);
      indices.splice(i, 1);
      found = true;
      break;
    }
    if (!found) return [];
  }
  return out;
}
export function visibleMarks(plan: Plan, stepId: string, all = false) {
  return plan.steps
    .filter((s) => all || s.id === stepId)
    .flatMap((s) => s.annotations.filter((a) => !a.hidden));
}
export function stepAtTime(steps: PlanStep[], time: number) {
  return steps
    .filter(
      (s) =>
        s.start !== null && s.start <= time && (s.end === null || s.end > time),
    )
    .sort((a, b) => b.start! - a.start!)[0];
}
export function markHit(
  mark: MarkGeometry,
  p: [number, number],
  screen: (p: Point) => [number, number],
  tolerance = 8,
) {
  const anchor = screen(mark.anchor);
  if (
    ["marker", "label"].includes(mark.type) &&
    Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) < 16
  )
    return true;
  return mark.paths.some((path) =>
    path.slice(1).some((b, i) => {
      const a = screen(path[i]),
        q = screen(b),
        dx = q[0] - a[0],
        dy = q[1] - a[1],
        d = dx * dx + dy * dy;
      const u = d
        ? Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d),
          )
        : 0;
      return (
        Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) <= tolerance
      );
    }),
  );
}
