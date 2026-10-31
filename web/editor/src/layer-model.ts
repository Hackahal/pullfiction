import type { Plan, PlanStep } from "./types";
export function adjustedStepRange(
  start: number,
  end: number,
  delta: number,
  edge: "move" | "start" | "end",
  duration: number,
  targets: number[],
  threshold: number,
) {
  let a = edge === "end" ? start : start + delta,
    b = edge === "start" ? end : end + delta;
  let guide: number | null = null;
  const candidates = (edge === "start" ? [a] : edge === "end" ? [b] : [a, b])
    .flatMap((v) => targets.map((t) => ({ delta: t - v, t })))
    .filter((p) => Math.abs(p.delta) <= threshold)
    .sort((p, q) => Math.abs(p.delta) - Math.abs(q.delta));
  if (candidates.length) {
    const n = candidates[0];
    guide = n.t;
    if (edge !== "end") a += n.delta;
    if (edge !== "start") b += n.delta;
  }
  if (edge === "move") {
    const length = end - start;
    a = Math.max(0, Math.min(duration - length, a));
    b = a + length;
  } else if (edge === "start") a = Math.max(0, Math.min(b - 100, a));
  else b = Math.max(a + 100, Math.min(duration, b));
  return { start: a, end: b, guide };
}

export function activePages(
  plan: Plan,
  time: number,
  activeStep: string,
  timed: boolean,
  all = false,
): PlanStep[] {
  const visible = new Set(
    plan.layers.filter((l) => !l.hidden).map((l) => l.id),
  );
  return plan.layers.flatMap((layer) => {
    if (!visible.has(layer.id)) return [];
    return plan.steps.filter((page) => {
      if (page.layerId !== layer.id) return false;
      if (all) return true;
      if (!timed) return page.id === activeStep;
      return (
        (page.start === null || page.start <= time) &&
        (page.end === null || time < page.end)
      );
    });
  });
}
export function selectedPeriod(a: number, b: number, duration: number) {
  const start = Math.max(0, Math.min(duration, Math.min(a, b))),
    end = Math.max(0, Math.min(duration, Math.max(a, b)));
  return end - start >= 100 ? { start, end } : null;
}
