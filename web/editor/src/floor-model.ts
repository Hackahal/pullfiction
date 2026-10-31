import { poseAt } from "./domain";
import type { Actor, Replay } from "./types";

type Seed = [number, number, number, number];
type Anchor = {
  x: number;
  y: number;
  z: number;
  actor?: string;
  boss?: boolean;
};
type MapSeeds = { entries: Map<number, Seed[]>; spatial: Anchor[] };
const indexes = new WeakMap<object, Map<number, MapSeeds>>();
const actorSeeds = new WeakMap<Actor, { catalog: object; seed?: Seed }>();
function seedIndex(catalog: Record<string, unknown>) {
  let result = indexes.get(catalog);
  if (result) return result;
  result = new Map();
  for (const [entry, value] of Object.entries(catalog)) {
    const seeds = (value as { floorSeeds?: Seed[] })?.floorSeeds ?? [];
    for (const seed of seeds) {
      if (seed.length !== 4 || !seed.every(Number.isFinite)) continue;
      let map = result.get(seed[0]);
      if (!map)
        result.set(seed[0], (map = { entries: new Map(), spatial: [] }));
      map.spatial.push({ x: seed[1], y: seed[2], z: seed[3] });
      const list = map.entries.get(Number(entry)) ?? [];
      list.push(seed);
      map.entries.set(Number(entry), list);
    }
  }
  indexes.set(catalog, result);
  return result;
}
function nearest<T>(
  values: T[],
  point: number[],
  xy: (v: T) => number[],
  limit: number,
): T | undefined {
  let best: T | undefined,
    distance = limit * limit;
  for (const value of values) {
    const p = xy(value),
      d = (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2;
    if (d < distance) {
      distance = d;
      best = value;
    }
  }
  return best;
}
/** Approximate level context only. Native collision determines the actual foot height.
 * Each NPC instance matches its first recorded XY to a same-entry spawn on this map.
 * Current-chapter enemies give friendly actors seek-safe room context, including
 * overlapping BWL floors. No assumption that missing log Z means world altitude zero.
 * ownHints optionally separates an actor's own seed from nearby-actor estimates.
 * Those estimates describe the current room, not both ends of a movement interval.
 */
export function replayFloorHints(
  replay: Replay,
  time: number,
  catalog: Record<string, unknown>,
  ownHints?: Map<string, number>,
): Map<string, number> {
  const seeds = seedIndex(catalog).get(replay.map);
  const result = new Map<string, number>();
  if (!seeds) return result;
  const chapter =
    replay.chapters.find((c) => c.start <= time && c.end >= time) ??
    [...replay.chapters].reverse().find((c) => c.start <= time);
  const members = chapter?.enemyNPCs
    ? new Set(chapter.enemyNPCs.map((n) => n.id))
    : null;
  const anchors: Anchor[] = [];
  for (const actor of replay.actors) {
    if (actor.type !== "NPC") continue;
    if (actor.spawn) {
      result.set(actor.key, actor.spawn.position[2]);
      ownHints?.set(actor.key, actor.spawn.position[2]);
    }
    if (actor.spawn?.synthetic || !actor.samples.length) continue;
    let cached = actorSeeds.get(actor);
    if (cached?.catalog !== catalog) {
      const first = actor.samples[0];
      cached = {
        catalog,
        seed: nearest(
          seeds.entries.get(actor.gameID) ?? [],
          [first[1], first[2]],
          (s) => [s[1], s[2]],
          250,
        ),
      };
      actorSeeds.set(actor, cached);
    }
    const seed: Seed | undefined = actor.spawn
      ? [replay.map, ...actor.spawn.position]
      : cached.seed;
    if (!seed) continue;
    result.set(actor.key, seed[3]);
    ownHints?.set(actor.key, seed[3]);
    if (members && !members.has(actor.id)) continue;
    if (
      chapter &&
      (actor.firstSeen > chapter.end || actor.lastSeen < chapter.start)
    )
      continue;
    const pose = poseAt(actor, time, false);
    if (!pose || pose.dead) continue;
    anchors.push({
      x: pose.pos[0],
      y: pose.pos[1],
      z: seed[3],
      actor: actor.key,
      boss: actor.class === "Boss" || actor.icon?.toLowerCase() === "boss",
    });
  }
  const bosses = anchors.filter((a) => a.boss);
  for (const actor of replay.actors) {
    if (result.has(actor.key)) continue;
    const pose = poseAt(actor, time, false);
    if (!pose) continue;
    const point = [pose.pos[0], pose.pos[1]];
    const anchor =
      nearest(bosses, point, (a) => [a.x, a.y], 200) ??
      nearest(anchors, point, (a) => [a.x, a.y], 200) ??
      nearest(seeds.spatial, point, (a) => [a.x, a.y], 80);
    if (anchor) result.set(actor.key, anchor.z);
  }
  return result;
}
