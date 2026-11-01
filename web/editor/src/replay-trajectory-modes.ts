/** Known movement effects with recorded timing and evidence-derived target selection. */
export interface MovementModeActor {
  readonly key: string;
  readonly type?: string;
  readonly samples: readonly (readonly [
    number,
    number,
    number,
    number | null,
  ])[];
  readonly initialAuras?: readonly number[];
  readonly auras?: readonly (readonly [
    number,
    {
      readonly spell?: number;
      readonly remove?: boolean;
      readonly reset?: readonly number[];
    },
  ])[];
  readonly deaths?: readonly (readonly [number, boolean])[];
  readonly casts?: readonly {
    readonly spell: number;
    readonly end: number;
    readonly outcome?: string;
    readonly timingSource?: string;
    readonly target?: string | null;
  }[];
}

type ModeKnot = readonly [number, boolean];
type Transfer = readonly [number, number];
export interface TransferEvidence {
  readonly complete: readonly Transfer[];
  readonly unresolved: readonly number[];
}
type CombatEvidence = {
  readonly t: number;
  readonly kind: string;
  readonly source?: string | null;
  readonly target?: string | null;
  readonly spell?: number;
  readonly melee?: boolean;
};
const slowFallSpells = new Set([1706, 130]);

/** Include the state at start and exact subsequent changes, only for active ranges. */
export function slowFallModes(
  actor: MovementModeActor,
  start: number,
  end: number,
): readonly ModeKnot[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const active = new Set(
    actor.initialAuras?.filter((id) => slowFallSpells.has(id)),
  );
  const events = [
    ...(actor.auras ?? []).map(([t, aura]) => ({ t, aura, death: false })),
    ...(actor.deaths ?? [])
      .filter(([, dead]) => dead)
      .map(([t]) => ({ t, aura: undefined, death: true })),
  ]
    .filter(({ t }) => Number.isFinite(t) && t <= end)
    .sort((a, b) => a.t - b.t || Number(a.death) - Number(b.death));
  const knots: ModeKnot[] = [];
  let cursor = 0;
  const apply = (event: (typeof events)[number]) => {
    if (event.death) active.clear();
    else if (event.aura?.reset !== undefined) {
      active.clear();
      for (const id of event.aura.reset)
        if (slowFallSpells.has(id)) active.add(id);
    } else if (
      event.aura?.spell !== undefined &&
      slowFallSpells.has(event.aura.spell)
    ) {
      if (event.aura.remove) active.delete(event.aura.spell);
      else active.add(event.aura.spell);
    }
  };
  while (cursor < events.length && events[cursor].t <= start)
    apply(events[cursor++]);
  knots.push([start, active.size > 0]);
  while (cursor < events.length) {
    const time = events[cursor].t;
    while (cursor < events.length && events[cursor].t === time)
      apply(events[cursor++]);
    const state = active.size > 0;
    if (knots[knots.length - 1][1] !== state) knots.push([time, state]);
  }
  return knots.some(([, enabled]) => enabled) ? knots : [];
}

/** Actual inactive-to-active Levitate grants owe one grounded jump. */
export function levitateLaunches(
  actor: MovementModeActor,
  start: number,
  end: number,
): readonly number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  let active = actor.initialAuras?.includes(1706) ?? false;
  const events = [
    ...(actor.auras ?? []).map(([t, aura]) => ({ t, aura, death: false })),
    ...(actor.deaths ?? [])
      .filter(([, dead]) => dead)
      .map(([t]) => ({ t, aura: undefined, death: true })),
  ]
    .filter(({ t }) => Number.isFinite(t) && t <= end)
    .sort((a, b) => a.t - b.t || Number(a.death) - Number(b.death));
  const launches: number[] = [];
  let cursor = 0;
  while (cursor < events.length) {
    const time = events[cursor].t;
    let granted = false;
    let died = false;
    while (cursor < events.length && events[cursor].t === time) {
      const event = events[cursor++];
      if (event.death) {
        active = false;
        died = true;
      } else if (event.aura?.reset !== undefined) {
        active = event.aura.reset.includes(1706);
      } else if (event.aura?.spell === 1706) {
        if (event.aura.remove) active = false;
        else {
          if (!active) granted = true;
          active = true;
        }
      }
    }
    if (time >= start && granted && !died) launches.push(time);
  }
  return launches;
}

