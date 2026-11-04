import { poseAt } from "./domain";
import { fitMap, mapPoint, type MapCamera } from "./map-model";
import type { Replay } from "./types";
/** Median resists a straggler or pet pulling a teleport cut into another room. */
export function raidCameraCenter(
  subjects: { actor: { type: string }; pos: [number, number, number | null] }[],
): [number, number] | null {
  const players = subjects.filter((s) => s.actor.type === "Player");
  if (!players.length) return null;
  const median = (axis: number) => {
    const values = players.map((s) => s.pos[axis]!).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2;
  };
  return [median(0), median(1)];
}
export function raidCameraSubjects(
  replay: Replay,
  time: number,
  smooth: boolean,
  lookupPose: typeof poseAt = poseAt,
) {
  const friendly = new Set(replay.fight.friendlyPlayers);
  const enemies = combatCameraEnemies(replay, time);
  const raid: {
    actor: Replay["actors"][number];
    pos: [number, number, number | null];
  }[] = [];
  const others: typeof raid = [];
  for (const actor of replay.actors) {
    const player = actor.type === "Player";
    // Actors that can never enter this frame do not need an interpolated pose.
    if (
      player
        ? !friendly.has(actor.id)
        : actor.type !== "Pet" && !enemies.has(actor.key)
    )
      continue;
    const pose = lookupPose(actor, time, smooth);
    if (pose && !pose.dead)
      (player ? raid : others).push({ actor, pos: pose.pos });
  }
  if (!raid.length) return others.filter((p) => p.actor.type === "NPC");
  const playerCount = raid.length;
  for (const p of others) {
    for (let i = 0; i < playerCount; i++) {
      const r = raid[i];
      if (Math.hypot(r.pos[0] - p.pos[0], r.pos[1] - p.pos[1]) <= 90) {
        raid.push(p);
        break;
      }
    }
  }
  return raid;
}
export function raidMapFrame(
  subjects: { pos: [number, number, number | null] }[],
  width: number,
  height: number,
): MapCamera | null {
  if (!subjects.length || width < 1 || height < 1) return null;
  const points = subjects.map((p) => mapPoint(p.pos[0], p.pos[1]));
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  // Room for portraits, health bars and movement without constant zoom changes.
  return fitMap(
    [
      Math.min(...xs) - 10,
      Math.min(...ys) - 10,
      Math.max(...xs) + 10,
      Math.max(...ys) + 10,
    ],
    width,
    height,
  );
}
export function easeMapCamera(
  current: MapCamera,
  goal: MapCamera,
  dt: number,
): MapCamera {
  const alpha = 1 - Math.exp(-Math.max(0, Math.min(0.1, dt)) * 5);
  // Zoom out faster to catch a spreading raid; zoom in slowly when it regroups.
  const zoom =
    1 -
    Math.exp(
      -Math.max(0, Math.min(0.1, dt)) * (goal.scale < current.scale ? 7 : 2),
    );
  return {
    x: current.x + (goal.x - current.x) * alpha,
    y: current.y + (goal.y - current.y) * alpha,
    scale: Math.exp(
      Math.log(current.scale) +
        (Math.log(goal.scale) - Math.log(current.scale)) * zoom,
    ),
  };
}

const CAMERA_EVENT_CACHE_SIZE = 4096;

type CameraCombatWindow = {
  actors: Map<string, Replay["actors"][number]>;
  events: (Replay["combat"][number] | undefined)[];
  enemies: (string | null)[];
};
const cameraWindows = new WeakMap<Replay, CameraCombatWindow>();

function cameraEnemy(
  index: CameraCombatWindow,
  event: Replay["combat"][number],
): string | null {
  if (
    event.kind !== "damage" &&
    event.kind !== "start" &&
    event.kind !== "go" &&
    event.kind !== "interrupt"
  )
    return null;
  const source = index.actors.get(event.source ?? ""),
    target = index.actors.get(event.target ?? "");
  if (!source || !target || (source.type === "NPC") === (target.type === "NPC"))
    return null;
  const enemy = source.type === "NPC" ? source : target;
  const other = source === enemy ? target : source;
  return other.type === "Player" || other.type === "Pet" ? enemy.key : null;
}
export function combatCameraEnemies(replay: Replay, time: number): Set<string> {
  let index = cameraWindows.get(replay);
  if (!index) {
    index = {
      actors: new Map(replay.actors.map((actor) => [actor.key, actor])),
      events: new Array(CAMERA_EVENT_CACHE_SIZE),
      enemies: new Array(CAMERA_EVENT_CACHE_SIZE),
    };
    cameraWindows.set(replay, index);
  }
  const events = replay.combat ?? [];
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  const active = new Set<string>();
  for (let i = lo - 1; i >= 0 && events[i].t >= time - 8000; i--) {
    const event = events[i];
    // Neighboring frames overlap most of this window. Bound the cache to
    // recent rows, checking identity so replacement events classify afresh.
    if (lo - i > CAMERA_EVENT_CACHE_SIZE) {
      const enemy = cameraEnemy(index, event);
      if (enemy !== null) active.add(enemy);
      continue;
    }
    const slot = i % CAMERA_EVENT_CACHE_SIZE;
    if (index.events[slot] !== event) {
      index.events[slot] = event;
      index.enemies[slot] = cameraEnemy(index, event);
    }
    const enemy = index.enemies[slot];
    if (enemy !== null) active.add(enemy);
  }
  return active;
}
