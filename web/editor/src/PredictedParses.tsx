import { useEffect, useMemo, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import { formatRate } from "./combat-metrics";
import { useAnalysisData } from "./use-analysis-data";
import { analysisIntervalsAvailable, replayIdentity } from "./replay-buffer";
import {
  defaultParseOptions,
  parseEncounter,
  parsePace,
  percentileAt,
  predictionSupported,
  referenceFor,
  type ParseData,
  type ParseOptions,
} from "./playback-parses";

const storageKey = "pullfiction.predicted-parses.v1";
export function savedParseOptions(): ParseOptions {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return {
      compare: ["Parses", "Rankings"].includes(value?.compare)
        ? value.compare
        : defaultParseOptions.compare,
      timeframe: ["Historical", "Today"].includes(value?.timeframe)
        ? value.timeframe
        : defaultParseOptions.timeframe,
      bracket: ["overall", "itemLevel"].includes(value?.bracket)
        ? value.bracket
        : defaultParseOptions.bracket,
    };
  } catch {
    return { ...defaultParseOptions };
  }
}
const percentage = (n: number | null) =>
  n === null ? "—" : `${n.toFixed(1)}%`;
const color = (n: number | null) =>
  n === null
    ? undefined
    : n >= 100
      ? "#e5cc80"
      : n >= 99
        ? "#e268a8"
        : n >= 95
          ? "#ff8000"
          : n >= 75
            ? "#a335ee"
            : n >= 50
              ? "#0070ff"
              : n >= 25
                ? "#1eff00"
                : "#aaa";

