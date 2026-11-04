export interface FramePerformance {
  source: "renderer" | "browser";
  fps: number;
  p95: number;
  p99: number;
  worst: number;
  slow: number;
  frames: number;
}
/** Summaries use the elapsed frame intervals, including stalls, never average FPS. */
export function summarizeFrames(
  intervals: readonly number[],
  source: FramePerformance["source"],
): FramePerformance | null {
  const values = intervals.filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    source,
    fps: (values.length * 1000) / values.reduce((a, b) => a + b, 0),
    p95: percentile(0.95),
    p99: percentile(0.99),
    worst: sorted[sorted.length - 1],
    slow: values.filter((n) => n > 1000 / 60 + 1).length,
    frames: values.length,
  };
}
let snapshot: FramePerformance | null = null;
const listeners = new Set<() => void>();
export const framePerformance = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish(value: FramePerformance | null) {
    snapshot = value;
    for (const listener of listeners) listener();
  },
};
export const FPS_STORAGE = "pullfiction.performance.fps.v1";
