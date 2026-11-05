import { EditorIcon } from "./EditorIcon";
import { PanelSettings } from "./PanelSettings";
import { useRef } from "react";
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
  const transport = useRef<HTMLDivElement>(null);
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
  const chapterNameCounts = new Map<string, number>();
  for (const item of state.replay?.chapters ?? [])
    chapterNameCounts.set(
      item.name,
      (chapterNameCounts.get(item.name) ?? 0) + 1,
    );
  return (
    <div
      className="transport"
      ref={transport}
      role="group"
      aria-label="Replay playback"
      hidden={!state.replay}
    >
      <div className="transport-core">
        <button
          className="play"
          data-paused={!state.playing && !state.playPreparing}
          aria-label={playLabel}
          title={playLabel}
          disabled={!state.replay && state.workspaceMode !== "plan"}
          onClick={() => controller.toggle()}
        >
          <EditorIcon
            name={state.playing || state.playPreparing ? "pause" : "play"}
          />
        </button>
        <div className="playback-clocks">
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
          {!standalonePull && (
            <span className="timecode pull-timecode">
              <span>Pull</span>{" "}
              <b>{pull ? preciseTime(state.time - pull.start) : "—"}</b>
            </span>
          )}
        </div>
      </div>
      <div
        className="transport-context"
        role="group"
        aria-label="Encounter navigation"
      >
        <button
          className="transport-skip"
          aria-label="Previous encounter"
          title="Previous encounter"
          disabled={!state.replay}
          onClick={() => controller.stepChapter(-1)}
        >
          <EditorIcon name="previous" />
        </button>
        {state.replay?.chapters.length ? (
          <select
            className="chapter-select"
            aria-label="Encounter"
            title={
              chapter
                ? `${chapter.name} · ${time(chapter.start)}`
                : "Between pulls"
            }
            value={chapter?.id ?? ""}
            onChange={(e) => controller.jump(e.target.value)}
          >
            <option value="" disabled>
              Between pulls
            </option>
            {state.replay.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {(chapterNameCounts.get(c.name) ?? 0) > 1
                  ? ` · ${time(c.start)}`
                  : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="current-encounter">
            {state.replay?.fight.name ?? "No replay"}
          </span>
        )}
        <button
          className="transport-skip"
          aria-label="Next encounter"
          title="Next encounter"
          disabled={!state.replay}
          onClick={() => controller.stepChapter(1)}
        >
          <EditorIcon name="next" />
        </button>
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
            width={234}
            anchorBoundary={transport}
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
                <button
                  aria-label="Previous encounter"
                  onClick={() => controller.stepChapter(-1)}
                >
                  <EditorIcon name="previous" /> Previous
                </button>
                <button
                  aria-label="Next encounter"
                  onClick={() => controller.stepChapter(1)}
                >
                  <EditorIcon name="next" /> Next
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
