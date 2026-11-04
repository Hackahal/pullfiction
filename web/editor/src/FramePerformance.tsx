import { useEffect, useSyncExternalStore } from "react";
import type { EditorController } from "./controller";
import { framePerformance, summarizeFrames } from "./frame-performance";

export function FramePerformanceCounter({
  controller,
}: {
  controller: EditorController;
}) {
  const sample = useSyncExternalStore(
    framePerformance.subscribe,
    framePerformance.getSnapshot,
    () => null,
  );
  useEffect(() => {
    let raf = 0;
    let previous = 0;
    let elapsed = 0;
    let intervals: number[] = [];
    let native = false;
    const reset = () => {
      previous = 0;
      elapsed = 0;
      intervals = [];
      framePerformance.publish(null);
      native = controller.setPerformanceCounter(!document.hidden);
    };
    const tick = (now: number) => {
      const available = controller.setPerformanceCounter(!document.hidden);
      if (available !== native) reset();
      if (!document.hidden && !native) {
        if (previous) {
          const delta = now - previous;
          intervals.push(delta);
          elapsed += delta;
          if (elapsed >= 1000) {
            framePerformance.publish(summarizeFrames(intervals, "browser"));
            intervals = [];
            elapsed = 0;
          }
        }
        previous = now;
      }
      raf = requestAnimationFrame(tick);
    };
    reset();
    document.addEventListener("visibilitychange", reset);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", reset);
      controller.setPerformanceCounter(false);
      framePerformance.publish(null);
    };
  }, [controller]);
  return (
    <output
      className="frame-performance"
      aria-label="Frame performance"
      title="Foreground frame cadence. Renderer timing measures engine frames, not GPU execution time. Browser timing is used when the renderer has no counter."
    >
      {sample ? (
        <>
          <strong>{sample.fps.toFixed(0)} FPS</strong>
          <span>
            {sample.source === "renderer" ? "Renderer" : "Browser cadence"}
          </span>
          <span>
            p95 {sample.p95.toFixed(1)} ms · p99 {sample.p99.toFixed(1)} ms
          </span>
          <span>
            {sample.slow}/{sample.frames} frames over 17.7 ms · worst{" "}
            {sample.worst.toFixed(1)} ms
          </span>
        </>
      ) : (
        <span>Measuring FPS…</span>
      )}
    </output>
  );
}
