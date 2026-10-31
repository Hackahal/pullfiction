import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  nextAnalysisChunk,
  analysisDataIdentity,
  requestAnalysisChunk,
} from "./analysis-data";
import { ReplayLoading, useBufferedView } from "./ReplayLoading";
import { chartCsvContent } from "./chart-export";
import type { Replay, Snapshot } from "./types";
import type { EditorController } from "./controller";
import type { ChartResult } from "./chart-model";
const replay = {
  gameVersion: "vanilla",
  report: { code: "test" },
  fight: { id: "run" },
  duration: 180000,
  raw: {
    fight: { startTime: 0, endTime: 180000 },
    stream: { id: "test", revision: 1, full: [[0, 60000]] },
  },
} as unknown as Replay;
test("Analysis fetch requests align to one missing chunk and respect closed cutoffs", () => {
  assert.deepEqual(
    nextAnalysisChunk(replay, [[60000, 60000]]),
    [60000, 120000],
  );
  assert.equal(nextAnalysisChunk(replay, [[0, 59000]]), null);
  assert.equal(nextAnalysisChunk(replay, [[10000, 5000]]), null);
  assert.deepEqual(
    nextAnalysisChunk(replay, [[180000, 180000]]),
    [120000, 180000],
  );
  assert.equal(
    nextAnalysisChunk(
      { ...replay, raw: { ...replay.raw, stream: undefined } },
      [[0, 180000]],
    ),
    null,
  );
});
test("Automatic requests stop on errors, buffering and source revisions instead of retry loops", async () => {
  let calls = 0;
  for (const partial of [
    { bufferError: "offline" },
    { buffering: true },
    { downloadingReplay: true },
  ]) {
    const state = {
      replay,
      bufferError: null,
      buffering: false,
      downloadingReplay: false,
      ...partial,
    } as Snapshot;
    assert.equal(
      await requestAnalysisChunk(
        {
          getSnapshot: () => state,
          loadReplayRange: async () => {
            calls++;
          },
        },
        analysisDataIdentity(replay),
        [[60000, 120000]],
      ),
      false,
    );
  }
  const changed = {
    ...replay,
    raw: { ...replay.raw, stream: { ...replay.raw.stream!, revision: 2 } },
  };
  assert.equal(
    await requestAnalysisChunk(
      {
        getSnapshot: () => ({ replay: changed }) as Snapshot,
        loadReplayRange: async () => {
          calls++;
        },
      },
      analysisDataIdentity(replay),
      [[60000, 120000]],
    ),
    false,
  );
  assert.equal(calls, 0);
});
test("Replay loading has no manual load controls and background analysis errors keep a ready scene live", () => {
  const state = {
    replay,
    time: 1000,
    playing: true,
    bufferError: "An older range failed",
    buffering: false,
    downloadingReplay: false,
  } as Snapshot;
  const html = renderToString(
    createElement(ReplayLoading, { state, controller: {} as EditorController }),
  );
  assert.doesNotMatch(html, /Download full run|Stop download|Load.*events/);
  assert.match(html, /Retry/);
  function Probe() {
    const view = useBufferedView(state);
    return createElement("span", null, String(view.time));
  }
  assert.match(renderToString(createElement(Probe)), />1000</);
});
test("CSV rates use exact full-run seconds and zero duration stays unavailable", () => {
  const result = {
    series: [
      { name: "=SUM()", total: 100, peak: 10, count: 1, crits: 0, overheal: 0 },
    ],
  } as ChartResult;
  assert.match(chartCsvContent(result, 0.25), /"'=SUM\(\)",100,400,10,1,0,0/);
  assert.match(chartCsvContent(result, 0), /100,,10/);
  assert.doesNotMatch(chartCsvContent(result, 0), /NaN|Infinity/);
});
