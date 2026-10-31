import { CLASS_COLORS } from "./domain";
import type { Replay } from "./types";
import {
  defaultCombatSide,
  matchesCombatSide,
  type CombatSide,
} from "./combat-metrics";
export const metrics = {
  damage: "Damage done",
  taken: "Damage taken",
  heal: "Healing",
  cast: "Casts",
  death: "Deaths",
  interrupt: "Interrupts",
  dispel: "Dispels",
  buff: "Buff changes",
  debuff: "Debuff changes",
} as const;
export type Metric = keyof typeof metrics;
export interface AnalysisEvent {
  id: number;
  t: number;
  kind: string;
  source: string;
  target: string;
  spell: number;
  name: string;
  amount: number;
  overheal: number;
  hitType: number;
}
export interface Query {
  metric: Metric;
  source: string;
  target: string;
  spell: string;
  pets: boolean;
  ownerPets?: boolean;
  hostility?: CombatSide;
  start: number;
  end: number;
  intervals?: [number, number][];
}
const eventIndexes = new WeakMap<
  Replay,
  {
    events: unknown;
    length: number;
    tail: unknown;
    abilities: unknown;
    index: AnalysisEvent[];
  }
>();
export function indexEvents(replay: Replay): AnalysisEvent[] {
  const raw = replay.raw.events;
  const cached = eventIndexes.get(replay);
  if (
    cached &&
    cached.events === raw &&
    cached.length === raw.length &&
    cached.tail === raw.at(-1) &&
    cached.abilities === replay.abilities
  )
    return cached.index;
  const index = (raw as Record<string, any>[])
    .map((e, id) => {
      const isDeath = e.type === "death";
      const spell =
        (isDeath ? e.killingAbilityGameID : undefined) ??
        e.abilityGameID ??
        e.ability?.guid ??
        0;
      return {
        id,
        t: e.timestamp - replay.fight.startTime,
        kind:
          isDeath && (e.feign === true || e.isFeign === true)
            ? "feigndeath"
            : e.type,
        source:
          isDeath && Number.isFinite(e.killerID)
            ? `${e.killerID}:${e.killerInstance || 1}`
            : `${e.sourceID}:${e.sourceInstance || 1}`,
        target: `${e.targetID}:${e.targetInstance || 1}`,
        spell,
        name:
          replay.abilities.get(spell)?.name ??
          (spell === -4 ? "Melee" : `Spell ${spell}`),
        amount: Number.isFinite(e.amount) ? e.amount : 0,
        overheal: Number.isFinite(e.overheal) ? e.overheal : 0,
        hitType: e.hitType ?? 0,
      };
    })
    .filter((e) => e.t >= 0 && e.t <= replay.duration)
    .sort((a, b) => a.t - b.t);
  eventIndexes.set(replay, {
    events: raw,
    length: raw.length,
    tail: raw.at(-1),
    abilities: replay.abilities,
    index,
  });
  return index;
}
function bound(events: AnalysisEvent[], t: number, upper = false) {
  let a = 0,
    b = events.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (events[m].t < t || (upper && events[m].t === t)) a = m + 1;
    else b = m;
  }
  return a;
}
export function deathRecap(events: AnalysisEvent[], death: AnalysisEvent) {
  return events
    .slice(bound(events, death.t - 10000), bound(events, death.t, true))
    .filter(
      (e) =>
        e.target === death.target &&
        ["damage", "heal", "absorbed", "death"].includes(e.kind),
    );
}
function recipient(metric: Metric) {
  return ["taken", "death", "buff", "debuff"].includes(metric);
}
export function queryEvents(events: AnalysisEvent[], q: Query, replay: Replay) {
  const friendlyIds = new Set(replay.fight.friendlyPlayers);
  const actorMap = new Map(replay.actors.map((a) => [a.key, a]));
  const selected = actorMap.get(q.source);
  const side =
    q.hostility ??
    (selected && !matchesCombatSide(selected, friendlyIds, "friendlies")
      ? "all"
      : defaultCombatSide(q.metric));
  const players = new Set(
    replay.actors
      .filter(
        (a) =>
          a.type === "Player" && replay.fight.friendlyPlayers.includes(a.id),
      )
      .map((a) => a.key),
  );
  const allowed = new Set([
    ...players,
    ...(q.pets
      ? replay.actors
          .filter(
            (a) => a.owner && replay.fight.friendlyPlayers.includes(a.owner),
          )
          .map((a) => a.key)
      : []),
  ]);
  return events
    .slice(bound(events, q.start), bound(events, q.end, true))
    .filter((e) => {
      const kind = q.metric === "taken" ? "damage" : q.metric;
      const match =
        kind === "buff"
          ? /buff/.test(e.kind) && !/debuff/.test(e.kind)
          : kind === "debuff"
            ? /debuff/.test(e.kind)
            : e.kind === kind;
      const actor = recipient(q.metric) ? e.target : e.source;
      return (
        match &&
        matchesCombatSide(
          actorMap.get(recipient(q.metric) ? e.source : e.target),
          friendlyIds,
          side,
        ) &&
        (q.source === "*"
          ? allowed.has(actor)
          : actor === q.source ||
            !!(
              q.pets &&
              q.ownerPets !== false &&
              !recipient(q.metric) &&
              selected?.type === "Player" &&
              actorMap.get(actor)?.owner === selected.id
            )) &&
        (!q.intervals || q.intervals.some(([a, b]) => e.t >= a && e.t <= b)) &&
        (q.target === "*" ||
          (recipient(q.metric) ? e.source : e.target) === q.target) &&
        (q.spell === "*" || String(e.spell) === q.spell)
      );
    });
}
export interface AnalysisRow {
  key: string;
  name: string;
  actor?: string;
  spell?: number;
  total: number;
  count: number;
  crit: number;
  overheal: number;
}
export function summarize(
  events: AnalysisEvent[],
  metric: Metric,
  group: "actor" | "spell" | "target",
  replay: Replay,
  mergePets = false,
): AnalysisRow[] {
  const rows = new Map<string, AnalysisRow>();
  const amounts = ["damage", "taken", "heal"].includes(metric);
  const actors = new Map(replay.actors.map((a) => [a.key, a]));
  const owners = new Map(
    replay.actors.filter((a) => a.type === "Player").map((a) => [a.id, a]),
  );
  for (const e of events) {
    let actor =
      group === "target"
        ? recipient(metric)
          ? e.source
          : e.target
        : recipient(metric)
          ? e.target
          : e.source;
    if (mergePets && !recipient(metric) && group === "actor") {
      const owner = owners.get(actors.get(actor)?.owner!);
      if (owner) actor = owner.key;
    }
    const key = group === "spell" ? String(e.spell) : actor;
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        name:
          group === "spell" ? e.name : (actors.get(actor)?.name ?? "Unknown"),
        actor: group === "spell" ? undefined : actor,
        spell: group === "spell" ? e.spell : undefined,
        total: 0,
        count: 0,
        crit: 0,
        overheal: 0,
      };
      rows.set(key, r);
    }
    r.total += amounts ? e.amount : 1;
    r.count++;
    r.crit += e.hitType === 2 ? 1 : 0;
    r.overheal += e.overheal;
  }
  return [...rows.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
}
export function graphBuckets(
  events: AnalysisEvent[],
  start: number,
  end: number,
  metric: Metric,
  n = 100,
) {
  const step = Math.max(1, (end - start) / n),
    values = new Array<number>(n).fill(0);
  for (const e of events) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((e.t - start) / step)));
    values[i] += ["damage", "taken", "heal"].includes(metric) ? e.amount : 1;
  }
  return values.map((v) => v / (step / 1000));
}

export function meterColor(replay: Replay, key?: string): string {
  const actor = replay.actors.find((a) => a.key === key);
  const owner = actor?.owner
    ? replay.actors.find((a) => a.id === actor.owner)
    : undefined;
  return (
    CLASS_COLORS[actor?.class ?? ""] ??
    CLASS_COLORS[owner?.class ?? ""] ??
    "#c9a65b"
  );
}
