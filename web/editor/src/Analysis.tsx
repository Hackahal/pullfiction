import { PredictedParses } from "./PredictedParses";
import {
  replayIdentity,
  analysisIntervalsAvailable,
  streamComplete,
} from "./replay-buffer";
import { GameIcon } from "./GameIcon";
import { useAnalysisData } from "./use-analysis-data";
import { Bar, ReferenceHover } from "./FocusWidgets";
import { PanelSettings } from "./PanelSettings";
import { EditorIcon } from "./EditorIcon";
import { analysisRange, type AnalysisWindow } from "./analysis-range";
import {
  formatRate,
  perSecond,
  type CombatSideSetting,
} from "./combat-metrics";
import { POWER_COLORS, POWER_NAMES } from "./focus-model";
import {
  useMemo,
  useState,
  useEffect,
  useContext,
  type ReactElement,
  type AnchorHTMLAttributes,
} from "react";
import { GameVersionContext, wowheadUrl } from "./Wowhead";
import { EditorController } from "./controller";
import { CLASS_COLORS, combatStateAt, preciseTime, time } from "./domain";
import type { Snapshot } from "./types";
import {
  metrics,
  indexEvents,
  queryEvents,
  summarize,
  graphBuckets,
  meterColor,
  deathRecap,
  type AnalysisEvent,
  type Metric,
} from "./analysis-model";
const defaults = {
  metric: "damage" as Metric,
  view: "meter",
  group: "actor" as "actor" | "spell" | "target",
  window: "encounter" as AnalysisWindow,
  pets: true,
  victimPets: false,
  mergePets: true,
  hostility: "default" as CombatSideSetting,
};
function AbilityReference({
  spell,
  name,
  children,
}: {
  spell?: number;
  name: string;
  children: ReactElement;
}) {
  const id = spell === -4 ? 1 : spell;
  const version = useContext(GameVersionContext);
  const props = children.props as AnchorHTMLAttributes<HTMLAnchorElement>;
  return id && id > 0 ? (
    <ReferenceHover
      className="analysis-reference"
      kind="spell"
      id={id}
      title={name}
    >
      <a
        {...props}
        href={wowheadUrl("spell", id, version)}
        role="button"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          props.onClick?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      />
    </ReferenceHover>
  ) : (
    children
  );
}
function saved(key: string, preset: Partial<typeof defaults>): typeof defaults {
  const base = { ...defaults, ...preset };
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      ...base,
      metric: Object.hasOwn(metrics, s.metric) ? s.metric : base.metric,
      view: [
        "meter",
        "table",
        "graph",
        "events",
        "resources",
        "parses",
      ].includes(s.view)
        ? s.view
        : base.view,
      group: ["actor", "spell", "target"].includes(s.group)
        ? s.group
        : base.group,
      window: ["encounter", "rolling", "elapsed", "full"].includes(s.window)
        ? s.window
        : base.window,
      pets: typeof s.pets === "boolean" ? s.pets : true,
      victimPets: typeof s.victimPets === "boolean" ? s.victimPets : false,
      mergePets: typeof s.mergePets === "boolean" ? s.mergePets : true,
      hostility: ["default", "all", "enemies", "friendlies"].includes(
        s.hostility,
      )
        ? s.hostility
        : "default",
    };
  } catch {
    return base;
  }
}
export function Analysis({
  state,
  controller,
  close,
  preset = {},
  storageKey = "pullfiction.analysis",
}: {
  state: Snapshot;
  controller: EditorController;
  close: () => void;
  preset?: Partial<typeof defaults>;
  storageKey?: string;
}) {
  const [config, setConfig] = useState(() => saved(storageKey, preset)),
    [source, setSource] = useState("*"),
    [target, setTarget] = useState("*"),
    [spell, setSpell] = useState("*"),
    [fight, setFight] = useState(""),
    [recap, setRecap] = useState<AnalysisEvent | null>(null),
    [search, setSearch] = useState(""),
    [ascending, setAscending] = useState(false);
  const replay = state.replay;
  const events = useMemo(
    () =>
      replay && config.view !== "resources" && config.view !== "parses"
        ? indexEvents(replay)
        : [],
    [replay, config.view === "resources" || config.view === "parses"],
  );
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(config));
    } catch {}
  }, [config, storageKey]);
  useEffect(() => {
    setSource("*");
    setTarget("*");
    setSpell("*");
    setFight("");
    setRecap(null);
  }, [replayIdentity(replay)]);
  const clock = state.playing ? Math.floor(state.time / 250) * 250 : state.time;
  const recipientMetric = ["taken", "death", "buff", "debuff"].includes(
    config.metric,
  );
  const includePets = recipientMetric ? config.victimPets : config.pets;
  const range = useMemo(
    () => analysisRange(replay, clock, config.window, fight),
    [replay, clock, config.window, fight],
  );
  const allCombatIntervals = useMemo(
    () =>
      replay
        ? analysisRange(replay, replay.duration, "elapsed").intervals
        : undefined,
    [replay],
  );
  const { start, end, displayEnd, seconds } = range;
  const neededRanges = useMemo<[number, number][]>(
    () =>
      config.view === "resources" || config.view === "parses"
        ? []
        : config.window === "elapsed" && !fight
          ? ((config.view === "graph"
              ? allCombatIntervals
              : range.intervals) ?? [
              [start, config.view === "graph" ? displayEnd : end],
            ])
          : [[start, config.view === "graph" ? displayEnd : end]],
    [
      config.view,
      config.window,
      fight,
      allCombatIntervals,
      range.intervals,
      start,
      end,
      displayEnd,
    ],
  );
  useAnalysisData(state, controller, neededRanges);
  const dataReady =
    !replay ||
    neededRanges.every(([a, b]) => analysisIntervalsAvailable(replay, a, b));
  const filtered = useMemo(
    () =>
      replay
        ? queryEvents(
            events,
            {
              metric: config.metric,
              source,
              target,
              spell,
              pets: includePets,
              ownerPets: config.mergePets,
              hostility:
                config.hostility === "default" ? undefined : config.hostility,
              start,
              end,
              intervals: range.intervals,
            },
            replay,
          )
        : [],
    [
      events,
      replay,
      config.metric,
      source,
      target,
      spell,
      includePets,
      config.mergePets,
      config.hostility,
      start,
      end,
      range.intervals,
    ],
  );
  const rows = useMemo(
    () =>
      replay
        ? summarize(
            filtered,
            config.metric,
            config.group,
            replay,
            config.mergePets,
          )
        : [],
    [filtered, replay, config.metric, config.group, config.mergePets],
  );
  const shown = rows.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()),
  );
  if (ascending) shown.reverse();
  const buckets = useMemo(
    () =>
      config.view === "graph" && replay
        ? graphBuckets(
            queryEvents(
              events,
              {
                metric: config.metric,
                source,
                target,
                spell,
                pets: includePets,
                ownerPets: config.mergePets,
                hostility:
                  config.hostility === "default" ? undefined : config.hostility,
                start,
                end: displayEnd,
                intervals:
                  config.window === "elapsed" && !fight
                    ? analysisRange(replay, replay.duration, "elapsed")
                        .intervals
                    : undefined,
              },
              replay,
            ),
            start,
            Math.max(start + 1, displayEnd),
            config.metric,
            Math.max(1, Math.ceil((displayEnd - start) / 250)),
          )
        : [],
    [
      events,
      replay,
      config.view,
      config.metric,
      source,
      target,
      spell,
      includePets,
      config.mergePets,
      config.hostility,
      start,
      displayEnd,
      config.window,
      fight,
    ],
  );
  const { graphPath, max } = useMemo(() => {
    const max = buckets.reduce((n, v) => Math.max(n, v), 1);
    const graphPath = buckets
      .map(
        (v, i) =>
          `${i ? "L" : "M"}${(i / Math.max(1, buckets.length - 1)) * 600},${175 - (v / max) * 165}`,
      )
      .join(" ");
    return { graphPath, max };
  }, [buckets]);
  const total = rows.reduce((s, r) => s + r.total, 0);
  useEffect(
    () => setRecap(null),
    [config.metric, config.window, config.view, source, target, spell, fight],
  );
  const actors = replay?.actors ?? [];
  const counterpart = ["taken", "death"].includes(config.metric)
    ? "Attacker"
    : ["buff", "debuff"].includes(config.metric)
      ? "Aura source"
      : "Target";
  const set = (v: Partial<typeof config>) => setConfig((c) => ({ ...c, ...v }));
  const actorMap = useMemo(
    () => new Map(actors.map((a) => [a.key, a])),
    [actors, actors.length],
  );
  const actorOptions = useMemo(
    () =>
      actors.map((a) => (
        <option key={a.key} value={a.key}>
          {a.name}
          {a.instance > 1 ? ` #${a.instance}` : ""}
        </option>
      )),
    [actors, actors.length],
  );
  const abilityOptions = useMemo(
    () =>
      [...(replay?.abilities ?? [])]
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([id, a]) => (
          <option key={id} value={id}>
            {a.name}
          </option>
        )),
    [replay?.abilities],
  );
  const rateLabel =
    config.metric === "cast"
      ? "CPM"
      : config.metric === "damage"
        ? "DPS"
        : config.metric === "taken"
          ? "DTPS"
          : config.metric === "heal"
            ? "HPS"
            : null;
  const rate = (n: number) => {
    const v = perSecond(n, seconds);
    return v === null ? null : v * (config.metric === "cast" ? 60 : 1);
  };
  const rateText = (n: number, compact = false, digits = 0) =>
    formatRate(rate(n), compact, digits);
  const clearFilters = () => {
    setRecap(null);
    setSource("*");
    setTarget("*");
    setSpell("*");
    setSearch("");
    set({ group: "actor" });
  };
  const back = () => {
    if (recap) {
      setRecap(null);
      return;
    }
    if (target !== "*") {
      setTarget("*");
      set({
        group: spell === "*" ? (source === "*" ? "actor" : "spell") : "target",
      });
    } else if (spell !== "*") {
      setSpell("*");
      set({ group: "spell" });
    } else {
      setSource("*");
      set({ group: "actor" });
    }
  };
  const drill = (r: (typeof rows)[number]) => {
    if (r.spell !== undefined) {
      setSpell(String(r.spell));
      set({ group: "target" });
    } else if (r.actor) {
      if (config.group === "target") {
        setTarget(r.actor);
        set({ group: "spell" });
      } else {
        controller.select(r.actor, false);
        setSource(r.actor);
        set({
          group: config.metric === "death" ? "actor" : "spell",
          ...(config.metric === "death" ? { view: "events" } : {}),
        });
      }
    }
  };
  const actorSelect = (
    value: string,
    onChange: (v: string) => void,
    label: string,
  ) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="*">All {label.toLowerCase()}s</option>
      {actorOptions}
    </select>
  );
  if (config.view === "parses")
    return (
      <section className="analysis-panel analysis-v2" aria-label="Analysis">
        <div className="analysis-header">
          <strong>Predicted parses</strong>
          <button onClick={() => set({ view: "meter", metric: "damage" })}>
            Damage meter
          </button>
          <button aria-label="Close analysis" onClick={close}>
            ×
          </button>
        </div>
        <PredictedParses state={state} controller={controller} />
      </section>
    );
  return (
    <section className="analysis-panel analysis-v2" aria-label="Analysis">
      <div className="analysis-header">
        {config.view === "resources" ? (
          <strong>Resources</strong>
        ) : (
          <>
            <select
              aria-label="Metric"
              value={config.metric}
              onChange={(e) => {
                set({
                  metric: e.target.value as Metric,
                  group: source === "*" ? "actor" : "spell",
                });
                setSpell("*");
                setTarget("*");
                setRecap(null);
              }}
            >
              {Object.entries(metrics).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select
              aria-label="Analysis time range"
              value={fight ? `fight:${fight}` : config.window}
              onChange={(e) => {
                if (e.target.value.startsWith("fight:"))
                  setFight(e.target.value.slice(6));
                else {
                  setFight("");
                  set({ window: e.target.value as AnalysisWindow });
                }
              }}
            >
              <option value="encounter">Current pull</option>
              <option value="elapsed">Overall</option>
              <optgroup label="Time ranges">
                <option value="rolling">Last 10 seconds</option>
                <option value="full">Full run</option>
              </optgroup>
              {!!replay?.chapters.length && (
                <optgroup label="Pulls">
                  {replay.chapters.map((c) => (
                    <option key={c.id} value={`fight:${c.id}`}>
                      {time(c.start)} · {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </>
        )}
        {config.metric === "damage" && config.view !== "resources" && (
          <button
            title="Show predicted parses during playback"
            onClick={() => set({ view: "parses" })}
          >
            Parse %
          </button>
        )}
        <PanelSettings
          title={
            config.view === "resources"
              ? "Resource settings"
              : config.view === "events"
                ? "Event settings"
                : "Meter settings"
          }
        >
          <div className="analysis-options">
            <label>
              View
              <select
                aria-label="Analysis view"
                value={config.view}
                onChange={(e) => set({ view: e.target.value })}
              >
                <option value="meter">Meter</option>
                <option value="table">Table</option>
                <option value="graph">Graph</option>
                <option value="events">Events</option>
                <option value="resources">Resources</option>
                <option value="parses">Predicted parses</option>
              </select>
            </label>
            {config.view !== "resources" && (
              <label>
                Breakdown
                <select
                  aria-label="Group by"
                  value={config.group}
                  onChange={(e) =>
                    set({ group: e.target.value as typeof config.group })
                  }
                >
                  <option value="actor">By player</option>
                  <option value="spell">By ability</option>
                  <option value="target">By {counterpart.toLowerCase()}</option>
                </select>
              </label>
            )}
            <label>Player{actorSelect(source, setSource, "Actor")}</label>
            {config.view !== "resources" && (
              <>
                <label>
                  {counterpart}
                  {actorSelect(target, setTarget, counterpart)}
                </label>
                <label>
                  Ability
                  <select
                    aria-label="Ability filter"
                    value={spell}
                    onChange={(e) => setSpell(e.target.value)}
                  >
                    <option value="*">All abilities</option>
                    {abilityOptions}
                  </select>
                </label>
                <label>
                  Search
                  <input
                    aria-label="Filter analysis rows"
                    placeholder="Name or ability…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <label>
                  Target side
                  <select
                    aria-label="Analysis target side"
                    value={config.hostility}
                    onChange={(e) =>
                      set({ hostility: e.target.value as CombatSideSetting })
                    }
                  >
                    <option value="default">Metric default</option>
                    <option value="enemies">Enemy targets</option>
                    <option value="friendlies">
                      Raid targets / friendly fire
                    </option>
                    <option value="all">All targets</option>
                  </select>
                </label>
                <label className="panel-check">
                  <input
                    type="checkbox"
                    checked={includePets}
                    onChange={(e) =>
                      set(
                        recipientMetric
                          ? { victimPets: e.target.checked }
                          : { pets: e.target.checked },
                      )
                    }
                  />
                  Include pets
                </label>
                {!recipientMetric && (
                  <label className="panel-check">
                    <input
                      type="checkbox"
                      checked={config.mergePets}
                      disabled={!config.pets}
                      onChange={(e) => set({ mergePets: e.target.checked })}
                    />
                    Merge pets into owners
                  </label>
                )}
                <label className="panel-check">
                  <input
                    type="checkbox"
                    checked={ascending}
                    onChange={(e) => setAscending(e.target.checked)}
                  />
                  Lowest first
                </label>
              </>
            )}
            <div className="analysis-option-actions">
              <button
                disabled={!state.selected}
                onClick={() => setSource(state.selected ?? "*")}
              >
                Use focused player
              </button>
              <button onClick={clearFilters}>Reset filters</button>
            </div>
          </div>
        </PanelSettings>
      </div>
      {(source !== "*" || target !== "*" || spell !== "*" || recap) && (
        <nav className="analysis-breadcrumb" aria-label="Analysis breakdown">
          <button onClick={back} aria-label="Back in analysis">
            <EditorIcon name="back" />
          </button>
          <button onClick={clearFilters}>All players</button>
          {source !== "*" && (
            <>
              <span>›</span>
              <button
                style={{
                  color: replay ? meterColor(replay, source) : undefined,
                }}
                onClick={() => {
                  setSpell("*");
                  setTarget("*");
                  set({ group: "spell" });
                }}
              >
                {actorMap.get(source)?.name ?? "Player"}
              </button>
            </>
          )}
          {spell !== "*" && (
            <>
              <span>›</span>
              <span>
                {replay?.abilities.get(Number(spell))?.name ?? "Ability"}
              </span>
            </>
          )}
          {target !== "*" && (
            <>
              <span>›</span>
              <span>{actorMap.get(target)?.name ?? counterpart}</span>
            </>
          )}
          {recap && (
            <>
              <span>›</span>
              <span>Death at {preciseTime(recap.t)}</span>
            </>
          )}
        </nav>
      )}
      {!replay ? (
        <div className="analysis-empty">Import a log to analyse.</div>
      ) : config.view !== "resources" &&
        (!dataReady || (replay.raw?.stream && state.buffering)) ? (
        <div className="analysis-empty" role="status">
          {state.bufferError
            ? "Could not load this range."
            : "Loading this range…"}
        </div>
      ) : (
        <>
          {recap ? (
            <div className="analysis-context">
              <span>
                {actorMap.get(recap.target)?.name} · Last 10s before death
              </span>
              <button onClick={() => controller.seek(recap.t)}>
                Jump to death
              </button>
            </div>
          ) : (
            config.view !== "resources" && (
              <div
                className="analysis-context"
                title={`${preciseTime(start)} – ${preciseTime(end)} · ${filtered.length.toLocaleString()} events${config.window === "elapsed" ? " · rates use combat time" : ""}`}
              >
                <span>
                  {range.label}
                  {range.between && <small> · Finished</small>}
                </span>
                {config.view !== "resources" && (
                  <span>
                    {total.toLocaleString()}
                    {rateLabel && (
                      <>
                        {" "}
                        · {rateText(total)} {rateLabel}
                      </>
                    )}
                  </span>
                )}
              </div>
            )
          )}
          {config.view === "graph" && (
            <div className="analysis-graph">
              <svg
                viewBox="0 0 600 180"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${metrics[config.metric]} per second. Click to seek.`}
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  controller.seek(
                    start +
                      ((e.clientX - b.left) / b.width) * (displayEnd - start),
                  );
                }}
              >
                <path
                  d={graphPath}
                  fill="none"
                  stroke={meterColor(replay, source)}
                  strokeWidth="2"
                />
                <line
                  x1={Math.max(
                    0,
                    Math.min(
                      600,
                      ((state.time - start) / Math.max(1, displayEnd - start)) *
                        600,
                    ),
                  )}
                  x2={Math.max(
                    0,
                    Math.min(
                      600,
                      ((state.time - start) / Math.max(1, displayEnd - start)) *
                        600,
                    ),
                  )}
                  y1="0"
                  y2="180"
                  stroke="white"
                />
              </svg>
              <div className="analysis-graph-axis">
                <span>{time(start)}</span>
                <span>
                  Peak{" "}
                  {max.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  /s
                </span>
                <span>{time(displayEnd)}</span>
              </div>
            </div>
          )}
          {config.view === "resources" ? (
            <div className="analysis-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Health</th>
                    <th>Power</th>
                    <th>Gains / waste · 5s</th>
                    <th>Cast</th>
                  </tr>
                </thead>
                <tbody>
                  {actors
                    .filter(
                      (a) =>
                        a.type === "Player" &&
                        replay.fight.friendlyPlayers.includes(a.id) &&
                        (source === "*" || a.key === source),
                    )
                    .map((a) => {
                      const s = combatStateAt(a, state.time),
                        p = s.power;
                      return (
                        <tr key={a.key}>
                          <td>
                            <button
                              style={{ color: CLASS_COLORS[a.class] }}
                              onClick={() => controller.select(a.key, false)}
                            >
                              {a.name}
                            </button>
                          </td>
                          <td>
                            <Bar
                              label="Health"
                              current={s.health?.current}
                              max={s.health?.max}
                              color={CLASS_COLORS[a.class]}
                              text={
                                s.health
                                  ? `${Math.round(s.health.percent * 100)}%`
                                  : undefined
                              }
                            />
                          </td>
                          <td
                            title={
                              p
                                ? `${p.current ?? "Unknown"} / ${p.max}`
                                : "No recorded power snapshot"
                            }
                          >
                            <Bar
                              label={
                                p ? (POWER_NAMES[p.type] ?? "Power") : "Power"
                              }
                              current={p?.current}
                              max={p?.max}
                              color={
                                p ? (POWER_COLORS[p.type] ?? "#678") : "#678"
                              }
                            />
                          </td>
                          <td>
                            {s.resources.totals
                              .map(
                                (r) =>
                                  `${["Mana", "Rage", "Focus", "Energy"][r.type] ?? `Resource ${r.type}`}: +${r.gain} / ${r.waste}`,
                              )
                              .join(" · ") || "--"}
                          </td>
                          <td>{s.cast?.name ?? ""}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ) : config.view === "events" ? (
            <div className="analysis-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source → Target</th>
                    <th>Ability</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(recap ? deathRecap(events, recap) : filtered)
                    .slice(-250)
                    .reverse()
                    .map((e) => (
                      <tr key={e.id}>
                        <td>
                          <button onClick={() => controller.seek(e.t)}>
                            {preciseTime(e.t)}
                          </button>
                        </td>
                        <td>
                          {actorMap.get(e.source)?.name ?? "Environment"} →{" "}
                          {actorMap.get(e.target)?.name ?? "Unknown"}
                        </td>
                        <td>
                          {e.kind === "death" ? (
                            <button onClick={() => setRecap(e)}>
                              Death recap
                            </button>
                          ) : (
                            <AbilityReference spell={e.spell} name={e.name}>
                              <button
                                onClick={() =>
                                  controller.inspectSpell(
                                    e.spell === -4 ? 1 : e.spell,
                                  )
                                }
                              >
                                {e.name}
                              </button>
                            </AbilityReference>
                          )}
                        </td>
                        <td>{e.amount.toLocaleString()}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!recap && filtered.length > 250 && (
                <p>Latest 250 matching events</p>
              )}
            </div>
          ) : (
            <>
              <div className="analysis-scroll">
                {config.view === "meter" ? (
                  <div
                    className="analysis-meter"
                    aria-label={`${metrics[config.metric]} ranking`}
                  >
                    {shown.map((r, i) => (
                      <AbilityReference
                        key={r.key}
                        spell={r.spell}
                        name={r.name}
                      >
                        <button
                          key={r.key}
                          className="meter-row"
                          onClick={() => drill(r)}
                          style={
                            {
                              "--meter-color": meterColor(
                                replay,
                                r.actor ?? source,
                              ),
                              "--meter-width": `${(r.total / Math.max(1, rows[0]?.total ?? 1)) * 100}%`,
                            } as import("react").CSSProperties
                          }
                          title={`${r.name} · ${r.total.toLocaleString()}${rateLabel ? ` · ${rateText(r.total)} ${rateLabel}` : ""}`}
                        >
                          <span className="meter-rank">{i + 1}</span>
                          <GameIcon
                            name={
                              r.spell !== undefined
                                ? replay.abilities.get(r.spell)?.icon
                                : `classicon_${(actorMap.get(r.actor ?? "")?.class ?? "").toLowerCase()}`
                            }
                            spell={
                              r.spell !== undefined
                                ? r.spell === -4
                                  ? 1
                                  : r.spell
                                : undefined
                            }
                          />
                          <span className="meter-name">{r.name}</span>
                          <span className="meter-value">
                            {r.total.toLocaleString(undefined, {
                              notation: "compact",
                              maximumFractionDigits: 1,
                            })}
                            <small>
                              {total ? ((r.total / total) * 100).toFixed(1) : 0}
                              %
                            </small>
                          </span>
                          {rateLabel && (
                            <span className="meter-rate">
                              {rateText(r.total, true, 1)}
                              <small>{rateLabel}</small>
                            </span>
                          )}
                        </button>
                      </AbilityReference>
                    ))}
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Total</th>
                        {rateLabel && <th>{rateLabel}</th>}
                        <th>Share</th>
                        <th>Events</th>
                        {config.metric === "heal" && <th>Overheal</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.key}>
                          <td
                            style={{
                              background: `linear-gradient(90deg, ${meterColor(replay, r.actor ?? source)}55 ${(r.total / Math.max(1, rows[0]?.total ?? 1)) * 100}%, transparent 0)`,
                            }}
                          >
                            <AbilityReference spell={r.spell} name={r.name}>
                              <button
                                style={{
                                  color: meterColor(replay, r.actor ?? source),
                                }}
                                onClick={() => drill(r)}
                              >
                                <GameIcon
                                  className="analysis-icon"
                                  name={
                                    r.spell !== undefined
                                      ? replay.abilities.get(r.spell)?.icon
                                      : `classicon_${(actorMap.get(r.actor ?? "")?.class ?? "").toLowerCase()}`
                                  }
                                  spell={
                                    r.spell !== undefined
                                      ? r.spell === -4
                                        ? 1
                                        : r.spell
                                      : undefined
                                  }
                                />
                                {r.name}
                              </button>
                            </AbilityReference>
                          </td>
                          <td>{r.total.toLocaleString()}</td>
                          {rateLabel && <td>{rateText(r.total, false, 1)}</td>}
                          <td>
                            {total ? ((r.total / total) * 100).toFixed(1) : 0}%
                          </td>
                          <td>{r.count.toLocaleString()}</td>
                          {config.metric === "heal" && (
                            <td>{r.overheal.toLocaleString()}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {!shown.length && (
                  <div className="analysis-empty">No matching events.</div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
