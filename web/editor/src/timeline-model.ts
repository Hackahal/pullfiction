import type { Actor, Cast, Replay } from "./types";
export const TRACK_HEIGHT = 28;
export function playerTracks(replay: Replay) {
  const players = new Set(replay.fight.friendlyPlayers);
  return replay.actors
    .filter((a) => a.type === "Player" && players.has(a.id))
    .sort(
      (a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name),
    );
}
export function followingStart(
  time: number,
  start: number,
  span: number,
  duration: number,
) {
  const max = Math.max(0, duration - span);
  if (time < start || time > start + span * 0.7)
    return Math.max(0, Math.min(max, time - span * 0.7));
  return Math.max(0, Math.min(max, start));
}
export function visibleCasts(actor: Actor, start: number, end: number) {
  return actor.casts
    .map((cast, index) => ({ cast, index }))
    .filter(
      ({ cast }) =>
        cast.start <= end && (cast.instant ? cast.start : cast.end) >= start,
    );
}
export function castEvents(replay: Replay, actor: Actor, cast: Cast) {
  const next = actor.casts.find(
    (c) => c.spell === cast.spell && c.start > cast.start,
  );
  const end = Math.min(next?.start ?? replay.duration, cast.end + 8000);
  return replay.combat.filter(
    (e) =>
      e.source === actor.key &&
      e.spell === cast.spell &&
      e.t >= cast.start &&
      e.t < end,
  );
}
export function castOutcome(cast: Cast) {
  if (
    cast.outcome &&
    cast.outcome !== "completed" &&
    cast.outcome !== "unresolved"
  )
    return cast.outcome;
  if (cast.interrupted) return "interrupted";
  return cast.inferredEnd ? "completion unrecorded" : "completed";
}
export function castDuration(cast: Cast) {
  if (cast.instant) return "Instant";
  if (cast.timingSource === "unknown") return "Duration unknown";
  return `${((cast.end - cast.start) / 1000).toFixed(3)}s${cast.inferredEnd ? " estimated" : ""}`;
}
export function castLabel(cast: Cast) {
  return `${cast.name} · ${cast.channel ? "Channel · " : ""}${castDuration(cast)}${castOutcome(cast) !== "completed" ? ` · ${castOutcome(cast)}` : ""}`;
}

export interface TimelineLane {
  key: string;
  actor: Actor;
  spell?: number;
  name: string;
  icon?: string;
  aggregate?: boolean;
  casts: { cast: Cast; index: number; actor?: Actor }[];
  intervals?: AuraInterval[];
}
export function timelineLanes(
  actors: Actor[],
  abilities: boolean,
  melee: boolean,
): TimelineLane[] {
  return actors.flatMap((actor) => {
    const casts = actor.casts
      .map((cast, index) => ({ cast, index, actor }))
      .filter(({ cast }) => melee || cast.spell !== 1);
    if (!abilities) return [{ key: actor.key, actor, name: actor.name, casts }];
    const spells = new Map<number, TimelineLane>();
    for (const item of casts) {
      let lane = spells.get(item.cast.spell);
      if (!lane) {
        lane = {
          key: `${actor.key}/${item.cast.spell}`,
          actor,
          spell: item.cast.spell,
          name: item.cast.name,
          icon: item.cast.icon,
          casts: [],
        };
        spells.set(item.cast.spell, lane);
      }
      lane.casts.push(item);
    }
    return [
      { key: actor.key, actor, name: actor.name, casts: [] },
      ...spells.values(),
    ];
  });
}
export function abilityColor(spell: number) {
  return [
    "#e6ad55",
    "#8abf72",
    "#6faacb",
    "#b893d1",
    "#d27d83",
    "#8ac6bb",
    "#c8bd76",
  ][Math.abs(spell) % 7];
}

