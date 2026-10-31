import type { Actor, Point, Replay, SpawnPlacement } from "./types";

type StaticSpawn = { id: string; map: number; position: Point; facing: number };
type Model = {
  name?: string;
  displayID?: number;
  scale?: number;
  rank?: number;
  spawns?: StaticSpawn[];
};
type Slot = {
  key: string;
  entry: number;
  model: Model;
  spawn: StaticSpawn;
  lives: Actor[];
};
const BATCH_MS = 5000;
const MATCH_DISTANCE = 180;

/** Rectangular minimum-cost assignment. Dummy columns let uncertain rows remain unmatched. */
function assignment(costs: number[][]): number[] {
  const n = costs.length;
  if (!n) return [];
  const m = costs[0].length;
  const u = new Float64Array(n + 1),
    v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1),
    way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const min = new Float64Array(m + 1).fill(Infinity),
      used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cost = costs[i0 - 1][j - 1] - u[i0] - v[j];
        if (cost < min[j]) {
          min[j] = cost;
          way[j] = j0;
        }
        if (min[j] < delta) {
          delta = min[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}
function lastDeath(actor: Actor): number {
  const last = actor.deaths.at(-1);
  return last?.[1] ? last[0] : Infinity;
}
function distance(actor: Actor, slot: Slot): number {
  const first = actor.samples[0];
  if (!first) return Infinity;
  return Math.hypot(
    first[1] - slot.spawn.position[0],
    first[2] - slot.spawn.position[1],
  );
}
function placement(slot: Slot, actor?: Actor, visibleFrom = 0): SpawnPlacement {
  const d = actor ? distance(actor, slot) : null;
  return {
    key: slot.key,
    position: [...slot.spawn.position],
    facing: slot.spawn.facing,
    distance: d !== null && Number.isFinite(d) ? d : null,
    confidence: actor
      ? d !== null && d <= 40
        ? "near"
        : "approximate"
      : "unobserved",
    visibleFrom,
    synthetic: !actor,
  };
}
/** Static reference identity stays separate from report actor+instance identity.
 * Matching never moves samples or manufactures deaths. The same slot may bind a
 * later life only after an actual death, and its respawn starts when observed.
 */
export function populateRaidSpawns(
  replay: Replay,
  catalog: Record<string, unknown>,
): Replay {
  const slots = new Map<string, Slot>();
  for (const [entry, value] of Object.entries(catalog).sort(
    ([a], [b]) => Number(a) - Number(b),
  )) {
    const model = value as Model;
    if (!model?.displayID) continue;
    for (const spawn of model.spawns ?? []) {
      if (
        spawn.map !== replay.map ||
        !/^\d{1,16}$/.test(String(spawn.id)) ||
        spawn.position?.length !== 3 ||
        !spawn.position.every(
          (n) => Number.isFinite(n) && Math.abs(n) < 20000,
        ) ||
        !Number.isFinite(spawn.facing)
      )
        continue;
      const key = `spawn:${replay.map}:${spawn.id}`;
      if (!slots.has(key))
        slots.set(key, { key, entry: Number(entry), model, spawn, lives: [] });
    }
  }
  if (!slots.size) return replay;
  // Rebuilding from the same normalized object must not duplicate synthetic actors.
  replay.actors = replay.actors.filter((a) => !a.spawn?.synthetic);
  const byEntry = new Map<number, Slot[]>();
  for (const slot of [...slots.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  )) {
    const list = byEntry.get(slot.entry) ?? [];
    list.push(slot);
    byEntry.set(slot.entry, list);
  }
  const npcs = new Map<number, Actor[]>();
  for (const actor of replay.actors) {
    if (actor.type !== "NPC") continue;
    delete actor.spawn;
    actor.spawnObservedOnly = true;
    const list = npcs.get(actor.gameID) ?? [];
    if (Number.isFinite(actor.firstSeen)) list.push(actor);
    npcs.set(actor.gameID, list);
  }
  for (const [entry, actors] of npcs) {
    actors.sort(
      (a, b) => a.firstSeen - b.firstSeen || a.key.localeCompare(b.key),
    );
    const candidates = byEntry.get(entry) ?? [];
    for (let start = 0; start < actors.length;) {
      let end = start + 1;
      while (
        end < actors.length &&
        actors[end].firstSeen <= actors[start].firstSeen + BATCH_MS
      )
        end++;
      const batch = actors.slice(start, end);
      const available = candidates.filter(
        (s) =>
          !s.lives.length || lastDeath(s.lives.at(-1)!) <= batch[0].firstSeen,
      );
      if (available.length) {
        const transposed = batch.length > available.length;
        const left = transposed ? available.length : batch.length,
          right = transposed ? batch.length : available.length;
        const cost = (i: number, j: number) => {
          const actor = batch[transposed ? j : i],
            slot = available[transposed ? i : j];
          const d =
            !actor.samples.length &&
            batch.length === 1 &&
            available.length === 1
              ? 0
              : distance(actor, slot);
          return d <= MATCH_DISTANCE ? d * d : 1e12;
        };
        const matches = assignment(
          Array.from({ length: left }, (_, i) =>
            Array.from({ length: right + left }, (_, j) =>
              j < right ? cost(i, j) : 1e8,
            ),
          ),
        );
        for (let i = 0; i < matches.length; i++) {
          const j = matches[i];
          if (j < 0 || j >= right || cost(i, j) >= 1e8) continue;
          const actor = batch[transposed ? j : i],
            slot = available[transposed ? i : j];
          actor.spawn = placement(
            slot,
            actor,
            slot.lives.length ? actor.firstSeen : 0,
          );
          slot.lives.push(actor);
        }
      }
      start = end;
    }
  }
  let id = Math.min(0, ...replay.actors.map((a) => a.id)) - 1;
  for (const slot of slots.values()) {
    if (slot.lives.length) continue;
    replay.actors.push({
      key: slot.key,
      id: id--,
      instance: 1,
      name: slot.model.name ?? `NPC ${slot.entry}`,
      type: "NPC",
      class: slot.model.rank === 3 ? "Boss" : "NPC",
      gameID: slot.entry,
      displayID: slot.model.displayID!,
      scale: slot.model.scale ?? 1,
      spawn: placement(slot),
      samples: [],
      deaths: [],
      firstSeen: Infinity,
      lastSeen: -Infinity,
      runLifetime: false,
      facings: [],
      headings: [],
      gear: [],
      health: [],
      power: [],
      resourceChanges: [],
      casts: [],
      auras: [],
      initialAuras: [],
    });
  }
  return replay;
}

export function spawnStatus(actor: Actor, time: number): string | null {
  if (!actor.spawn) return null;
  if (actor.spawn.synthetic || time < actor.firstSeen)
    return "Unobserved spawn";
  const dead = actor.deaths.filter(([t]) => t <= time).at(-1)?.[1] ?? false;
  return dead ? "Killed in log" : "Observed in log";
}
