import { CLASS_COLORS } from "./domain";
import type { Replay, Actor } from "./types";
import { defaultCombatSide, matchesCombatSide } from "./combat-metrics";
export const chartMetrics = {
  damage: "Damage done",
  taken: "Damage taken",
  heal: "Effective healing",
  overheal: "Overhealing",
  rawHeal: "Raw healing",
  unmitigated: "Unmitigated damage",
  absorbed: "Absorbed damage",
  overkill: "Overkill",
  blocked: "Blocked damage",
  resisted: "Resisted damage",
  mitigated: "Mitigated damage",
} as const;
export type ChartMetric = keyof typeof chartMetrics;
export type ChartGroup =
  "total" | "player" | "class" | "ability" | "target" | "school";
export type ChartMode = "rate" | "amount" | "cumulative" | "share";
export const schools: Record<number, string> = {
  1: "Physical",
  2: "Holy",
  4: "Fire",
  8: "Nature",
  16: "Frost",
  32: "Shadow",
  64: "Arcane",
};
const colors: Record<number, string> = {
  1: "#c8b28c",
  2: "#f2e8a1",
  4: "#ef8055",
  8: "#70be69",
  16: "#6ec6e0",
  32: "#b08bcd",
  64: "#c89cde",
};
export function schoolName(mask: number) {
  return (
    Object.entries(schools)
      .filter(([n]) => (mask & Number(n)) !== 0)
      .map(([, name]) => name)
      .join("/") || "Unknown"
  );
}
export function seriesColor(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 65%)`;
}
export interface ChartEvent {
  t: number;
  kind: "damage" | "heal";
  source: string;
  target: string;
  spell: number;
  school: number;
  name: string;
  icon?: string;
  amount: number;
  overheal: number;
  unmitigated?: number;
  absorbed: number;
  overkill: number;
  blocked: number;
  resisted: number;
  mitigated: number;
  critical: boolean;
  hitType: number;
  tick: boolean;
  aoe?: boolean;
}
export interface ChartIndex {
  events: ChartEvent[];
  actors: Map<string, Actor>;
  players: Set<number>;
}
const cache = new WeakMap<Replay, ChartIndex>();
export function chartIndex(replay: Replay): ChartIndex {
  let indexed = cache.get(replay);
  if (indexed) return indexed;
  const abilities = new Map(
    (
      replay.raw as unknown as {
        abilities?: { gameID: number; type?: string | number }[];
      }
    ).abilities?.map((a) => [a.gameID, Number(a.type) || 0]) ?? [],
  );
  const finite = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const events = (replay.raw.events as Record<string, any>[])
    .filter((e) => e.type === "damage" || e.type === "heal")
    .map((e) => {
      const rawSpell = e.abilityGameID ?? e.ability?.guid ?? 0,
        spell = rawSpell === -4 ? 1 : rawSpell,
        ability = replay.abilities.get(rawSpell) ?? replay.abilities.get(spell);
      return {
        t: e.timestamp - replay.fight.startTime,
        kind: e.type,
        source: `${e.sourceID}:${e.sourceInstance || 1}`,
        target: `${e.targetID}:${e.targetInstance || 1}`,
        spell,
        school: abilities.get(rawSpell) ?? Number(e.ability?.type ?? 0),
        name: ability?.name ?? (spell === 1 ? "Melee" : `Spell ${spell}`),
        icon: ability?.icon,
        amount: Math.max(0, finite(e.amount)),
        overheal: Math.max(0, finite(e.overheal)),
        unmitigated:
          typeof e.unmitigatedAmount === "number" &&
          Number.isFinite(e.unmitigatedAmount)
            ? Math.max(0, e.unmitigatedAmount)
            : undefined,
        absorbed: Math.max(0, finite(e.absorbed)),
        overkill: Math.max(0, finite(e.overkill)),
        blocked: Math.max(0, finite(e.blocked)),
        resisted: Math.max(0, finite(e.resisted)),
        mitigated: Math.max(0, finite(e.mitigated)),
        // Classic WCL combined critical outcomes, checked against its isCritical filter.
        critical: [2, 5, 17].includes(e.hitType),
        hitType: finite(e.hitType),
        tick: !!e.tick,
        aoe: typeof e.isAoE === "boolean" ? e.isAoE : undefined,
      } as ChartEvent;
    })
    .filter((e) => e.t >= 0 && e.t <= replay.duration)
    .sort((a, b) => a.t - b.t);
  indexed = {
    events,
    actors: new Map(replay.actors.map((a) => [a.key, a])),
    players: new Set(replay.fight.friendlyPlayers),
  };
  cache.set(replay, indexed);
  return indexed;
}
export interface ChartQuery {
  metric: ChartMetric;
  group: ChartGroup;
  start: number;
  end: number;
  players: string[];
  pets: boolean;
  mergePets: boolean;
  target: string;
  spell: string;
  school: string;
  periodic: "all" | "direct" | "periodic";
  hits: "all" | "normal" | "critical";
  bucket: number;
  smoothing: number;
  mode: ChartMode;
  cutoff?: number;
  restrictPlayers?: boolean;
  area?: "all" | "aoe" | "single";
  hostility?: "all" | "enemies" | "friendlies";
  intervals?: [number, number][];
}
export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  actor?: string;
  spell?: number;
  icon?: string;
  values: number[];
  amounts: number[];
  total: number;
  count: number;
  crits: number;
  overheal: number;
  peak: number;
}
export interface ChartResult {
  series: ChartSeries[];
  total: number;
  count: number;
  missing: number;
  step: number;
  times: number[];
  start: number;
  end: number;
}
function lower(events: ChartEvent[], time: number, upper = false) {
  let l = 0,
    r = events.length;
  while (l < r) {
    const m = (l + r) >>> 1;
    if (events[m].t < time || (upper && events[m].t === time)) l = m + 1;
    else r = m;
  }
  return l;
}
function value(e: ChartEvent, m: ChartMetric): number | undefined {
  switch (m) {
    case "overheal":
      return e.overheal;
    case "rawHeal":
      return e.amount + e.overheal;
    case "unmitigated":
      return e.unmitigated;
    case "absorbed":
      return e.absorbed;
    case "overkill":
      return e.overkill;
    case "blocked":
      return e.blocked;
    case "resisted":
      return e.resisted;
    case "mitigated":
      return e.mitigated;
    default:
      return e.amount;
  }
}
type ChartSeriesInfo = Pick<
  ChartSeries,
  "key" | "name" | "color" | "actor" | "spell" | "icon"
>;
const ownerIndexes = new WeakMap<ChartIndex, Map<number, Actor>>();
function firstActorsById(index: ChartIndex) {
  let owners = ownerIndexes.get(index);
  if (!owners) {
    owners = new Map();
    for (const actor of index.actors.values())
      if (!owners.has(actor.id)) owners.set(actor.id, actor);
    ownerIndexes.set(index, owners);
  }
  return owners;
}
function visitChartEvents<T>(
  index: ChartIndex,
  q: ChartQuery,
  from: number,
  to: number,
  create: (info: ChartSeriesInfo) => T,
  visit: (event: ChartEvent, amount: number, group: T) => void,
  onMissing?: (event: ChartEvent) => void,
) {
  const selected = new Set(q.players),
    owners = firstActorsById(index),
    groups = new Map<string, T>();
  let total = 0,
    count = 0,
    missing = 0;
  const healing = ["heal", "overheal", "rawHeal"].includes(q.metric),
    taken = q.metric === "taken";
  for (let i = from; i < to; i++) {
    const e = index.events[i];
    if (q.intervals && !q.intervals.some(([a, b]) => e.t >= a && e.t <= b))
      continue;
    if (e.kind !== (healing ? "heal" : "damage")) continue;
    const subjectKey = taken ? e.target : e.source,
      subject = index.actors.get(subjectKey),
      owner = subject?.owner ? owners.get(subject.owner) : undefined;
    if (
      !subject ||
      !(
        index.players.has(subject.id) ||
        (q.pets && owner && index.players.has(owner.id))
      )
    )
      continue;
    if (
      selected.size &&
      !selected.has(subjectKey) &&
      !(q.pets && owner && selected.has(owner.key))
    )
      continue;
    if (q.restrictPlayers && !selected.size) continue;
    const counterpart = taken ? e.source : e.target;
    if (
      !matchesCombatSide(
        index.actors.get(counterpart),
        index.players,
        q.hostility ?? defaultCombatSide(q.metric),
      )
    )
      continue;
    if (
      (q.target !== "*" && q.target !== counterpart) ||
      (q.spell !== "*" && Number(q.spell) !== e.spell) ||
      (q.school !== "*" && !(e.school & Number(q.school))) ||
      (q.periodic === "direct" && e.tick) ||
      (q.periodic === "periodic" && !e.tick) ||
      (q.hits === "normal" && e.critical) ||
      (q.hits === "critical" && !e.critical)
    )
      continue;
    if (
      (q.area === "aoe" && e.aoe !== true) ||
      (q.area === "single" && e.aoe !== false)
    )
      continue;
    const amount = value(e, q.metric);
    if (amount === undefined) {
      missing++;
      onMissing?.(e);
      continue;
    }
    count++;
    total += amount;
    const player = q.mergePets && owner ? owner : subject;
    const groupKey =
      q.group === "player"
        ? player.key
        : q.group === "class"
          ? (player.class ?? player.type)
          : q.group === "ability"
            ? String(e.spell)
            : q.group === "target"
              ? counterpart
              : q.group === "school"
                ? String(e.school)
                : "total";
    let group = groups.get(groupKey);
    if (!group) {
      let key = "total",
        name = "Total",
        color = "#d4b56f",
        actor: string | undefined,
        spell: number | undefined,
        icon: string | undefined;
      if (q.group === "player") {
        key = player.key;
        name =
          player.name + (player.instance > 1 ? ` #${player.instance}` : "");
        actor = player.key;
        color =
          CLASS_COLORS[player.class] ??
          CLASS_COLORS[owner?.class ?? ""] ??
          "#aab3b9";
      }
      if (q.group === "class") {
        key = player.class ?? player.type;
        name = key;
        color = CLASS_COLORS[key] ?? "#aab3b9";
      }
      if (q.group === "ability") {
        key = String(e.spell);
        name = e.name;
        spell = e.spell;
        icon = e.icon;
        color = seriesColor(key);
      }
      if (q.group === "target") {
        key = counterpart;
        const a = index.actors.get(key);
        name = a
          ? `${a.name}${a.instance > 1 ? ` #${a.instance}` : ""}`
          : "Unknown";
        actor = a?.key;
        color = CLASS_COLORS[a?.class ?? ""] ?? seriesColor(key);
      }
      if (q.group === "school") {
        key = String(e.school);
        name = schoolName(e.school);
        color = colors[e.school] ?? seriesColor(key);
      }
      group = create({ key, name, color, actor, spell, icon });
      groups.set(key, group);
    }
    visit(e, amount, group);
  }
  return { total, count, missing, groups: [...groups.values()] };
}
function chartBounds(q: ChartQuery) {
  const start = Math.max(0, q.start),
    end = Math.max(start + 1, q.end),
    step = Math.max(100, q.bucket, Math.ceil((end - start) / 36000 / 50) * 50);
  return { start, end, step, n: Math.max(1, Math.ceil((end - start) / step)) };
}
export function queryChart(index: ChartIndex, q: ChartQuery): ChartResult {
  const { start, end, step, n } = chartBounds(q),
    times = Array.from({ length: n }, (_, i) => start + i * step);
  const { total, count, missing, groups } = visitChartEvents<ChartSeries>(
    index,
    q,
    lower(index.events, start),
    lower(index.events, Math.min(end, q.cutoff ?? end), true),
    (info) => ({
      ...info,
      values: [],
      amounts: Array(n).fill(0),
      total: 0,
      count: 0,
      crits: 0,
      overheal: 0,
      peak: 0,
    }),
    (e, amount, series) => {
      series.total += amount;
      series.count++;
      series.crits += e.critical ? 1 : 0;
      series.overheal += e.overheal;
      series.amounts[
        Math.min(n - 1, Math.max(0, Math.floor((e.t - start) / step)))
      ] += amount;
    },
  );
  const series = groups.sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  const window = Math.max(1, Math.ceil(q.smoothing / step));
  for (const s of series) {
    let running = 0,
      sum = 0;
    s.values = s.amounts.map((v, i) => {
      running += v;
      sum += v;
      if (i >= window) sum -= s.amounts[i - window];
      return q.mode === "cumulative"
        ? running
        : q.mode === "amount"
          ? v
          : q.mode === "share"
            ? v
            : sum / Math.min(window, i + 1) / (step / 1000);
    });
    s.peak = Math.max(0, ...s.amounts.map((v) => v / (step / 1000)));
  }
  if (q.mode === "share")
    for (let i = 0; i < n; i++) {
      const sum = series.reduce((a, s) => a + s.amounts[i], 0);
      for (const s of series)
        s.values[i] = sum ? (s.amounts[i] / sum) * 100 : 0;
    }
  return { series, total, count, missing, step, times, start, end };
}
export type ChartSummarySeries = Omit<ChartSeries, "values" | "amounts">;
export interface ChartSummary {
  series: ChartSummarySeries[];
  total: number;
  count: number;
  missing: number;
  step: number;
  start: number;
  end: number;
}
interface SummaryHistory {
  info: ChartSeriesInfo;
  times: number[];
  totals: number[];
  crits: number[];
  overheal: number[];
  peaks: number[];
  boundaryPeaks: number[];
  bucket: number;
  bucketAmount: number;
  peakBeforeBucket: number;
  boundaryAmount: number;
  boundaryOlderPeak: number;
}
interface SummaryIndex {
  series: SummaryHistory[];
  times: number[];
  totals: number[];
  missingTimes: number[];
}
const summaryIndexes = new WeakMap<ChartIndex, Map<string, SummaryIndex>>();
const SUMMARY_CACHE_LIMIT = 3;
function afterTime(times: number[], time: number) {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function summaryKey(q: ChartQuery, start: number, step: number) {
  return JSON.stringify([
    start,
    step,
    q.metric,
    q.group,
    [...new Set(q.players)].sort(),
    q.pets,
    q.mergePets,
    q.target,
    q.spell,
    q.school,
    q.periodic,
    q.hits,
    !!q.restrictPlayers,
    q.area ?? "all",
    q.hostility ?? defaultCombatSide(q.metric),
    q.intervals,
  ]);
}
function buildSummary(
  index: ChartIndex,
  q: ChartQuery,
  start: number,
  step: number,
  stop = Infinity,
): SummaryIndex {
  const times: number[] = [],
    totals: number[] = [],
    missingTimes: number[] = [],
    seconds = step / 1000;
  let total = 0;
  const { groups } = visitChartEvents<SummaryHistory>(
    index,
    q,
    lower(index.events, start),
    Number.isFinite(stop)
      ? lower(index.events, stop, true)
      : index.events.length,
    (info) => ({
      info,
      times: [],
      totals: [],
      crits: [],
      overheal: [],
      peaks: [],
      boundaryPeaks: [],
      bucket: -1,
      bucketAmount: 0,
      peakBeforeBucket: 0,
      boundaryAmount: 0,
      boundaryOlderPeak: 0,
    }),
    (event, amount, history) => {
      total += amount;
      times.push(event.t);
      totals.push(total);
      const ratio = (event.t - start) / step,
        bucket = Math.floor(ratio);
      if (history.bucket !== bucket) {
        const finishedPeak = Math.max(
          history.peakBeforeBucket,
          history.bucketAmount / seconds,
        );
        // At an exact query end, the full chart appends boundary events to the
        // preceding bin. Retain that bin's sum, then add each event in order.
        // Summing a separate endpoint prefix and adding it later changes floats.
        const adjacent = history.bucket === bucket - 1;
        history.boundaryAmount = adjacent ? history.bucketAmount : 0;
        history.boundaryOlderPeak = adjacent
          ? history.peakBeforeBucket
          : finishedPeak;
        history.peakBeforeBucket = finishedPeak;
        history.bucket = bucket;
        history.bucketAmount = 0;
      }
      history.bucketAmount += amount;
      if (ratio === bucket) history.boundaryAmount += amount;
      const last = history.times.length - 1;
      history.times.push(event.t);
      history.totals.push((history.totals[last] ?? 0) + amount);
      history.crits.push((history.crits[last] ?? 0) + (event.critical ? 1 : 0));
      history.overheal.push((history.overheal[last] ?? 0) + event.overheal);
      history.peaks.push(
        Math.max(history.peakBeforeBucket, history.bucketAmount / seconds),
      );
      history.boundaryPeaks.push(
        Math.max(history.boundaryOlderPeak, history.boundaryAmount / seconds),
      );
    },
    (event) => missingTimes.push(event.t),
  );
  return { series: groups, times, totals, missingTimes };
}
/** Exact scalar prefix results for elapsed tables, without graph bucket arrays. */
export function queryChartSummary(
  index: ChartIndex,
  q: ChartQuery,
  cacheSummary = true,
): ChartSummary {
  const { start, end, step, n } = chartBounds(q),
    key = summaryKey(q, start, step);
  let cached = summaryIndexes.get(index);
  if (!cached) summaryIndexes.set(index, (cached = new Map()));
  let summary = cacheSummary ? cached.get(key) : undefined;
  if (!summary)
    summary = buildSummary(
      index,
      q,
      start,
      step,
      cacheSummary ? Infinity : Math.min(end, q.cutoff ?? end),
    );
  // A small per-immutable-index LRU bounds memory when filters or bins change.
  if (cacheSummary) {
    cached.delete(key);
    cached.set(key, summary);
  }
  if (cached.size > SUMMARY_CACHE_LIMIT)
    cached.delete(cached.keys().next().value!);
  const stop = Math.min(end, q.cutoff ?? end),
    count = afterTime(summary.times, stop),
    series: ChartSummarySeries[] = [];
  for (const history of summary.series) {
    const last = afterTime(history.times, stop) - 1;
    if (last < 0) continue;
    const clamped = Math.floor((history.times[last] - start) / step) >= n;
    series.push({
      ...history.info,
      total: history.totals[last],
      count: last + 1,
      crits: history.crits[last],
      overheal: history.overheal[last],
      peak: clamped ? history.boundaryPeaks[last] : history.peaks[last],
    });
  }
  series.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    series,
    total: summary.totals[count - 1] ?? 0,
    count,
    missing: afterTime(summary.missingTimes, stop),
    step,
    start,
    end,
  };
}
export const defaultChartQuery: Omit<ChartQuery, "start" | "end"> = {
  metric: "damage",
  group: "player",
  players: [],
  pets: true,
  mergePets: true,
  target: "*",
  spell: "*",
  school: "*",
  periodic: "all",
  hits: "all",
  bucket: 1000,
  smoothing: 3000,
  mode: "rate",
};

/** Shape-preserving cubic interpolation. Samples and their values stay unchanged. */
export function chartLinePath(
  points: [number, number][],
  smooth: boolean,
): string {
  if (!points.length) return "";
  const first = `M${points[0][0]},${points[0][1]}`;
  if (!smooth || points.length < 3)
    return (
      first +
      points
        .slice(1)
        .map(([x, y]) => `L${x},${y}`)
        .join("")
    );
  const slopes = points
    .slice(1)
    .map(([x, y], i) => (y - points[i][1]) / (x - points[i][0]));
  const tangents = points.map((_, i) => {
    if (!i) return slopes[0];
    if (i === points.length - 1) return slopes[i - 1];
    const a = slopes[i - 1],
      b = slopes[i];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  return (
    first +
    points
      .slice(1)
      .map(([x, y], i) => {
        const [px, py] = points[i],
          dx = (x - px) / 3;
        return `C${px + dx},${py + dx * tangents[i]} ${x - dx},${y - dx * tangents[i + 1]} ${x},${y}`;
      })
      .join("")
  );
}
