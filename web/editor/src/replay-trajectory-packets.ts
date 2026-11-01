import { movementBetween } from "../../planner/replay-movement.mjs";
import {
  slowFallModes,
  levitateLaunches,
  type MovementModeActor,
} from "./replay-trajectory-modes";
import type {
  TrajectoryActorSource,
  TrajectoryComponent,
  TrajectorySample,
  TrajectorySourceIndex,
} from "./replay-trajectory-source";

export interface TrajectoryMovementSource
  extends
    TrajectoryActorSource,
    Pick<MovementModeActor, "initialAuras" | "auras"> {
  readonly movement?: {
    readonly profile: readonly (readonly [number, number, number])[];
    readonly blinks?: readonly (readonly [number])[];
  };
}
export interface TrajectoryIntervalProfile {
  readonly unrestricted?: boolean;
  readonly travel_budget: number;
  /** Fastest recorded rate in this interval; progress retains each rate change.
   * Rendered gait still uses the existing movement rate at the queried time. */
  readonly run_speed: number;
  readonly progress: readonly (readonly [number, number])[];
}
export interface TrajectoryComponentPacket {
  readonly source: string;
  readonly actor: string;
  readonly component: string;
  readonly content: string;
  readonly map: number;
  readonly samples: readonly TrajectorySample[];
  readonly initial_heights: readonly number[];
  readonly coverage_complete: boolean;
  readonly profiles: readonly TrajectoryIntervalProfile[];
  readonly slow_fall?: readonly (readonly [number, boolean])[];
  readonly hover_launches?: readonly number[];
  readonly unresolved_transfers?: readonly (readonly [number, boolean])[];
  readonly transfers?: readonly (readonly [number, number])[];
}
export interface TrajectoryPacketInput {
  readonly source: string;
  readonly map: number;
  readonly actor: TrajectoryMovementSource;
  readonly index: TrajectorySourceIndex;
  readonly component: TrajectoryComponent;
  /** Ranked and geometry-validated by the caller. No fallback is invented here. */
  readonly initialHeights: readonly number[];
  readonly transfers?: readonly (readonly [number, number])[];
  readonly unresolvedTransfers?: readonly number[];
  readonly coverageEnd?: number;
}

function sourceCovered(
  actor: TrajectoryActorSource,
  start: number,
  end: number,
): boolean {
  if (actor.bufferedRanges === undefined) return true;
  let through = start;
  for (const [a, b] of [...actor.bufferedRanges].sort((a, b) => a[0] - b[0])) {
    if (b < through) continue;
    if (a > through) return false;
    through = Math.max(through, b);
    if (through >= end) return true;
  }
  return through >= end;
}

