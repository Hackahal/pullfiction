import {
  replayIdentity,
  analysisAvailable,
  analysisIntervalsAvailable,
  streamComplete,
} from "./replay-buffer";
import { GameIcon } from "./GameIcon";
import { PanelSettings } from "./PanelSettings";
import { useAnalysisData } from "./use-analysis-data";
import { analysisDataIdentity } from "./analysis-data";
import { chartCsvContent } from "./chart-export";
import { analysisRange, chartSummaryRange } from "./analysis-range";
import {
  defaultCombatSide,
  perSecond,
  formatRate,
  type CombatSideSetting,
} from "./combat-metrics";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { animateChartRows } from "./chart-motion";
import { CLASS_COLORS, preciseTime, time } from "./domain";
import {
  chartIndex,
  chartLinePath,
  queryChart,
  queryChartSummary,
  chartMetrics,
  defaultChartQuery,
  schools,
  type ChartMetric,
  type ChartGroup,
  type ChartMode,
  type ChartQuery,
} from "./chart-model";
import type { Actor, Snapshot } from "./types";
import type { EditorController } from "./controller";
interface Config {
  metric: ChartMetric;
  group: ChartGroup;
  scope: "raid" | "selected" | "players";
  players: string[];
  window: "timeline" | "encounter" | "run" | "elapsed" | "10" | "30" | "60";
  style: "line" | "area" | "bars";
  mode: ChartMode;
  bucket: number;
  smoothing: number;
  target: string;
  spell: string;
  school: string;
  periodic: ChartQuery["periodic"];
  hits: ChartQuery["hits"];
  pets: boolean;
  mergePets: boolean;
  limit: number;
  table: boolean;
  hostility: CombatSideSetting;
  area: "all" | "aoe" | "single";
  markers: boolean;
  rank: "total" | "peak" | "count";
}
function defaults(metric: "damage" | "heal"): Config {
  return {
    ...defaultChartQuery,
    metric,
    scope: "raid",
    bucket: 250,
    window: "encounter",
    style: "line",
    smoothing: 5000,
    limit: 10,
    table: true,
    hostility: "default",
    area: "all",
    markers: true,
    rank: "total",
  };
}
function readConfig(key: string, metric: "damage" | "heal"): Config {
  const base = defaults(metric);
  try {
    const saved = localStorage.getItem(key),
      legacy =
        saved === null
          ? (localStorage.getItem(key.replace(/\.v4$/, ".v3")) ??
            localStorage.getItem(key.replace(/\.v4$/, ".v2")) ??
            localStorage.getItem(key.replace(/\.v4$/, ".v1")))
          : null;
    const s = JSON.parse(saved ?? legacy ?? "{}");
    const n = { ...base };
    for (const [field, choices] of Object.entries({
      metric: Object.keys(chartMetrics),
      group: ["total", "player", "class", "ability", "target", "school"],
      scope: ["raid", "selected", "players"],
      window: ["timeline", "encounter", "run", "elapsed", "10", "30", "60"],
      style: ["line", "area", "bars"],
      mode: ["rate", "amount", "cumulative", "share"],
      periodic: ["all", "direct", "periodic"],
      hits: ["all", "normal", "critical"],
      hostility: ["default", "all", "enemies", "friendlies"],
      area: ["all", "aoe", "single"],
      rank: ["total", "peak", "count"],
    }))
      if (choices.includes(s[field])) (n as any)[field] = s[field];
    for (const field of ["pets", "mergePets", "table", "markers"] as const)
      if (typeof s[field] === "boolean") n[field] = s[field];
    if ([100, 250, 500, 1000, 2000, 5000, 10000].includes(s.bucket))
      n.bucket = s.bucket;
    if ([0, 1000, 3000, 5000, 10000].includes(s.smoothing))
      n.smoothing = s.smoothing;
    if ([5, 10, 20, 40, 100].includes(s.limit)) n.limit = s.limit;
    if (s.school === "*" || Object.hasOwn(schools, s.school))
      n.school = s.school;
    if (Array.isArray(s.players))
      n.players = s.players
        .filter((p: unknown) => typeof p === "string" && /^\d+:\d+$/.test(p))
        .slice(0, 500);
    if (
      typeof s.target === "string" &&
      (s.target === "*" || /^\d+:\d+$/.test(s.target))
    )
      n.target = s.target;
    if (
      typeof s.spell === "string" &&
      (s.spell === "*" || /^\d+$/.test(s.spell))
    )
      n.spell = s.spell;
    if (n.scope === "selected") n.scope = "raid";
    if (legacy && s.hostility === "all") n.hostility = "default";
    if (legacy && s.window === "timeline") n.window = "encounter";
    if (legacy && s.bucket === 1000) n.bucket = 250;
    if (legacy && s.smoothing === 3000) n.smoothing = 5000;
    return n;
  } catch {
    return base;
  }
}
export function DamageGraph({
  state,
  controller,
  actor,
  range,
  metric = "damage",
}: {
  state: Snapshot;
  controller: EditorController;
  actor?: Actor;
  range: [number, number];
  metric?: "damage" | "heal";
}) {
  const storage = `pullfiction.chart.${metric}.${state.replay?.report.code ?? "unloaded"}.v4`,
    [stored, setStored] = useState(() => ({
      key: storage,
      config: readConfig(storage, metric),
    })),
    [hidden, setHidden] = useState<string[]>([]),
    [exportRequest, setExportRequest] = useState<{
      source: string;
      config: Config;
    } | null>(null),
    [brush, setBrush] = useState<[number, number] | null>(null),
    [hover, setHover] = useState<{ index: number; x: number } | null>(null),
    [dragging, setDragging] = useState<[number, number] | null>(null),
    dragStart = useRef<number | null>(null);
  const config =
    stored.key === storage ? stored.config : readConfig(storage, metric);
  const setConfig = (change: Config | ((current: Config) => Config)) =>
    setStored((old) => {
      const current =
        old.key === storage ? old.config : readConfig(storage, metric);
      return {
        key: storage,
        config: typeof change === "function" ? change(current) : change,
      };
    });
  useEffect(() => {
    if (stored.key !== storage)
      setStored({ key: storage, config: readConfig(storage, metric) });
  }, [storage, stored.key, metric]);
  const set = (next: Partial<Config>) => {
    setConfig((c) => ({ ...c, ...next }));
    setHover(null);
  };
  useEffect(() => {
    try {
      if (stored.key === storage)
        localStorage.setItem(storage, JSON.stringify(stored.config));
    } catch {}
  }, [stored, storage]);
  const replay = state.replay,
    clock = state.playing ? Math.floor(state.time / 250) * 250 : state.time;
  const hostility =
    config.hostility === "default"
      ? defaultCombatSide(config.metric)
      : config.hostility;
  const summaryRange = useMemo(
    () => chartSummaryRange(replay, clock, config.window, range, brush),
    [replay, clock, config.window, range[0], range[1], brush],
  );
  const combatIntervals = useMemo(
    () =>
      replay
        ? analysisRange(replay, replay.duration, "elapsed").intervals
        : undefined,
    [replay],
  );
  const index = useMemo(() => (replay ? chartIndex(replay) : null), [replay]);
  useEffect(() => {
    setBrush(null);
    setHidden([]);
  }, [replayIdentity(replay)]);
  const players = useMemo(
    () =>
      replay?.actors
        .filter(
          (a) =>
            a.type === "Player" && replay.fight.friendlyPlayers.includes(a.id),
        )
        .sort(
          (a, b) =>
            a.class.localeCompare(b.class) || a.name.localeCompare(b.name),
        ) ?? [],
    [replay],
  );
  const targetOptions = useMemo(
    () =>
      replay?.actors.map((a) => (
        <option key={a.key} value={a.key}>
          {a.name}
          {a.instance > 1 ? ` #${a.instance}` : ""}
        </option>
      )),
    [replay?.actors, replay?.actors.length],
  );
  const abilityOptions = useMemo(
    () =>
      [...(replay?.abilities ?? [])]
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([id, a]) => (
          <option key={id} value={id === -4 ? 1 : id}>
            {a.name}
          </option>
        )),
    [replay?.abilities],
  );
  let bounds: [number, number] = range;
  if (config.window === "encounter")
    bounds = [summaryRange.start, summaryRange.displayEnd];
  if (config.window === "run") bounds = [0, replay?.duration ?? 1];
  if (config.window === "elapsed") bounds = [0, replay?.duration ?? 1];
  if (["10", "30", "60"].includes(config.window))
    bounds = [
      Math.max(0, clock - Number(config.window) * 1000),
      Math.max(Number(config.window) * 1000, clock),
    ];
  if (brush) bounds = brush;
  const selectedPlayers = config.scope === "players" ? config.players : [];
  const [start, end] = bounds;
  const duration = replay?.duration ?? 1;
  const source = analysisDataIdentity(replay);
  const neededRanges = useMemo<[number, number][]>(() => {
    if (!replay) return [];
    const summary =
      config.window === "elapsed" && !brush
        ? (summaryRange.intervals ?? [
            [summaryRange.start, summaryRange.end] as [number, number],
          ])
        : [[summaryRange.start, summaryRange.end] as [number, number]];
    return [
      ...(config.table ? summary : []),
      [start, end],
      [Math.max(0, clock - 5000), clock],
      ...(exportRequest?.source === source
        ? [[0, duration] as [number, number]]
        : []),
    ];
  }, [
    replay,
    config.window,
    config.table,
    brush,
    summaryRange,
    start,
    end,
    clock,
    exportRequest,
    source,
    duration,
  ]);
  useAnalysisData(state, controller, neededRanges);
  const result = useMemo(
    () =>
      index
        ? queryChart(index, {
            ...config,
            hostility,
            smoothing: 0,
            players: selectedPlayers,
            restrictPlayers: config.scope === "players",
            start: 0,
            end: duration,
            bucket:
              config.style === "bars"
                ? Math.max(
                    config.bucket,
                    Math.ceil(duration / 1200 / 100) * 100,
                  )
                : config.bucket,
          })
        : null,
    [index, config, duration],
  );
  const current = useMemo(
    () =>
      index
        ? queryChart(index, {
            ...config,
            hostility,
            smoothing: 0,
            players: selectedPlayers,
            restrictPlayers: config.scope === "players",
            start: Math.max(0, clock - 5000),
            end: Math.max(1, clock),
            cutoff: clock,
            group: "total",
            mode: "amount",
          })
        : null,
    [index, config, clock],
  );
  const prefixAvailable =
    !replay ||
    summaryRange.end < summaryRange.start ||
    analysisIntervalsAvailable(
      replay,
      summaryRange.start,
      summaryRange.end,
      config.window === "elapsed" && !brush ? combatIntervals : undefined,
    );
  const snapshot = useMemo(
    () =>
      index && config.table && prefixAvailable
        ? queryChartSummary(
            index,
            {
              ...config,
              hostility,
              smoothing: 0,
              players: selectedPlayers,
              restrictPlayers: config.scope === "players",
              start: summaryRange.start,
              end: Math.max(summaryRange.start, summaryRange.end),
              cutoff: summaryRange.end,
              intervals:
                config.window === "elapsed" && !brush
                  ? combatIntervals
                  : undefined,
              bucket: result?.step ?? config.bucket,
            },
            !["timeline", "10", "30", "60"].includes(config.window) || !!brush,
          )
        : null,
    [
      index,
      config,
      summaryRange,
      combatIntervals,
      result?.step,
      prefixAvailable,
    ],
  );
  const tableRows = useMemo(
    () =>
      [...(prefixAvailable ? (snapshot?.series ?? []) : [])]
        .sort((a, b) => b[config.rank] - a[config.rank])
        .slice(0, config.limit),
    [prefixAvailable, snapshot, config.rank, config.limit],
  );
  const tableBody = useRef<HTMLTableSectionElement>(null);
  const previousRanks = useRef(new Map<string, number>());
  const rankAnimations = useRef<Animation[]>([]);
  const rowOrder = tableRows.map((s) => s.key).join("|");
  useLayoutEffect(() => {
    rankAnimations.current.forEach((animation) => animation.cancel());
    rankAnimations.current = [];
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = animateChartRows(
      Array.from(tableBody.current?.rows ?? []),
      previousRanks.current,
      reduced,
    );
    previousRanks.current = motion.positions;
    rankAnimations.current = motion.animations;
  }, [rowOrder, config.table, storage]);
  useEffect(() => () => rankAnimations.current.forEach((a) => a.cancel()), []);
  const currentRate = perSecond(
      current?.total ?? 0,
      Math.min(5000, clock) / 1000,
    ),
    rows = [...(result?.series ?? [])]
      .sort((a, b) => b[config.rank] - a[config.rank])
      .slice(0, config.limit),
    focused = result?.series.find((s) => s.actor === actor?.key),
    plotRows = focused && !rows.includes(focused) ? [...rows, focused] : rows,
    shown = plotRows.filter((s) => !hidden.includes(s.key));
  const n = result?.times.length ?? 0,
    stacked = config.style !== "line",
    max = useMemo(() => {
      if (config.mode === "share") return 100;
      if (stacked) {
        let peak = 1;
        for (let i = 0; i < n; i++) {
          let sum = 0;
          for (const series of shown) sum += series.values[i];
          peak = Math.max(peak, sum);
        }
        return peak;
      }
      return shown.reduce(
        (m, s) => s.values.reduce((v, x) => Math.max(v, x), m),
        1,
      );
    }, [result, hidden, config.style, config.limit, config.rank, actor?.key]),
    span = Math.max(1, end - start),
    height = 180;
  const x = (i: number) =>
      ((result?.times[i] ?? 0) + (result?.step ?? 1000) / 2) / 1000,
    y = (v: number) => height - 10 - (v / max) * (height - 20);
  const plotted = useMemo(() => {
    const cumulative = Array(n).fill(0);
    const ordered =
      config.style === "line" && focused
        ? [
            ...shown.filter((s) => s !== focused),
            ...shown.filter((s) => s === focused),
          ]
        : shown;
    const loaded = (i: number) =>
      !replay ||
      analysisAvailable(
        replay,
        config.mode === "cumulative" ? 0 : (result?.times[i] ?? 0),
        Math.min(duration, (result?.times[i] ?? 0) + (result?.step ?? 1000)),
      );
    return ordered.map((s) => {
      const base = cumulative.slice();
      if (stacked) for (let i = 0; i < n; i++) cumulative[i] += s.values[i];
      if (config.style === "bars") {
        const barWidth = ((result?.step ?? 1000) / 1000) * 0.96;
        const d = s.values
          .map((v, i) => {
            if (!loaded(i)) return "";
            const left = (result?.times[i] ?? 0) / 1000,
              top = y(v + base[i]),
              bottom = y(base[i]);
            return `M${left},${top}h${barWidth}v${Math.max(0, bottom - top)}h${-barWidth}Z`;
          })
          .join("");
        return <path key={s.key} d={d} fill={s.color} opacity=".85" />;
      }
      const sections: number[][] = [];
      for (let i = 0; i < s.values.length; i++) {
        if (!loaded(i)) continue;
        const last = sections.at(-1);
        if (last?.at(-1) === i - 1) last.push(i);
        else sections.push([i]);
      }
      const isFocused = s.actor === actor?.key;
      const emphasized = Boolean(focused && !hidden.includes(focused.key));
      return (
        <g key={s.key}>
          {sections.map((indices, part) => (
            <path
              key={part}
              d={`${chartLinePath(
                indices.map((i) => [x(i), y(s.values[i] + base[i])]),
                config.smoothing > 0,
              )}${
                config.style === "area"
                  ? `L${indices
                      .slice()
                      .reverse()
                      .map((i) => `${x(i)},${y(base[i])}`)
                      .join("L")}Z`
                  : ""
              }`}
              fill={config.style === "area" ? s.color : "none"}
              fillOpacity=".6"
              stroke={s.color}
              data-series={s.key}
              data-focused={isFocused || undefined}
              opacity={emphasized && !isFocused ? 0.25 : 1}
              strokeWidth={isFocused ? 3.5 : 1.6}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
      );
    });
  }, [
    replay,
    result,
    hidden,
    config.style,
    config.limit,
    config.rank,
    config.smoothing,
    actor?.key,
  ]);
  const hoverIndex =
    hover && result
      ? Math.max(
          0,
          Math.min(
            n - 1,
            Math.floor(
              (start + (hover.x / 100) * span - result.start) / result.step,
            ),
          ),
        )
      : -1;
  const rowMax = Math.max(1, ...tableRows.map((s) => s.total));
  const filters = [
    config.target !== "*",
    config.spell !== "*",
    config.school !== "*",
    config.hits !== "all",
    config.periodic !== "all",
    config.area !== "all",
    config.hostility !== "all",
    !config.pets,
  ].filter(Boolean).length;
  const elapsed = summaryRange.seconds;
  const unit =
    config.mode === "rate" ? "/s" : config.mode === "share" ? "%" : "";
  const toggle = useCallback((key: string) => {
    setHidden((old) =>
      old.includes(key) ? old.filter((k) => k !== key) : [...old, key],
    );
  }, []);
  const tableContent = useMemo(
    () => (
      <tbody ref={tableBody}>
        {tableRows.map((s) => (
          <tr
            key={s.key}
            data-series={s.key}
            style={{ opacity: hidden.includes(s.key) ? 0.4 : 1 }}
          >
            <td>
              <span
                className="chart-row-bar"
                aria-hidden="true"
                style={{
                  width: `${(s.total / rowMax) * 100}%`,
                  background: `color-mix(in srgb, ${s.color} 25%, transparent)`,
                }}
              />
              <input
                aria-label={`Show ${s.name}`}
                type="checkbox"
                checked={!hidden.includes(s.key)}
                onChange={() => toggle(s.key)}
              />
              <button
                style={{ color: s.color }}
                onClick={() => {
                  if (s.spell) controller.inspectSpell(s.spell);
                  else if (s.actor) controller.select(s.actor);
                }}
              >
                {(s.icon || s.spell) && (
                  <GameIcon name={s.icon} spell={s.spell} />
                )}
                {s.name}
              </button>
            </td>
            <td>{Math.round(s.total).toLocaleString()}</td>
            <td>
              {((s.total / Math.max(1, snapshot?.total ?? 0)) * 100).toFixed(1)}
              %
            </td>
            <td>{formatRate(perSecond(s.total, elapsed))}</td>
            <td>{Math.round(s.peak).toLocaleString()}</td>
            <td>{s.count.toLocaleString()}</td>
            <td>{s.crits.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    ),
    [tableRows, hidden, rowMax, controller, toggle, elapsed, snapshot?.total],
  );
  function exportCsv() {
    setExportRequest((old) =>
      old
        ? null
        : { source, config: { ...config, players: [...config.players] } },
    );
  }
  useEffect(() => {
    if (!exportRequest) return;
    if (exportRequest.source !== source) {
      setExportRequest(null);
      return;
    }
    if (!replay || !index || !streamComplete(replay.raw)) return;
    const chosen = exportRequest.config;
    const complete = queryChart(index, {
      ...chosen,
      hostility:
        chosen.hostility === "default"
          ? defaultCombatSide(chosen.metric)
          : chosen.hostility,
      players: chosen.scope === "players" ? chosen.players : [],
      restrictPlayers: chosen.scope === "players",
      start: 0,
      end: duration,
      smoothing: 0,
    });
    const content = chartCsvContent(complete, duration / 1000);
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `pull-fiction-${chosen.metric}-full-run.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportRequest(null);
  }, [exportRequest, source, replay, index, duration]);
  return (
    <section
      className="chart-view"
      aria-label={`${chartMetrics[config.metric]} chart`}
    >
      <div className="chart-toolbar">
        <select
          aria-label="Chart metric"
          value={config.metric}
          onChange={(e) => set({ metric: e.target.value as ChartMetric })}
        >
          {Object.entries(chartMetrics).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="chart-current">
          {replay &&
          !analysisAvailable(replay, Math.max(0, clock - 5000), clock)
            ? "—"
            : formatRate(currentRate)}
          /s <small>5s</small>
        </span>
        <PanelSettings title="Chart settings">
          <div className="chart-control-grid">
            <label>
              Breakdown
              <select
                aria-label="Chart breakdown"
                value={config.group}
                onChange={(e) => set({ group: e.target.value as ChartGroup })}
              >
                {Object.entries({
                  player: "By player",
                  total: "Raid total",
                  class: "By class",
                  ability: "By ability",
                  target:
                    config.metric === "taken" ? "By attacker" : "By target",
                  school: "By school",
                }).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="chart-check">
              <input
                type="checkbox"
                checked={config.table}
                onChange={(e) => set({ table: e.target.checked })}
              />
              Show table
            </label>
            <label>
              Players
              <select
                aria-label="Chart player scope"
                value={config.scope}
                onChange={(e) =>
                  set({ scope: e.target.value as Config["scope"] })
                }
              >
                <option value="raid">All raid players</option>
                <option value="players">Choose players</option>
              </select>
            </label>
            {config.scope === "players" && (
              <div className="chart-players">
                <button
                  onClick={() => set({ players: players.map((a) => a.key) })}
                >
                  All
                </button>
                <button onClick={() => set({ players: [] })}>Clear</button>
                {players.map((a) => (
                  <label key={a.key}>
                    <input
                      type="checkbox"
                      checked={config.players.includes(a.key)}
                      onChange={(e) =>
                        set({
                          players: e.target.checked
                            ? [...config.players, a.key]
                            : config.players.filter((k) => k !== a.key),
                        })
                      }
                    />
                    <span
                      style={{
                        color: CLASS_COLORS[a.class],
                      }}
                    >
                      {a.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <label>
              Time
              <select
                aria-label="Chart time range"
                value={config.window}
                onChange={(e) => {
                  setBrush(null);
                  set({ window: e.target.value as Config["window"] });
                }}
              >
                <option value="timeline">Follow timeline</option>
                <option value="encounter">Current pull</option>
                <option value="run">Full run</option>
                <option value="elapsed">Overall combat</option>
                <option value="10">Last 10 seconds</option>
                <option value="30">Last 30 seconds</option>
                <option value="60">Last minute</option>
              </select>
            </label>
            <label>
              Display
              <select
                aria-label="Chart style"
                value={config.style}
                onChange={(e) =>
                  set({ style: e.target.value as Config["style"] })
                }
              >
                <option value="line">Lines</option>
                <option value="area">Stacked area</option>
                <option value="bars">Stacked bars</option>
              </select>
            </label>
            <label>
              Values
              <select
                aria-label="Chart values"
                value={config.mode}
                onChange={(e) => set({ mode: e.target.value as ChartMode })}
              >
                <option value="rate">Per second</option>
                <option value="amount">Amount per bucket</option>
                <option value="cumulative">Cumulative total</option>
                <option value="share">Share %</option>
              </select>
            </label>
            <label>
              Resolution
              <select
                aria-label="Chart resolution"
                value={config.bucket}
                onChange={(e) => set({ bucket: Number(e.target.value) })}
              >
                {[100, 250, 500, 1000, 2000, 5000, 10000].map((v) => (
                  <option key={v} value={v}>
                    {v / 1000}s
                  </option>
                ))}
              </select>
            </label>
            <label>
              Smoothing
              <select
                aria-label="Chart smoothing"
                value={config.smoothing > 0 ? 5000 : 0}
                onChange={(e) => set({ smoothing: Number(e.target.value) })}
              >
                <option value={5000}>Curved lines</option>
                <option value={0}>Straight lines</option>
              </select>
            </label>
            <label>
              {config.metric === "taken" ? "Attacker" : "Target"}
              <select
                aria-label="Chart target filter"
                value={config.target}
                onChange={(e) => set({ target: e.target.value })}
              >
                <option value="*">All</option>
                {targetOptions}
              </select>
            </label>
            <label>
              Target side
              <select
                aria-label="Chart target side"
                value={config.hostility}
                onChange={(e) =>
                  set({ hostility: e.target.value as Config["hostility"] })
                }
              >
                <option value="default">Metric default</option>
                <option value="all">All targets</option>
                <option value="enemies">Enemies</option>
                <option value="friendlies">Raid targets / friendly fire</option>
              </select>
            </label>
            <label>
              Ability
              <select
                aria-label="Chart ability filter"
                value={config.spell}
                onChange={(e) => set({ spell: e.target.value })}
              >
                <option value="*">All</option>
                {abilityOptions}
              </select>
            </label>
            <label>
              School
              <select
                aria-label="Chart school filter"
                value={config.school}
                onChange={(e) => set({ school: e.target.value })}
              >
                <option value="*">All</option>
                {Object.entries(schools).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Effects
              <select
                aria-label="Chart periodic filter"
                value={config.periodic}
                onChange={(e) =>
                  set({ periodic: e.target.value as Config["periodic"] })
                }
              >
                <option value="all">Direct + periodic</option>
                <option value="direct">Direct only</option>
                <option value="periodic">Periodic only</option>
              </select>
            </label>
            <label>
              Area
              <select
                aria-label="Chart area filter"
                value={config.area}
                onChange={(e) =>
                  set({ area: e.target.value as Config["area"] })
                }
              >
                <option value="all">All effects</option>
                <option value="aoe">AoE only</option>
                <option value="single">Single-target only</option>
              </select>
            </label>
            <label>
              Rank by
              <select
                aria-label="Chart ranking"
                value={config.rank}
                onChange={(e) =>
                  set({ rank: e.target.value as Config["rank"] })
                }
              >
                <option value="total">Total amount</option>
                <option value="peak">Peak rate</option>
                <option value="count">Event count</option>
              </select>
            </label>
            <label>
              Hits
              <select
                aria-label="Chart hit filter"
                value={config.hits}
                onChange={(e) =>
                  set({ hits: e.target.value as Config["hits"] })
                }
              >
                <option value="all">All outcomes</option>
                <option value="normal">Non-critical</option>
                <option value="critical">Critical hits</option>
              </select>
            </label>
            <label>
              Series
              <select
                aria-label="Chart series limit"
                value={config.limit}
                onChange={(e) => set({ limit: Number(e.target.value) })}
              >
                {[5, 10, 20, 40, 100].map((v) => (
                  <option key={v} value={v}>
                    Top {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="chart-check">
              <input
                type="checkbox"
                checked={config.pets}
                onChange={(e) => set({ pets: e.target.checked })}
              />
              Include pets
            </label>
            <label className="chart-check">
              <input
                type="checkbox"
                checked={config.mergePets}
                onChange={(e) => set({ mergePets: e.target.checked })}
              />
              Merge pets into owners
            </label>
            <label className="chart-check">
              <input
                type="checkbox"
                checked={config.markers}
                onChange={(e) => set({ markers: e.target.checked })}
              />
              Encounter / death markers
            </label>
            <button
              onClick={() => {
                setConfig(defaults(metric));
                setBrush(null);
                setHidden([]);
              }}
            >
              Reset
            </button>
            <button disabled={!replay} onClick={exportCsv}>
              {exportRequest?.source === source
                ? "Cancel CSV export"
                : "Export full-run CSV"}
            </button>
          </div>
        </PanelSettings>
      </div>
      <div className="chart-summary">
        <span>
          {preciseTime(start)} – {preciseTime(end)}
          {brush && <button onClick={() => setBrush(null)}>Clear range</button>}
        </span>
        <span>
          {Math.round(result?.total ?? 0).toLocaleString()}
          {replay?.raw.stream && !streamComplete(replay.raw)
            ? " downloaded total"
            : " run total"}{" "}
          · {result?.count.toLocaleString() ?? 0} events
          {filters > 0 ? ` · ${filters} filters` : ""}
        </span>
        {!!result?.missing && (
          <span className="chart-warning">
            {result.missing.toLocaleString()} events missing this field
          </span>
        )}
      </div>
      {replay?.raw.stream && !streamComplete(replay.raw) && (
        <div className="replay-data-notice">
          Blank sections are not downloaded. Totals cover downloaded events.
        </div>
      )}
      <div className="chart-plot">
        <div className="chart-axis">
          <span>
            {max.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            {unit}
          </span>
          <span>0</span>
        </div>
        <div className="chart-svg-host">
          <svg
            viewBox={`${start / 1000} 0 ${span / 1000} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${chartMetrics[config.metric]} by ${config.group}; click to seek, Shift-drag to zoom time range`}
            onPointerMove={(e) => {
              const b = e.currentTarget.getBoundingClientRect(),
                v = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
                t = start + v * span;
              setHover({
                index: Math.max(
                  0,
                  Math.min(
                    n - 1,
                    Math.floor(
                      (t - (result?.start ?? 0)) / (result?.step ?? 1000),
                    ),
                  ),
                ),
                x: v * 100,
              });
              if (dragStart.current !== null)
                setDragging([dragStart.current, t]);
            }}
            onPointerLeave={() => {
              if (dragStart.current === null) setHover(null);
            }}
            onPointerDown={(e) => {
              const b = e.currentTarget.getBoundingClientRect(),
                t =
                  start +
                  Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) *
                    span;
              if (e.shiftKey) {
                dragStart.current = t;
                setDragging([t, t]);
                e.currentTarget.setPointerCapture(e.pointerId);
              } else controller.seek(t);
            }}
            onPointerUp={(e) => {
              if (dragStart.current !== null && dragging) {
                const a = Math.min(...dragging),
                  b = Math.max(...dragging);
                if (b - a >= 100) {
                  setBrush([a, b]);
                  setHover(null);
                }
                dragStart.current = null;
                setDragging(null);
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }
            }}
            onPointerCancel={() => {
              dragStart.current = null;
              setDragging(null);
            }}
          >
            {config.markers &&
              replay?.chapters
                .filter(
                  (c) => c.encounterID && c.end >= start && c.start <= end,
                )
                .map((c) => (
                  <rect
                    key={`chapter-${c.id}`}
                    x={Math.max(start, c.start) / 1000}
                    y="0"
                    width={Math.max(
                      0,
                      (Math.min(c.end, end) - Math.max(c.start, start)) / 1000,
                    )}
                    height={height}
                    fill="#d0b26709"
                  >
                    <title>{c.name}</title>
                  </rect>
                ))}
            {config.markers &&
              players
                .filter(
                  (a) =>
                    !selectedPlayers.length || selectedPlayers.includes(a.key),
                )
                .flatMap((a) =>
                  a.deaths
                    .filter(([t, dead]) => dead && t >= start && t <= end)
                    .map(([t], i) => (
                      <line
                        vectorEffect="non-scaling-stroke"
                        key={`${a.key}-death-${i}`}
                        x1={t / 1000}
                        x2={t / 1000}
                        y1="0"
                        y2={height}
                        stroke="#e36c64"
                        strokeDasharray="3 4"
                        opacity=".7"
                      >
                        <title>
                          {a.name} died at {preciseTime(t)}
                        </title>
                      </line>
                    )),
                )}
            {[0.25, 0.5, 0.75].map((v) => (
              <line
                vectorEffect="non-scaling-stroke"
                key={v}
                x1={start / 1000}
                x2={end / 1000}
                y1={y(max * v)}
                y2={y(max * v)}
                stroke="#ffffff0d"
              />
            ))}
            {plotted}
            {clock >= start && clock <= end && (
              <line
                vectorEffect="non-scaling-stroke"
                x1={clock / 1000}
                x2={clock / 1000}
                y1="0"
                y2={height}
                stroke="#e5c67e"
              />
            )}
            {hover &&
              hoverIndex >= 0 &&
              (!replay ||
                analysisAvailable(
                  replay,
                  config.mode === "cumulative"
                    ? 0
                    : (result?.times[hoverIndex] ?? 0),
                  Math.min(
                    duration,
                    (result?.times[hoverIndex] ?? 0) + (result?.step ?? 1000),
                  ),
                )) && (
                <line
                  vectorEffect="non-scaling-stroke"
                  x1={x(hoverIndex)}
                  x2={x(hoverIndex)}
                  y1="0"
                  y2={height}
                  stroke="#fff"
                  opacity=".5"
                />
              )}
            {dragging && (
              <rect
                x={Math.min(...dragging) / 1000}
                width={Math.abs(dragging[1] - dragging[0]) / 1000}
                y="0"
                height={height}
                fill="#cfb26340"
                stroke="#cfb263"
              />
            )}
          </svg>
          {!result?.count && (
            <div className="chart-empty">
              {replay
                ? "No matching downloaded events in this range."
                : "Import a log to plot."}
            </div>
          )}
          {hover &&
            hoverIndex >= 0 &&
            (!replay ||
              analysisAvailable(
                replay,
                config.mode === "cumulative"
                  ? 0
                  : (result?.times[hoverIndex] ?? 0),
                Math.min(
                  duration,
                  (result?.times[hoverIndex] ?? 0) + (result?.step ?? 1000),
                ),
              )) && (
              <div
                className="chart-hover"
                style={{
                  left: hover.x > 50 ? "auto" : `${Math.min(hover.x + 2, 60)}%`,
                  right:
                    hover.x > 50
                      ? `${Math.max(0, 100 - hover.x + 2)}%`
                      : "auto",
                }}
              >
                <strong>{preciseTime(result?.times[hoverIndex] ?? 0)}</strong>
                {shown
                  .map((s) => ({ s, v: s.values[hoverIndex] ?? 0 }))
                  .sort((a, b) => b.v - a.v)
                  .slice(0, 10)
                  .map(({ s, v }) => (
                    <div key={s.key}>
                      <span style={{ color: s.color }}>{s.name}</span>
                      <b>
                        {v.toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })}
                        {unit}
                      </b>
                    </div>
                  ))}
              </div>
            )}
        </div>
      </div>
      <div className="chart-time-axis">
        <span>{time(start)}</span>
        <span>{time(start + span / 2)}</span>
        <span>{time(end)}</span>
      </div>
      {config.table ? (
        <div className="chart-table">
          <div
            className="chart-summary"
            aria-label="Table time basis"
            title={`${preciseTime(summaryRange.start)} – ${preciseTime(summaryRange.end)} · ${elapsed.toLocaleString(undefined, { maximumFractionDigits: 3 })}s${config.window === "elapsed" && !brush ? " combat time" : " elapsed"}`}
          >
            <span>
              {summaryRange.label}
              {summaryRange.between ? " · Finished" : ""}
            </span>
            <span>
              {elapsed.toLocaleString(undefined, { maximumFractionDigits: 3 })}s
              {config.window === "elapsed" && !brush ? " combat" : ""}
            </span>
          </div>
          {!prefixAvailable && (
            <p className="replay-data-notice">
              {state.bufferError
                ? "Could not load totals for this range."
                : "Loading totals for this range…"}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th>Total</th>
                <th>Share</th>
                <th>
                  {["heal", "overheal", "rawHeal"].includes(config.metric)
                    ? "HPS"
                    : config.metric === "taken"
                      ? "DTPS"
                      : "DPS"}
                </th>
                <th>Peak/s</th>
                <th>Events</th>
                <th>Crits</th>
              </tr>
            </thead>
            {tableContent}
          </table>
        </div>
      ) : (
        <div className="chart-legend">
          {rows.map((s) => (
            <button
              key={s.key}
              aria-pressed={!hidden.includes(s.key)}
              style={{
                color: s.color,
                opacity: hidden.includes(s.key) ? 0.4 : 1,
              }}
              onClick={() => toggle(s.key)}
            >
              ● {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="chart-footnote">
        <span>
          {rows.length} of {result?.series.length ?? 0} series ·{" "}
          {((result?.step ?? 1000) / 1000).toFixed(1)}s buckets
        </span>
        <span>Shift-drag to zoom a range</span>
      </div>
    </section>
  );
}
