import { useEffect, useMemo } from "react";
import {
  analysisDataIdentity,
  nextAnalysisChunk,
  requestAnalysisChunk,
} from "./analysis-data";
import type { Snapshot } from "./types";
import type { EditorController } from "./controller";
import type { Range } from "./replay-buffer";

export function useAnalysisData(
  state: Snapshot,
  controller: EditorController,
  ranges: readonly Range[],
) {
  const key = JSON.stringify(ranges),
    source = analysisDataIdentity(state.replay);
  const next = useMemo(
    () => nextAnalysisChunk(state.replay, ranges),
    [state.replay, key],
  );
  useEffect(() => {
    if (
      !next ||
      state.buffering ||
      state.downloadingReplay ||
      state.bufferError
    )
      return;
    void requestAnalysisChunk(controller, source, ranges);
  }, [
    controller,
    source,
    state.replay,
    next?.[0],
    next?.[1],
    state.buffering,
    state.downloadingReplay,
    state.bufferError,
  ]);
}
