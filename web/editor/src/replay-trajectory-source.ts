/** Immutable chronological source evidence. This module never derives a position. */
export type TrajectorySample = readonly [number, number, number, number | null];
export interface TrajectoryActorSource {
  readonly key: string;
  readonly samples: readonly TrajectorySample[];
  readonly deaths?: readonly (readonly [number, boolean])[];
  readonly casts?: readonly {
    readonly spell: number;
    readonly end: number;
    readonly outcome?: string;
    readonly timingSource?: string;
  }[];
  readonly positionBreaks?: readonly number[];
  readonly bufferedRanges?: readonly (readonly [number, number])[];
}
export type TrajectoryBoundaryKind =
  "gap" | "speed" | "blink" | "life" | "zone";
export interface TrajectoryBoundary {
  readonly kind: TrajectoryBoundaryKind;
  readonly time: number;
  readonly fromIndex: number;
  readonly toIndex: number;
  /** Index in the corresponding source event array, absent for inferred gap/speed. */
  readonly eventIndex?: number;
  readonly dead?: boolean;
}
export interface TrajectoryObservation {
  readonly index: number;
  readonly raw: TrajectorySample;
  readonly zSource: "recorded" | "missing";
  readonly componentId: string;
}
export type TrajectoryRange = readonly [number, number];
export interface TrajectoryInterval {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromComponentId: string;
  readonly toComponentId: string;
  readonly sparse: boolean;
  readonly boundaries: readonly TrajectoryBoundary[];
  readonly missingCoverage: readonly TrajectoryRange[];
}
export interface TrajectoryComponent {
  readonly id: string;
  readonly firstSampleIndex: number;
  readonly lastSampleIndex: number;
  readonly firstTime: number;
  readonly lastTime: number;
  readonly missingCoverage: readonly TrajectoryRange[];
}
export interface TrajectorySourceIndex {
  readonly actorKey: string;
  readonly observations: readonly TrajectoryObservation[];
  readonly components: readonly TrajectoryComponent[];
  readonly intervals: readonly TrajectoryInterval[];
}

function invalid(message: string): never {
  throw new TypeError(`Invalid trajectory source: ${message}`);
}
function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(label);
}
function chronological(time: number, previous: number, label: string) {
  finite(time, label);
  if (time < previous) invalid(`${label} is out of order`);
}
function missingCoverage(
  start: number,
  end: number,
  ranges: TrajectoryActorSource["bufferedRanges"],
): readonly TrajectoryRange[] {
  if (ranges === undefined) return Object.freeze([]);
  const missing: TrajectoryRange[] = [];
  let cursor = start;
  let coveredPoint = false;
  for (const [left, right] of ranges) {
    if (right < cursor) continue;
    if (left > end) break;
    if (left > cursor)
      missing.push(Object.freeze([cursor, Math.min(left, end)]));
    if (left <= start && right >= start) coveredPoint = true;
    cursor = Math.max(cursor, right);
    if (cursor >= end) break;
  }
  if (cursor < end || (start === end && !coveredPoint))
    missing.push(Object.freeze([cursor, end]));
  return Object.freeze(missing);
}

