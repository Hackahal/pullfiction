import type { AssetProgress } from "./loading-progress";
export function LoadingProgress({
  progress,
  label = "Requested assets",
}: {
  progress?: AssetProgress | null;
  label?: string;
}) {
  const percent = progress
    ? Math.floor((100 * progress.completedBytes) / progress.totalBytes)
    : null;
  return (
    <div className="loading-progress">
      <progress
        aria-label={label}
        max={100}
        {...(percent === null ? {} : { value: percent })}
      />
      <small>
        {percent === null
          ? "Preparing the next step…"
          : `${label} · ${percent}% · ${(progress!.completedBytes / 1048576).toFixed(1)} / ${(progress!.totalBytes / 1048576).toFixed(1)} MB`}
      </small>
    </div>
  );
}

export function PreparationProgress({
  progress,
}: {
  progress: {
    message: string;
    completed: number;
    total: number;
    unit?: "events" | "triangles";
  };
}) {
  return (
    <div className="loading-progress">
      <progress
        aria-label={progress.message}
        {...(progress.total > 0
          ? { max: progress.total, value: progress.completed }
          : {})}
      />
      <small>
        {progress.total > 0
          ? `${progress.completed} / ${progress.total} ${progress.unit === "events" ? "events read" : progress.unit === "triangles" ? "triangles checked" : "assets checked"}`
          : "Preparing the next step…"}
      </small>
    </div>
  );
}
