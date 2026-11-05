import { EditorIcon } from "./EditorIcon";
import { PanelSettings } from "./PanelSettings";
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
  const playLabel = state.playPreparing
    ? "Cancel preparation"
    : state.playing
      ? "Pause"
      : "Play";
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
          className="transport-skip"
          aria-label="Previous encounter"
          title="Previous encounter"
          disabled={!state.replay}
          onClick={() => controller.stepChapter(-1)}
        >
          <EditorIcon name="previous" />
        </button>
        <button
          className="play"
          aria-label={playLabel}
          title={playLabel}
          disabled={!state.replay && state.workspaceMode !== "plan"}
          onClick={() => controller.toggle()}
        >
          <EditorIcon
            name={state.playing || state.playPreparing ? "pause" : "play"}
          />
        </button>
        <button
          className="transport-skip"
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
            <span className="transport-duration"> / {time(duration)}</span>
          </span>
        </div>
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
        <div className="transport-options" data-looping={Boolean(state.loop)}>
          <PanelSettings
            title="Playback options"
            triggerLabel={`Playback options: ${state.rate}×${state.loop ? ", looping" : ""}`}
            label={`${state.rate}×`}
            width={260}
          >
            <div className="playback-option-fields">
              <label>
                Speed
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
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(state.loop)}
                  disabled={!state.replay}
                  onChange={() => controller.toggleLoop()}
                />
                Loop current encounter
              </label>
              <div className="playback-encounter-actions">
                <button onClick={() => controller.stepChapter(-1)}>
                  <EditorIcon name="previous" /> Previous encounter
                </button>
                <button onClick={() => controller.stepChapter(1)}>
                  <EditorIcon name="next" /> Next encounter
                </button>
              </div>
              <button
                onClick={(event) => {
                  event.currentTarget
                    .closest<HTMLElement>("[popover]")
                    ?.hidePopover();
                  onOpenLog();
                }}
                title={state.replay?.report.title}
              >
                <EditorIcon name="logs" /> Open replay log
              </button>
            </div>
          </PanelSettings>
        </div>
      </div>
    </div>
  );
}