export interface AuraInterval {
  spell: number;
  name: string;
  icon?: string;
  start: number;
  end: number;
  stack: number;
  debuff: boolean;
}
export function auraIntervals(actor: Actor, replay: Replay): AuraInterval[] {
  const intervals: AuraInterval[] = [],
    open = new Map<number, AuraInterval>();
  function close(spell: number, t: number) {
    const a = open.get(spell);
    if (a) {
      if (t > a.start) intervals.push({ ...a, end: t });
      open.delete(spell);
    }
  }
  function begin(
    spell: number,
    t: number,
    stack = 1,
    debuff = false,
    name?: string,
    icon?: string,
  ) {
    const meta = replay.abilities.get(spell);
    open.set(spell, {
      spell,
      name: name ?? meta?.name ?? `Spell ${spell}`,
      icon: icon ?? meta?.icon,
      start: t,
      end: replay.duration,
      stack,
      debuff,
    });
  }
  for (const spell of actor.initialAuras ?? []) begin(spell, 0);
  for (const [t, a] of actor.auras ?? []) {
    if ("reset" in a) {
      for (const id of [...open.keys()]) close(id, t);
      for (const id of a.reset) begin(id, t);
    } else {
      close(a.spell, t);
      if (!a.remove) begin(a.spell, t, a.stack, a.debuff, a.name, a.icon);
    }
  }
  for (const id of [...open.keys()]) close(id, replay.duration);
  return intervals;
}
export function detailLanes(
  actor: Actor,
  replay: Replay,
  melee: boolean,
  buffs: boolean,
  debuffs: boolean,
): TimelineLane[] {
  const lanes = timelineLanes([actor], true, melee),
    auras = new Map<string, TimelineLane>();
  for (const a of auraIntervals(actor, replay)) {
    if (a.debuff ? !debuffs : !buffs) continue;
    const key = `${actor.key}/${a.debuff ? "debuff" : "buff"}/${a.spell}`;
    let lane = auras.get(key);
    if (!lane) {
      lane = {
        key,
        actor,
        spell: a.spell,
        name: `${a.debuff ? "Debuff" : "Buff"} · ${a.name}`,
        icon: a.icon,
        casts: [],
        intervals: [],
      };
      auras.set(key, lane);
    }
    lane.intervals!.push(a);
  }
  return [...lanes, ...auras.values()];
}
export function damageSeries(
  replay: Replay,
  actorKey?: string,
  kind = "damage",
) {
  const bins = new Float64Array(Math.ceil(replay.duration / 1000) + 1);
  for (const e of replay.combat) {
    if (e.kind !== kind || e.t < 0 || e.t > replay.duration) continue;
    const actor = replay.actors.find((a) => a.key === e.source);
    if (
      actorKey
        ? e.source !== actorKey
        : !(
            actor &&
            (replay.fight.friendlyPlayers.includes(actor.id) ||
              (actor.owner &&
                replay.fight.friendlyPlayers.includes(actor.owner)))
          )
    )
      continue;
    bins[Math.floor(e.t / 1000)] += e.amount ?? 0;
  }
  return bins;
}
export function currentDps(
  replay: Replay,
  t: number,
  actorKey?: string,
  kind = "damage",
) {
  const start = Math.max(0, t - 5000);
  let total = 0;
  for (const e of replay.combat) {
    if (e.t > t) break;
    if (e.t < start || e.kind !== kind) continue;
    const actor = replay.actors.find((a) => a.key === e.source);
    if (
      actorKey
        ? e.source === actorKey
        : !!actor &&
          (replay.fight.friendlyPlayers.includes(actor.id) ||
            (!!actor.owner &&
              replay.fight.friendlyPlayers.includes(actor.owner)))
    )
      total += e.amount ?? 0;
  }
  return t <= 0 ? 0 : total / Math.max(1, (t - start) / 1000);
}

