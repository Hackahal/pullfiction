import { useMemo, useState } from "react";
import { useAnalysisData } from "./use-analysis-data";
import { useSpeedrunRecord } from "./use-speedrun-record";
import { compareSpeedrun } from "./speedrun-comparison";
import type { EditorController } from "./controller";
import type { Snapshot, Replay } from "./types";
import { indexSpeedrun, speedrunAt, timerTime } from "./speedrun-model";

type RecordState = ReturnType<typeof useSpeedrunRecord>;
const deltaTime = (value: number | null) =>
  value === null
    ? "—"
    : `${value < 0 ? "−" : "+"}${timerTime(Math.abs(value))}`;
const splitTime = (value: number) => timerTime(value).slice(0, -1);
const splitDelta = (value: number | null) =>
  value === null ? "—" : deltaTime(value).slice(0, -1);
const deltaClass = (value: number | null) =>
  value === null ? "" : value < 0 ? "is-ahead" : value > 0 ? "is-behind" : "";

export function SpeedrunPanel({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  useAnalysisData(
    state,
    controller,
    state.replay?.fight.completeRaid ? [[0, state.time]] : [],
  );
  const record = useSpeedrunRecord(state, controller);
  return (
    <SpeedrunTimer
      replay={state.replay}
      time={state.time}
      seek={(t) => controller.seek(t)}
      recordState={record}
      connect={() => void controller.connectWcl()}
    />
  );
}

export function SpeedrunTimer({
  replay,
  time,
  seek,
  recordState,
  connect,
}: {
  replay: Replay | null;
  time: number;
  seek: (time: number) => void;
  recordState?: RecordState;
  connect?: () => void;
}) {
  const [chosenHeat, setHeat] = useState<1 | 2 | 3>(1);
  const recordedHeat =
    replay?.fight.difficulty !== undefined &&
    [3, 4, 5].includes(replay.fight.difficulty)
      ? replay.fight.difficulty - 2
      : null;
  const heat = (recordedHeat ?? chosenHeat) as 1 | 2 | 3;
  const index = useMemo(
    () => (replay ? indexSpeedrun(replay, { heat }) : null),
    [replay, replay?.raw.stream?.revision, heat],
  );
  if (!index || !replay)
    return (
      <div className="speedrun-panel">
        <p>
          Load a full raid replay to see the speedrun timer and boss splits.
        </p>
      </div>
    );
  const run = speedrunAt(index, time),
    rules = index.rules;
  const reference = recordState?.record ?? null;
  const comparison = compareSpeedrun(index, run, reference);
  const rows = comparison.rows.filter(
    (s) =>
      s.kill !== false ||
      !comparison.rows.some(
        (other) => other.encounterID === s.encounterID && other.kill,
      ),
  );
  const current = rows.find((s) => !s.completed && s.end > run.cutoff);
  const status = !run.fullRun
    ? "Encounter preview"
    : !run.started
      ? "Waiting for start"
      : run.finished
        ? run.allBosses
          ? "Finish recorded"
          : "Finish recorded · bosses missing"
        : "In progress";
  const selection = recordState?.selection,
    category = recordState?.category;
  return (
    <section className="speedrun-panel" aria-label="Speedrun timer">
      <div className="speedrun-heading">
        <span>{replay.fight.gameZone.name}</span>
        <span>{replay.gameVersion === "sod" ? "SoD" : "Classic Era"}</span>
      </div>
      <div className="speedrun-reference">
        {reference ? (
          <>
            <a
              href={reference.url}
              target="_blank"
              rel="noreferrer"
              title={`Fetched ${new Date(reference.fetchedAt).toLocaleString()}`}
            >
              WR · {reference.guild}
            </a>
            <strong>{timerTime(reference.duration)}</strong>
          </>
        ) : (
          <span>
            {recordState?.loading
              ? "Loading current WCL WR…"
              : recordState?.connected
                ? (recordState.error ?? "No ranked full run in this category.")
                : "Connect WCL for the current world record."}
          </span>
        )}
        {!recordState?.connected && connect && (
          <button onClick={connect}>Connect WCL</button>
        )}
        {recordState?.connected && (
          <button
            onClick={recordState.retry}
            disabled={recordState.loading}
            aria-label="Refresh world record"
          >
            {recordState.error ? "Retry" : "Refresh"}
          </button>
        )}
      </div>
      {category && selection && recordState && (
        <details className="speedrun-settings">
          <summary>WR category</summary>
          <label>
            Partition
            <select
              aria-label="WR partition"
              value={selection.partition}
              onChange={(e) =>
                recordState.select({
                  ...selection,
                  partition: Number(e.target.value),
                })
              }
            >
              {category.partitions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Difficulty
            <select
              aria-label="WR difficulty"
              value={selection.difficulty}
              onChange={(e) => {
                const difficulty = category.difficulties.find(
                  (d) => d.id === Number(e.target.value),
                )!;
                recordState.select({
                  ...selection,
                  difficulty: difficulty.id,
                  size: difficulty.sizes[0] ?? null,
                });
              }}
            >
              {category.difficulties.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {!!category.difficulties.find((d) => d.id === selection.difficulty)
            ?.sizes.length && (
            <label>
              Size
              <select
                aria-label="WR raid size"
                value={selection.size ?? ""}
                onChange={(e) =>
                  recordState.select({
                    ...selection,
                    size: Number(e.target.value),
                  })
                }
              >
                {category.difficulties
                  .find((d) => d.id === selection.difficulty)!
                  .sizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {replay.gameVersion === "vanilla" && (
            <>
              <label>
                Trash
                <select
                  aria-label="WR trash category"
                  value={Number(selection.skips)}
                  onChange={(e) =>
                    recordState.select({
                      ...selection,
                      skips: e.target.value === "1",
                    })
                  }
                >
                  <option value={0}>Without skips</option>
                  <option value={1}>With skips · API unavailable</option>
                </select>
              </label>
            </>
          )}
        </details>
      )}
      {selection && category && (
        <p className="speedrun-category-label">
          {category.partitions.find((p) => p.id === selection.partition)?.name}{" "}
          ·{" "}
          {
            category.difficulties.find((d) => d.id === selection.difficulty)
              ?.name
          }
          {selection.size ? ` · ${selection.size} player` : ""} ·{" "}
          {replay.gameVersion === "sod"
            ? "WCL penalty rules"
            : selection.skips
              ? "With skips"
              : "Without skips"}
        </p>
      )}
      <table className="speedrun-splits">
        <caption>Boss splits · vs world record</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">+/−</th>
            <th scope="col">Split</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className={
                s === current ? "is-current" : s.completed ? "is-complete" : ""
              }
              aria-current={s === current ? "step" : undefined}
            >
              <td>
                <button
                  onClick={() => seek(s.start)}
                  title={`Seek to ${s.name}`}
                >
                  {s.name}
                  {s.kill === false ? " · wipe" : ""}
                </button>
              </td>
              <td className={deltaClass(s.delta)}>{splitDelta(s.delta)}</td>
              <td>
                {s.completed && s.elapsed !== null
                  ? splitTime(s.elapsed)
                  : s.target !== null
                    ? splitTime(s.target)
                    : "—"}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={3}>No boss encounters recorded.</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="speedrun-clock" aria-label="Elapsed speedrun time">
        {timerTime(run.elapsed)}
      </div>
      <div className="speedrun-status">
        {status}
        {index.estimated ? " · estimated clock" : ""}
      </div>
      <dl className="speedrun-metrics">
        <div>
          <dt>Previous segment</dt>
          <dd className={deltaClass(comparison.previousSegment)}>
            {deltaTime(comparison.previousSegment)}
          </dd>
        </div>
        <div>
          <dt>Projected finish</dt>
          <dd>
            {comparison.projected === null
              ? "—"
              : timerTime(comparison.projected)}
          </dd>
        </div>
        {reference && (
          <div>
            <dt>World record</dt>
            <dd>{timerTime(reference.duration)}</dd>
          </div>
        )}
      </dl>
      {reference && (
        <p className="speedrun-comparison-note">
          {index.replay.fight.categoryMixed
            ? "This run mixes difficulties or raid sizes. WR deltas are unavailable."
            : (reference.splitNote ??
              (!comparison.categoryMatches
                ? "Select the matching difficulty, heat and raid size for WR deltas."
                : !comparison.routeMatches
                  ? "Boss order differs from the WR. Cumulative deltas are unavailable."
                  : index.estimated
                    ? "Start is estimated. WR deltas are unavailable."
                    : !run.coverage
                      ? "Split deltas need the missing combat data."
                      : "Projection holds your last completed split delta."))}{" "}
          <a href={reference.leaderboardUrl} target="_blank" rel="noreferrer">
            WCL leaderboard
          </a>
        </p>
      )}
      {replay.map === 409 && replay.gameVersion === "sod" && (
        <label className="speedrun-heat">
          Molten Core heat{" "}
          <select
            aria-label="Molten Core heat"
            disabled={recordedHeat !== null}
            value={heat}
            onChange={(e) => setHeat(Number(e.target.value) as 1 | 2 | 3)}
          >
            <option value={1}>Heat 1</option>
            <option value={2}>Heat 2</option>
            <option value={3}>Heat 3</option>
          </select>
        </label>
      )}
      {!run.fullRun && (
        <p className="speedrun-notice">
          Open the full raid run to evaluate trash requirements and the run
          clock.
        </p>
      )}
      {rules?.coverage !== "published" && (
        <p className="speedrun-notice">
          WCL requirements unverified for this raid/version.
        </p>
      )}
      {run.fullRun && !run.coverage && (
        <p className="speedrun-notice">
          {index.start === null
            ? "Required start pull not recorded."
            : "Combat data is incomplete through this moment. Counts show observed kills only."}
        </p>
      )}
      {run.fullRun && run.requirements.length > 0 && (
        <details className="speedrun-trash">
          <summary>
            Mob requirements{" "}
            <span>
              {run.requirements.filter((r) => r.met).length}/
              {run.requirements.length} met
            </span>
          </summary>
          <ul className="speedrun-requirements">
            {run.requirements.map((r) => (
              <li
                key={r.name}
                className={r.met ? "is-complete" : ""}
                title={`NPC IDs: ${r.ids.join(", ")}`}
              >
                <span>
                  {r.met ? "✓ " : ""}
                  {r.name}
                </span>
                <span>
                  {r.count}/{r.required}
                  {!run.coverage ? "+?" : ""}
                </span>
              </li>
            ))}
          </ul>
          {rules?.penalty && (
            <div className="speedrun-penalty">
              <span>
                {run.finalPenalty
                  ? "Trash / deadline penalty"
                  : "Penalty if ending now · provisional"}
              </span>
              <strong>+{timerTime(run.penalty)}</strong>
            </div>
          )}
          {run.captainPenalty > 0 && (
            <p className="speedrun-notice">
              Includes 5:00 for the Razuvious captain deadline.
            </p>
          )}
          {run.finalPenalty && (
            <div className="speedrun-penalty">
              <span>Elapsed + trash / deadline</span>
              <strong>{timerTime(run.elapsed + run.penalty)}</strong>
            </div>
          )}
        </details>
      )}
      <details className="speedrun-rules">
        <summary>WCL rules and coverage</summary>
        <p>{rules?.note}</p>
        <p>
          Bosses must be completed in one run. Kills after the final boss do not
          count. Counts use recorded NPC deaths, grouped by creature ID.
        </p>
        <p>
          WR split deltas use elapsed time. The WCL total can include penalties.
          This panel does not certify a WCL ranking. Roster swaps, banned
          buffs/items, preclearing, required videos and hardmode evidence need
          separate review. SoD roster swaps add 1 minute each and are not
          included in the displayed penalty.
        </p>
        {rules && (
          <a href={rules.source} target="_blank" rel="noreferrer">
            WCL source · checked {rules.checked}
          </a>
        )}
      </details>
    </section>
  );
}