/** IDs use actor identity and the first real observation, never a requested seek. */
export function buildTrajectorySource(
  actor: TrajectoryActorSource,
): TrajectorySourceIndex {
  if (typeof actor.key !== "string" || !actor.key)
    invalid("actor key is empty");
  let previous = -Infinity;
  for (const [i, sample] of actor.samples.entries()) {
    if (!Array.isArray(sample) || sample.length !== 4)
      invalid(`sample ${i} tuple`);
    finite(sample[0], `sample ${i} time`);
    if (sample[0] <= previous)
      invalid(`sample ${i} must be strictly chronological`);
    finite(sample[1], `sample ${i} X`);
    finite(sample[2], `sample ${i} Y`);
    if (sample[3] !== null) finite(sample[3], `sample ${i} Z`);
    previous = sample[0];
  }
  const events: {
    kind: "blink" | "life" | "zone";
    time: number;
    eventIndex: number;
    dead?: boolean;
  }[] = [];
  previous = -Infinity;
  let wasDead = false;
  for (const [eventIndex, [time, dead]] of (actor.deaths ?? []).entries()) {
    chronological(time, previous, `life event ${eventIndex}`);
    if (typeof dead !== "boolean") invalid(`life event ${eventIndex} state`);
    previous = time;
    if (dead !== wasDead) events.push({ kind: "life", time, eventIndex, dead });
    wasDead = dead;
  }
  previous = -Infinity;
  for (const [eventIndex, time] of (actor.positionBreaks ?? []).entries()) {
    chronological(time, previous, `zone event ${eventIndex}`);
    previous = time;
    events.push({ kind: "zone", time, eventIndex });
  }
  for (const [eventIndex, cast] of (actor.casts ?? []).entries()) {
    if (
      cast.spell === 1953 &&
      cast.outcome === "completed" &&
      cast.timingSource === "recorded"
    ) {
      finite(cast.end, `Blink event ${eventIndex} time`);
      events.push({ kind: "blink", time: cast.end, eventIndex });
    }
  }
  // Casts are ordered by start, not necessarily completion. Sort independent events only.
  events.sort((a, b) => a.time - b.time);
  previous = -Infinity;
  for (const [i, range] of (actor.bufferedRanges ?? []).entries()) {
    if (!Array.isArray(range) || range.length !== 2)
      invalid(`coverage ${i} tuple`);
    chronological(range[0], previous, `coverage ${i} start`);
    finite(range[1], `coverage ${i} end`);
    if (range[1] < range[0]) invalid(`coverage ${i} reversed`);
    previous = range[0];
  }
  const observations: TrajectoryObservation[] = [];
  const intervals: TrajectoryInterval[] = [];
  const components: TrajectoryComponent[] = [];
  let firstIndex = 0;
  let componentId = "";
  let eventCursor = 0;
  const idAt = (i: number) => JSON.stringify([actor.key, actor.samples[i][0]]);
  const finish = (lastIndex: number) => {
    const firstTime = actor.samples[firstIndex][0],
      lastTime = actor.samples[lastIndex][0];
    components.push(
      Object.freeze({
        id: componentId,
        firstSampleIndex: firstIndex,
        lastSampleIndex: lastIndex,
        firstTime,
        lastTime,
        missingCoverage: missingCoverage(
          firstTime,
          lastTime,
          actor.bufferedRanges,
        ),
      }),
    );
  };
  for (const [i, raw] of actor.samples.entries()) {
    if (i === 0) componentId = idAt(i);
    else {
      const a = actor.samples[i - 1],
        gap = raw[0] - a[0];
      const distance = Math.hypot(raw[1] - a[1], raw[2] - a[2]);
      const uncovered = missingCoverage(a[0], raw[0], actor.bufferedRanges);
      const boundaries: TrajectoryBoundary[] = [];
      const boundary = (kind: "gap" | "speed") =>
        boundaries.push({ kind, time: raw[0], fromIndex: i - 1, toIndex: i });
      // An unloaded interval can hide observations. It cannot establish a new
      // physical origin, even when the retained endpoints appear discontinuous.
      if (!uncovered.length && gap > 2000) boundary("gap");
      if (!uncovered.length && distance / (gap / 1000) > 35) boundary("speed");
      while (
        eventCursor < events.length &&
        events[eventCursor].time <= raw[0]
      ) {
        const event = events[eventCursor++];
        if (event.time > a[0])
          boundaries.push({ ...event, fromIndex: i - 1, toIndex: i });
      }
      boundaries.sort((left, right) => left.time - right.time);
      const fromComponentId = componentId;
      // Sparse is a presentation classification, not permission to restart
      // physics on another floor. Keep bounded short gaps in the same history.
      const physicalBoundary =
        boundaries.some((b) => b.kind !== "gap") ||
        gap > 5000 ||
        (gap > 2000 && distance > 40);
      if (physicalBoundary && !uncovered.length) {
        finish(i - 1);
        firstIndex = i;
        componentId = idAt(i);
      }
      intervals.push(
        Object.freeze({
          fromIndex: i - 1,
          toIndex: i,
          fromComponentId,
          toComponentId: componentId,
          sparse: !uncovered.length && gap > 2000,
          boundaries: Object.freeze(boundaries.map((b) => Object.freeze(b))),
          missingCoverage: uncovered,
        }),
      );
    }
    observations.push(
      Object.freeze({
        index: i,
        raw,
        zSource: raw[3] === null ? "missing" : "recorded",
        componentId,
      }),
    );
  }
  if (actor.samples.length) finish(actor.samples.length - 1);
  return Object.freeze({
    actorKey: actor.key,
    observations: Object.freeze(observations),
    intervals: Object.freeze(intervals),
    components: Object.freeze(components),
  });
}

export interface TrajectorySourceLookup {
  readonly observation: TrajectoryObservation;
  /** Adjacent source interval only, absent outside the observed time range. */
  readonly interval: TrajectoryInterval | null;
}
/** Stateless lookup, including exact observations, is independent of seek order. */
export function lookupTrajectorySource(
  index: TrajectorySourceIndex,
  time: number,
): TrajectorySourceLookup | null {
  finite(time, "lookup time");
  const observations = index.observations;
  if (!observations.length) return null;
  let lo = 0,
    hi = observations.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (observations[mid].raw[0] <= time) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  return {
    observation: observations[i],
    interval: lo > 0 && lo < observations.length ? index.intervals[i] : null,
  };
}