export type TimelineView = "players" | "abilities" | "combined";
export function raidTimelineLanes(
  actors: Actor[],
  view: TimelineView,
  melee: boolean,
): TimelineLane[] {
  const lanes = timelineLanes(actors, view !== "players", melee);
  if (view !== "abilities") return lanes;
  const grouped = new Map<number, TimelineLane>();
  for (const lane of lanes) {
    if (lane.spell === undefined) continue;
    let group = grouped.get(lane.spell);
    if (!group) {
      group = {
        ...lane,
        key: `ability/${lane.spell}`,
        aggregate: true,
        casts: [],
      };
      grouped.set(lane.spell, group);
    }
    group.casts.push(...lane.casts);
  }
  return [...grouped.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((lane) => ({
      ...lane,
      casts: lane.casts.sort((a, b) => a.cast.start - b.cast.start),
    }));
}

export function searchTimelineLanes(
  lanes: TimelineLane[],
  replay: Replay,
  query: string,
): TimelineLane[] {
  const terms = [
    ...query
      .toLowerCase()
      .matchAll(
        /(?:(ability|spell|player|class|target|buff|debuff):)?(?:"([^"]*)"|(\S+))/g,
      ),
  ]
    .map((m) => ({ field: m[1] ?? "", value: (m[2] ?? m[3]).trim() }))
    .filter((t) => t.value);
  if (!terms.length) return lanes;
  const actors = new Map(replay.actors.map((a) => [a.key, a]));
  const matches = (
    actor: Actor,
    name: string,
    spell?: number,
    target?: string | null,
    kind = "cast",
  ) => {
    const fields: Record<string, string> = {
      ability: name.toLowerCase(),
      spell: `${spell ?? ""}`,
      player: actor.name.toLowerCase(),
      class: (actor.class ?? "").toLowerCase(),
      target: (actors.get(target ?? "")?.name ?? "").toLowerCase(),
      buff: kind === "buff" ? name.toLowerCase() : "",
      debuff: kind === "debuff" ? name.toLowerCase() : "",
    };
    const all = Object.values(fields).join(" ") + " " + kind;
    return terms.every(({ field, value }) =>
      field === "spell"
        ? fields.spell === value
        : (field ? fields[field] : all).includes(value),
    );
  };
  const filtered = lanes.map((lane) => ({
    ...lane,
    casts: lane.casts.filter(({ cast, actor }) =>
      matches(actor ?? lane.actor, cast.name, cast.spell, cast.target),
    ),
    intervals: lane.intervals?.filter((a) =>
      matches(
        lane.actor,
        a.name,
        a.spell,
        undefined,
        a.debuff ? "debuff" : "buff",
      ),
    ),
  }));
  const populated = filtered.filter(
    (l) => l.casts.length || l.intervals?.length,
  );
  const matchedPlayers = new Set(populated.map((l) => l.actor.key));
  return filtered.filter(
    (l) =>
      l.casts.length ||
      l.intervals?.length ||
      (l.spell === undefined &&
        (matchedPlayers.has(l.actor.key) || matches(l.actor, ""))),
  );
}
export interface TimelineMatch {
  lane: string;
  t: number;
  actor: string;
  castIndex?: number;
  spell: number;
}
export function timelineMatches(lanes: TimelineLane[]): TimelineMatch[] {
  return lanes
    .flatMap((lane) => [
      ...lane.casts.map(({ cast, index, actor }) => ({
        lane: lane.key,
        t: cast.start,
        actor: (actor ?? lane.actor).key,
        castIndex: index,
        spell: cast.spell,
      })),
      ...(lane.intervals ?? []).map((a) => ({
        lane: lane.key,
        t: a.start,
        actor: lane.actor.key,
        spell: a.spell,
      })),
    ])
    .sort((a, b) => a.t - b.t || a.lane.localeCompare(b.lane));
}
export function nextTimelineMatch(
  matches: TimelineMatch[],
  time: number,
  direction: 1 | -1,
  cursor = -1,
) {
  if (!matches.length) return -1;
  if (matches[cursor]?.t === time)
    return (cursor + direction + matches.length) % matches.length;
  if (direction === 1) {
    const next = matches.findIndex((m) => m.t >= time);
    return next < 0 ? 0 : next;
  }
  for (let i = matches.length - 1; i >= 0; i--)
    if (matches[i].t <= time) return i;
  return matches.length - 1;
}

export function draggedTimelineRange(
  start: number,
  vertical: number,
  dx: number,
  dy: number,
  millisecondsPerPixel: number,
  duration: number,
  span: number,
  maxVertical: number,
) {
  return {
    start: Math.max(
      0,
      Math.min(Math.max(0, duration - span), start - dx * millisecondsPerPixel),
    ),
    vertical: Math.max(0, Math.min(maxVertical, vertical - dy)),
  };
}
