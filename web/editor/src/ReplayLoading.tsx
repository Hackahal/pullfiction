import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import {
  streamComplete,
  replayIdentity,
  analysisAvailable,
} from "./replay-buffer";
import { useRef } from "react";

// Keep scene/focus state on the last ready frame while the scrubber can point
// anywhere in the full run. A network hole is not a new recorded actor pose.
export function useBufferedView(state: Snapshot): Snapshot {
  const key = replayIdentity(state.replay);
  const last = useRef({ key, time: 0 });
  if (last.current.key !== key) last.current = { key, time: 0 };
  const replay = state.replay;
  const waiting =
    !!replay?.raw.stream &&
    (state.buffering ||
      !analysisAvailable(
        replay,
        Math.max(0, Math.min(replay.duration - 0.001, state.time)),
        Math.min(replay.duration, state.time + 0.001),
      ));
  if (!waiting) last.current.time = state.time;
  return waiting
    ? { ...state, time: last.current.time, playing: false }
    : state;
}

export function ReplayLoading({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const raw = state.replay?.raw;
  if (!raw?.stream) return null;
  const complete = streamComplete(raw);
  if (
    complete &&
    !state.buffering &&
    !state.bufferError &&
    !state.downloadingReplay
  )
    return null;
  return (
    <div
      className={`replay-buffer-status${state.bufferError ? " failed" : ""}`}
      role="status"
    >
      <span>
        {state.bufferError ??
          (state.buffering
            ? "Loading this replay section…"
            : state.downloadingReplay
              ? "Loading analysis data…"
              : complete
                ? "Full run downloaded"
                : "Replay loads as you scrub")}
      </span>
      {state.bufferError && (
        <button onClick={() => controller.retryReplaySection()}>Retry</button>
      )}
      {state.bufferError && !state.wclConnected && (
        <button onClick={() => void controller.connectWcl()}>
          Connect Warcraft Logs
        </button>
      )}
      {state.bufferError && state.projectId && state.wclConnected && (
        <button
          onClick={() => void controller.reloadProjectSource(state.projectId!)}
        >
          Reload source
        </button>
      )}
    </div>
  );
}