function transferEnd(
  actor: MovementModeActor,
  start: number,
): number | undefined {
  const deadline = start + 6000;
  let rapid = false;
  for (let i = 1; i < actor.samples.length; i++) {
    const a = actor.samples[i - 1];
    const b = actor.samples[i];
    if (b[0] <= start) continue;
    if (b[0] > deadline) break;
    const dt = b[0] - a[0];
    if (dt <= 0 || !Number.isFinite(dt)) continue;
    const distance = Math.hypot(b[1] - a[1], b[2] - a[2]);
    if (!Number.isFinite(distance)) continue;
    // Tiny displacements often represent duplicate/stale source observations.
    if (distance < 0.25 && !(distance === 0 && dt >= 100)) continue;
    const speed = (distance * 1000) / dt;
    if (speed > 16) rapid = true;
    else if (rapid && speed <= 12 && a[0] > start) {
      if (actor.deaths?.some(([t, dead]) => dead && t >= start && t <= a[0]))
        return undefined;
      return a[0];
    }
  }
  return undefined;
}

/** Paired recorded Magnetic Pull casts identify players; observations bound travel. */
export function recordedTransferEvidence(
  actors: readonly MovementModeActor[],
  combat: readonly CombatEvidence[],
): ReadonlyMap<string, TransferEvidence> {
  const players = new Map(
    actors
      .filter((actor) => actor.type === "Player")
      .map((actor) => [actor.key, actor]),
  );
  type CastEvidence = { caster: string; target: string; spell: number };
  const casts = new Map<number, CastEvidence[]>();
  for (const actor of actors) {
    if (actor.type !== "NPC") continue;
    for (const cast of actor.casts ?? []) {
      if (
        (cast.spell !== 28338 && cast.spell !== 28339) ||
        cast.outcome !== "completed" ||
        cast.timingSource !== "recorded" ||
        !Number.isFinite(cast.end)
      )
        continue;
      let target = cast.target;
      if (target == null) {
        let last = -Infinity;
        for (const event of combat) {
          if (
            event.kind === "damage" &&
            event.melee === true &&
            event.source === actor.key &&
            event.target != null &&
            players.has(event.target) &&
            event.t >= cast.end - 5000 &&
            event.t < cast.end &&
            event.t > last
          ) {
            last = event.t;
            target = event.target;
          }
        }
      }
      if (target == null || !players.has(target)) continue;
      const group = casts.get(cast.end) ?? [];
      if (
        !group.some(
          (entry) =>
            entry.caster === actor.key &&
            entry.target === target &&
            entry.spell === cast.spell,
        )
      )
        group.push({ caster: actor.key, target, spell: cast.spell });
      casts.set(cast.end, group);
    }
  }
  const result = new Map<
    string,
    { complete: Transfer[]; unresolved: number[] }
  >();
  for (const [start, group] of [...casts].sort(([a], [b]) => a - b)) {
    const left = group.filter((cast) => cast.spell === 28338);
    const right = group.filter((cast) => cast.spell === 28339);
    // Ambiguous pairs cannot establish which two players were exchanged.
    if (
      left.length !== 1 ||
      right.length !== 1 ||
      left[0].caster === right[0].caster ||
      left[0].target === right[0].target
    )
      continue;
    for (const cast of [left[0], right[0]]) {
      const end = transferEnd(players.get(cast.target)!, start);
      const evidence = result.get(cast.target) ?? {
        complete: [],
        unresolved: [],
      };
      if (end === undefined) {
        if (
          evidence.unresolved.length < 128 &&
          !evidence.unresolved.includes(start)
        )
          evidence.unresolved.push(start);
      } else if (
        evidence.complete.length < 128 &&
        !evidence.complete.some(([a, b]) => a === start && b === end)
      ) {
        evidence.complete.push([start, end]);
      }
      result.set(cast.target, evidence);
    }
  }
  return result;
}

/** Compatibility view containing only episodes with observed completion evidence. */
export function recordedTransfers(
  actors: readonly MovementModeActor[],
  combat: readonly CombatEvidence[],
): ReadonlyMap<string, readonly Transfer[]> {
  const result = new Map<string, readonly Transfer[]>();
  for (const [key, evidence] of recordedTransferEvidence(actors, combat)) {
    if (evidence.complete.length > 0) result.set(key, evidence.complete);
  }
  return result;
}