// Bounded nonsecurity content identity. Two independent 32-bit lanes avoid retaining
// another full serialized component in the controller/native cache key.
function contentHash(value: unknown): string {
  const text = JSON.stringify(value);
  let a = 0x811c9dc5,
    b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `trajectory-v1-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** Build once when source evidence changes, independent of requested replay time. */
export function buildTrajectoryPacket(
  input: TrajectoryPacketInput,
): TrajectoryComponentPacket | null {
  const { source, map, actor, index, component } = input;
  if (!source || !Number.isInteger(map) || map < 0)
    throw new TypeError("Invalid trajectory packet source/map");
  if (index.actorKey !== actor.key || !index.components.includes(component))
    throw new TypeError(
      "Trajectory packet component does not belong to its actor/index",
    );
  let samples = index.observations
    .slice(component.firstSampleIndex, component.lastSampleIndex + 1)
    .map((observation) => observation.raw);
  const first = samples[0];
  if (!first)
    throw new TypeError("Trajectory packet component has no observations");
  let coverage_complete = component.missingCoverage.length === 0;
  if (!coverage_complete) {
    const hole = index.intervals.find(
      (interval) =>
        interval.fromIndex >= component.firstSampleIndex &&
        interval.toIndex <= component.lastSampleIndex &&
        interval.missingCoverage.length > 0,
    );
    let prefix = hole
      ? samples.slice(0, hole.fromIndex - component.firstSampleIndex + 1)
      : [];
    const truncatedTransfer = input.transfers?.find(
      ([start, end]) =>
        prefix.length && start < prefix.at(-1)![0] && end > prefix.at(-1)![0],
    );
    if (truncatedTransfer)
      prefix = prefix.filter((s) => s[0] <= truncatedTransfer[0]);
    // A complete first window and lookahead can be simulated independently of
    // unloaded future context. Keep the original chronological origin and tuples.
    if (prefix.length && prefix.at(-1)![0] >= first[0] + 10000) {
      samples = prefix;
      coverage_complete = true;
    }
  }
  const initial_heights: number[] = first[3] !== null ? [first[3]] : [];
  if (first[3] === null) {
    for (const height of input.initialHeights) {
      if (
        Number.isFinite(height) &&
        !initial_heights.some((retained) => Math.abs(retained - height) <= 0.05)
      )
        initial_heights.push(height);
      if (initial_heights.length === 3) break;
    }
  }
  if (!initial_heights.length) return null;

  const knots = actor.movement?.profile ?? [];
  let previous = -Infinity;
  for (const [time, weight, integral] of knots) {
    if (
      !Number.isFinite(time) ||
      time <= previous ||
      !Number.isFinite(weight) ||
      weight < 1 ||
      !Number.isFinite(integral)
    )
      throw new TypeError("Invalid trajectory movement profile");
    previous = time;
  }
  const profiles: TrajectoryIntervalProfile[] = [];
  // Pending components may contain unloaded spans and known Blink events.
  // They are coverage requests, never physical inputs until fully classified.
  let knotCursor = 0;
  for (let i = 1; coverage_complete && i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i];
    while (knotCursor < knots.length && knots[knotCursor][0] <= a[0])
      knotCursor++;
    const times = [a[0]];
    while (knotCursor < knots.length && knots[knotCursor][0] < b[0])
      times.push(knots[knotCursor++][0]);
    times.push(b[0]);
    let travel_budget = 0,
      run_speed = 0;
    const progress = times.map((time) => {
      const movement = movementBetween(actor, a, b, time);
      if (
        movement.blink ||
        typeof movement.travel_budget !== "number" ||
        !Number.isFinite(movement.travel_budget) ||
        !(movement.travel_budget > 0) ||
        typeof movement.fraction !== "number" ||
        !Number.isFinite(movement.fraction) ||
        typeof movement.run_speed !== "number" ||
        !Number.isFinite(movement.run_speed)
      )
        throw new TypeError(
          "Trajectory component contains incompatible movement timing",
        );
      travel_budget = movement.travel_budget;
      run_speed = Math.max(run_speed, movement.run_speed);
      return Object.freeze([time, movement.fraction] as const);
    });
    profiles.push(
      Object.freeze({
        ...(b[0] - a[0] > 2000 ? { unrestricted: true } : {}),
        travel_budget,
        run_speed,
        progress: Object.freeze(progress),
      }),
    );
  }
  const slow_fall = coverage_complete
    ? slowFallModes(actor, first[0], samples.at(-1)![0])
    : [];
  const transfers = coverage_complete
    ? (input.transfers ?? []).filter(
        ([start, end]) => start >= first[0] && end <= samples.at(-1)![0],
      )
    : [];
  const hover_launches = coverage_complete
    ? levitateLaunches(actor, first[0], samples.at(-1)![0])
    : [];
  const unresolved_transfers = coverage_complete
    ? (input.unresolvedTransfers ?? [])
        .filter((start) => start >= first[0] && start <= samples.at(-1)![0])
        .map((start) =>
          Object.freeze([
            start,
            sourceCovered(
              actor,
              start,
              Math.min(input.coverageEnd ?? Infinity, start + 6000),
            ),
          ] as const),
        )
    : [];
  const content = contentHash([
    map,
    samples,
    initial_heights,
    coverage_complete,
    coverage_complete ? [] : component.missingCoverage,
    profiles,
    slow_fall,
    transfers,
    hover_launches,
    unresolved_transfers,
  ]);
  return Object.freeze({
    source,
    actor: actor.key,
    component: component.id,
    content,
    map,
    samples: Object.freeze(samples),
    initial_heights: Object.freeze(initial_heights),
    coverage_complete,
    profiles: Object.freeze(profiles),
    ...(slow_fall.length
      ? {
          slow_fall: Object.freeze(
            slow_fall.map(([t, active]) => Object.freeze([t, active] as const)),
          ),
        }
      : {}),
    ...(hover_launches.length
      ? { hover_launches: Object.freeze([...hover_launches]) }
      : {}),
    ...(unresolved_transfers.length
      ? { unresolved_transfers: Object.freeze(unresolved_transfers) }
      : {}),
    ...(transfers.length
      ? {
          transfers: Object.freeze(
            transfers.map(([a, b]) => Object.freeze([a, b] as const)),
          ),
        }
      : {}),
  });
}