type Loaded = { key: string; data: ParseData | null; error: string | null };
export function PredictedParses({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const [options, setOptions] = useState(savedParseOptions);
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState<"selected" | "raid">("selected");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const replay = state.replay;
  const selected = replay?.actors.find(
    (a) =>
      a.key === state.selected &&
      a.type === "Player" &&
      replay.fight.friendlyPlayers.includes(a.id),
  );
  const hasScope = scope === "raid" || !!selected;
  const clock = state.playing ? Math.floor(state.time / 250) * 250 : state.time;
  const encounter = parseEncounter(replay, clock);
  const end = encounter
    ? Math.max(encounter.start, Math.min(clock, encounter.end))
    : 0;
  const ranges = useMemo<[number, number][]>(
    () =>
      encounter &&
      hasScope &&
      encounter.kill !== false &&
      predictionSupported(options) &&
      end > encounter.start
        ? [[encounter.start, end]]
        : [],
    [
      encounter?.id,
      encounter?.start,
      encounter?.kill,
      end,
      hasScope,
      options.compare,
      options.timeframe,
    ],
  );
  useAnalysisData(state, controller, ranges);
  const ready =
    !!replay &&
    ranges.every(([a, b]) => analysisIntervalsAvailable(replay, a, b));
  const identity = replayIdentity(replay);
  const key = JSON.stringify([
    identity,
    replay?.gameVersion,
    replay?.raw.stream?.revision,
    encounter?.id,
    encounter?.encounterID,
    encounter?.end,
    encounter?.kill,
    options,
    scope,
    scope === "selected" ? selected?.key : null,
    state.wclConnected,
    refresh,
  ]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(options));
    } catch {}
  }, [options]);
  useEffect(() => {
    if (
      !replay ||
      !encounter ||
      !state.wclConnected ||
      !hasScope ||
      encounter.kill === false
    )
      return;
    const abort = new AbortController();
    void controller
      .playbackParseData(
        replay.report.code,
        encounter,
        replay.gameVersion,
        options,
        abort.signal,
        scope === "selected" && selected
          ? { name: selected.name, className: selected.class }
          : undefined,
      )
      .then((data) => {
        if (!abort.signal.aborted) setLoaded({ key, data, error: null });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setLoaded({
            key,
            data: null,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => abort.abort();
  }, [controller, key]);
  const data = loaded?.key === key ? loaded.data : null;
  const error = loaded?.key === key ? loaded.error : null;
  const finished = !!encounter && clock >= encounter.end;
  const pace = useMemo(
    () =>
      replay && encounter && predictionSupported(options) && ready
        ? parsePace(replay, encounter, clock)
        : (replay?.actors
            .filter(
              (a) =>
                a.type === "Player" &&
                replay.fight.friendlyPlayers.includes(a.id),
            )
            .map((actor) => ({ actor, damage: 0, dps: null })) ?? []),
    [
      replay,
      encounter?.id,
      encounter?.start,
      encounter?.end,
      clock,
      ready,
      options.compare,
      options.timeframe,
    ],
  );
  const rows = pace
    .filter((row) => scope === "raid" || row.actor.key === selected?.key)
    .map((row) => {
      const reference =
        replay && data ? referenceFor(replay, row.actor.key, data) : null;
      const final =
        reference?.player.role === "healers"
          ? null
          : options.bracket === "overall"
            ? (reference?.player.percentile ?? null)
            : (reference?.player.bracketPercentile ?? null);
      const value = finished
        ? final
        : row.dps !== null && reference?.curve
          ? percentileAt(row.dps, reference.curve)
          : null;
      return {
        ...row,
        value,
        note:
          reference?.note ??
          (!reference
            ? "No matching WCL damage ranking for this player."
            : !reference.curve
              ? "No comparison curve is available."
              : null),
      };
    })
    .sort(
      (a, b) =>
        (b.value ?? -1) - (a.value ?? -1) ||
        a.actor.name.localeCompare(b.actor.name),
    );
  const set = (value: Partial<ParseOptions>) =>
    setOptions((o) => ({ ...o, ...value }));
  return (
    <div className="predicted-parses">
      <div className="parse-controls">
        <label>
          Players
          <select
            aria-label="Parse players"
            value={scope}
            onChange={(e) => setScope(e.target.value as "selected" | "raid")}
          >
            <option value="selected">Selected player</option>
            <option value="raid">Whole raid</option>
          </select>
        </label>
        <label>
          Comparison
          <select
            aria-label="Parse comparison"
            value={options.compare}
            onChange={(e) =>
              set({ compare: e.target.value as ParseOptions["compare"] })
            }
          >
            <option>Parses</option>
            <option>Rankings</option>
          </select>
        </label>
        <label>
          Timeframe
          <select
            aria-label="Parse timeframe"
            value={options.timeframe}
            onChange={(e) =>
              set({ timeframe: e.target.value as ParseOptions["timeframe"] })
            }
          >
            <option>Historical</option>
            <option>Today</option>
          </select>
        </label>
        <label>
          Bracket
          <select
            aria-label="Parse bracket"
            value={options.bracket}
            onChange={(e) =>
              set({ bracket: e.target.value as ParseOptions["bracket"] })
            }
          >
            <option value="overall">Overall</option>
            <option value="itemLevel">Item level</option>
          </select>
        </label>
        <button
          onClick={() => setRefresh((n) => n + 1)}
          disabled={!state.wclConnected || !encounter || !hasScope}
        >
          Refresh
        </button>
      </div>
      {!encounter ? (
        <p role="status">
          Move playback into a boss fight to see predicted parses.
        </p>
      ) : encounter.kill === false ? (
        <p role="status">
          This pull is a wipe. WCL has no ranked result to compare.
        </p>
      ) : !state.wclConnected ? (
        <p role="status">
          <button onClick={() => void controller.connectWcl()}>
            Connect Warcraft Logs
          </button>{" "}
          to load parse comparisons.
        </p>
      ) : !hasScope ? (
        <p role="status">
          Select a friendly player, or choose Whole raid to load everyone. Whole
          raid uses more of your WCL API allowance.
        </p>
      ) : (
        <>
          <p className="parse-caption">
            <strong>{encounter.name}</strong> ·{" "}
            {finished ? "Final WCL result" : "Predicted finish"}
          </p>
          {!predictionSupported(options) && !finished && (
            <p role="status">
              Prediction unavailable for {options.timeframe} + {options.compare}
              . Choose Today + Rankings for playback predictions. Your selected
              WCL result appears at the end of the fight.{" "}
              <button
                onClick={() => set({ compare: "Rankings", timeframe: "Today" })}
              >
                Use Today + Rankings
              </button>
            </p>
          )}
          {predictionSupported(options) && !finished && (
            <p className="parse-caption">
              Pace estimate if current DPS is maintained. Uses sampled WCL
              rankings, including pet damage. Early burst and encounter scoring
              rules can affect accuracy.
            </p>
          )}
          {error ? (
            <p role="alert">
              {error}{" "}
              <button onClick={() => setRefresh((n) => n + 1)}>Retry</button>
            </p>
          ) : !data ? (
            <p role="status">Loading WCL comparisons…</p>
          ) : (
            <>
              {!ready && !finished && (
                <p role="status">
                  {state.bufferError ?? "Loading damage through the playhead…"}
                </p>
              )}
              <div className="analysis-scroll">
                <table
                  aria-label={
                    finished ? "Final WCL parses" : "Predicted parses"
                  }
                >
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>{finished ? "WCL %" : "Predicted %"}</th>
                      {predictionSupported(options) && !finished && (
                        <th>Pace DPS</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.actor.key}
                        className={
                          state.selected === row.actor.key
                            ? "is-selected"
                            : undefined
                        }
                      >
                        <td>
                          <button
                            onClick={() =>
                              controller.select(row.actor.key, false)
                            }
                          >
                            {row.actor.name}
                          </button>
                          {row.value === null &&
                            row.note &&
                            predictionSupported(options) && (
                              <small className="parse-row-note">
                                {row.note}
                              </small>
                            )}
                        </td>
                        <td
                          title={
                            row.value === null
                              ? (row.note ??
                                (end <= encounter.start
                                  ? "Waiting for damage after the pull starts."
                                  : "Comparison data is loading."))
                              : finished
                                ? "WCL result for the selected comparison"
                                : "Estimated percentile if current DPS is maintained"
                          }
                          style={{ color: color(row.value) }}
                        >
                          {percentage(row.value)}
                        </td>
                        {predictionSupported(options) && !finished && (
                          <td>{ready ? formatRate(row.dps) : "—"}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
