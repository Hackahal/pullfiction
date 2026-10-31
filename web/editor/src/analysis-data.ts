import type { Replay } from "./types";
import type { EditorController } from "./controller";
import {
  missing,
  analysisLoadRange,
  replayIdentity,
  REPLAY_CHUNK,
  type Range,
} from "./replay-buffer";

export function analysisDataIdentity(replay: Replay | null) {
  return `${replayIdentity(replay)}:${replay?.raw.stream?.revision ?? "file"}`;
}
/** One bounded request lets view changes take effect before the next chunk. */
export function nextAnalysisChunk(
  replay: Replay | null,
  requested: readonly Range[],
): Range | null {
  if (!replay?.raw.stream) return null;
  for (const [a, b] of requested) {
    if (b < a) continue;
    const [start, end] = analysisLoadRange(replay, a, b);
    const hole = missing(replay.raw.stream.full, start, end)[0];
    if (!hole) continue;
    const chunk = Math.floor(hole[0] / REPLAY_CHUNK) * REPLAY_CHUNK;
    return [chunk, Math.min(replay.duration, chunk + REPLAY_CHUNK)];
  }
  return null;
}
export async function requestAnalysisChunk(
  controller: Pick<EditorController, "getSnapshot" | "loadReplayRange">,
  expectedSource: string,
  ranges: readonly Range[],
) {
  const current = controller.getSnapshot();
  if (
    analysisDataIdentity(current.replay) !== expectedSource ||
    current.buffering ||
    current.downloadingReplay ||
    current.bufferError
  )
    return false;
  const chunk = nextAnalysisChunk(current.replay, ranges);
  if (!chunk) return false;
  await controller.loadReplayRange(...chunk);
  return true;
}
