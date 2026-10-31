import type { Replay } from "./types";

export type AnalysisWindow = "encounter" | "rolling" | "elapsed" | "full";
export function analysisRange(
  replay: Replay | null,
  clock: number,
  window: AnalysisWindow,
  fight = "",
) {
  const duration = replay?.duration ?? 0;
  const now = Math.max(0, Math.min(duration, clock));
  const chapters = replay?.chapters ?? [];
  const pinned = fight
    ? chapters.find((c) => String(c.id) === fight)
    : undefined;
  const current = chapters
    .filter((c) => c.start <= now)
    .reduce<Replay["chapters"][number] | undefined>(
      (latest, c) => (!latest || c.start > latest.start ? c : latest),
      undefined,
    );
  const chapter = pinned ?? current;
  const first = chapters.reduce<Replay["chapters"][number] | undefined>(
    (earliest, c) => (!earliest || c.start < earliest.start ? c : earliest),
    undefined,
  );
  let start = 0,
    end = now,
    displayEnd = duration;
  let intervals: [number, number][] | undefined;
  let seconds = now / 1000;
  if (pinned) {
    start = pinned.start;
    end = displayEnd = pinned.end;
    seconds = (end - start) / 1000;
  } else if (window === "encounter") {
    start = chapter?.start ?? first?.start ?? 0;
    end = chapter ? Math.max(start, Math.min(now, chapter.end)) : now;
    displayEnd = chapter?.end ?? first?.end ?? duration;
    seconds = (end - start) / 1000;
  } else if (window === "rolling") {
    start = Math.max(0, now - 10000);
    displayEnd = now;
    seconds = (end - start) / 1000;
  } else if (window === "full") {
    end = displayEnd = duration;
    seconds = duration / 1000;
  } else if (chapters.length) {
    intervals = [];
    for (const c of [...chapters].sort((a, b) => a.start - b.start)) {
      const a = Math.max(0, c.start),
        b = Math.min(now, c.end);
      if (b < a || a > now) continue;
      const last = intervals.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else intervals.push([a, b]);
    }
    seconds = intervals.reduce((n, [a, b]) => n + b - a, 0) / 1000;
  }
  return {
    start,
    end,
    displayEnd,
    seconds: Math.max(0, seconds),
    intervals,
    chapter,
    between:
      window === "encounter" && !pinned && !!chapter && now > chapter.end,
    label:
      pinned?.name ??
      (window === "encounter"
        ? (chapter?.name ?? "Current pull")
        : window === "elapsed"
          ? "Overall"
          : window === "rolling"
            ? "Last 10s"
            : "Full run"),
  };
}

/** Live scalar summary scope. Plot geometry remains independently fixed. */
export function chartSummaryRange(
  replay: Replay | null,
  clock: number,
  window: "timeline" | "encounter" | "run" | "elapsed" | "10" | "30" | "60",
  viewport: [number, number],
  brush: [number, number] | null = null,
) {
  const now = Math.max(0, Math.min(replay?.duration ?? 0, clock));
  if (!brush && (window === "encounter" || window === "elapsed"))
    return analysisRange(replay, now, window);
  let start = 0,
    end = now,
    displayEnd = replay?.duration ?? 0,
    label = "Run so far";
  if (brush || window === "timeline") {
    const bounds = brush ?? viewport;
    start = Math.max(0, Math.min(...bounds));
    displayEnd = Math.min(replay?.duration ?? 0, Math.max(...bounds));
    end = Math.min(now, displayEnd);
    label = brush ? "Selected range" : "Visible range";
  } else if (["10", "30", "60"].includes(window)) {
    start = Math.max(0, now - Number(window) * 1000);
    displayEnd = now;
    label = `Last ${window}s`;
  }
  return {
    start,
    end,
    displayEnd,
    seconds: Math.max(0, end - start) / 1000,
    intervals: undefined,
    chapter: undefined,
    between: false,
    label,
  };
}
