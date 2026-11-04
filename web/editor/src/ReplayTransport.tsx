import { EditorIcon } from "./EditorIcon";
import { chapterAt, preciseTime, pullAt, time } from "./domain";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";

export function ReplayTransport({
  state,
  controller,
  onOpenLog,
  onPlan,
}: {
  state: Snapshot;
  controller: EditorController;
  onOpenLog: () => void;
  onPlan: () => void;
}) {
  const chapter = state.replay && chapterAt(state.replay, state.time);
  const pull = state.replay && pullAt(state.replay, state.time);
  const duration = controller.duration();
  const standalonePull =
    !!state.replay?.fight.encounterID &&
    state.replay.chapters.length === 0 &&
    duration === state.replay.duration;
  return (
    <div
      className="transport"
      role="group"
      aria-label="Replay playback"
      hidden={!state.replay}
    >
      <div className="transport-core">
        <button
          aria-label="Previous encounter"
          title="Previous encounter"
          disabled={!state.replay}
          onClick={() => controller.stepChapter(-1)}
        >
          <EditorIcon name="previous" />
        </button>
        <button
          className="play"
          aria-label={
            state.playPreparing
              ? "Cancel preparation"
              : state.playing
                ? "Pause"
                : "Play"
          }
          disabled={!state.replay && state.workspaceMode !== "plan"}
          onClick={() => controller.toggle()}
        >
          <EditorIcon
            name={state.playing || state.playPreparing ? "pause" : "play"}
          />
        </button>
        <button
          aria-label="Next encounter"
          title="Next encounter"
          disabled={!state.replay}
          onClick={() => controller.stepChapter(1)}
        >
          <EditorIcon name="next" />
        </button>
        <div className="playback-clocks">
          {!standalonePull && (
            <span className="timecode pull-timecode">
              <span>Pull</span>{" "}
              <b>{pull ? preciseTime(state.time - pull.start) : "—"}</b>
            </span>
          )}
          <span className="timecode">
            <span>
              {state.replay && duration > state.replay.duration
                ? "Plan"
                : standalonePull
                  ? "Pull"
                  : "Run"}
            </span>{" "}
            <b>{preciseTime(state.time)}</b>
            <span> / {time(duration)}</span>
          </span>
        </div>
      </div>
      <div className="transport-options">
        <select
          aria-label="Playback speed"
          value={state.rate}
          onChange={(e) => controller.setRate(Number(e.target.value))}
        >
          {[0.5, 1, 2, 4].map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
        <button
          aria-pressed={Boolean(state.loop)}
          title="Loop current encounter"
          disabled={!state.replay}
          onClick={() => controller.toggleLoop()}
        >
          Loop
        </button>
      </div>
      <div className="transport-context">
        {state.replay?.chapters.length ? (
          <select
            className="chapter-select"
            aria-label="Encounter"
            value={chapter?.id ?? ""}
            onChange={(e) => controller.jump(e.target.value)}
          >
            <option value="" disabled>
              Between pulls
            </option>
            {state.replay.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {time(c.start)}
              </option>
            ))}
          </select>
        ) : (
          <span className="current-encounter">
            {state.replay?.fight.name ?? "No replay"}
          </span>
        )}
      </div>
      <div className="transport-actions">
        {state.busy && <span className="busy-dot" />}
        <button
          className="transport-report"
          aria-label="Open replay log"
          title={state.replay?.report.title ?? "Open log"}
          onClick={onOpenLog}
        >
          <EditorIcon name="logs" />
          <span>{state.replay?.report.title ?? "Open log"}</span>
        </button>
        {state.replay && state.workspaceMode === "analyse" && (
          <button
            className="plan-from-moment"
            aria-label="Plan from this moment"
            title="Plan from this moment"
            onClick={onPlan}
          >
            <span className="plan-label-wide">Plan from this moment</span>
            <span className="plan-label-compact">Plan</span>
          </button>
        )}
      </div>
    </div>
  );
}
