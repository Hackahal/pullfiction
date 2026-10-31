import type { Actor, Point, Replay } from "./types";

export type RangeGroup =
  "all" | "ranged" | "melee" | "dps" | "healers" | "tanks" | "individuals";
export interface RangeSettings {
  enabled: boolean;
  radius: number;
  group: RangeGroup;
  players: string[];
}
export const defaultRangeCheck: RangeSettings = {
  enabled: false,
  radius: 10,
  group: "all",
  players: [],
};
export const RANGE_COLORS = {
  clear: "#65c6a1",
  crowded: "#f0756d",
};
export interface RangeCircle {
  key: string;
  position: Point;
  radius: number;
  status: keyof typeof RANGE_COLORS;
  nearby: number;
}
type Role = "dps" | "healers" | "tanks" | "unknown";
type PlayerRole = { role: Role; reach: "ranged" | "melee" | null };
const roleCache = new WeakMap<
  Replay,
  { details: unknown; roles: Map<number, PlayerRole> }
>();
const rangedClasses = new Set(["Mage", "Warlock", "Priest", "Hunter"]);

/** WCL's report-wide player groups stay stable across streamed combat chunks. */
export function rangePlayerRole(replay: Replay, actor: Actor): PlayerRole {
  let cached = roleCache.get(replay);
  if (!cached || cached.details !== replay.raw.playerDetails) {
    const roles = new Map<number, PlayerRole>();
    const groups = replay.raw.playerDetails?.data?.playerDetails ?? {};
    for (const [group, rows] of Object.entries(groups)) {
      if (!Array.isArray(rows)) continue;
      for (const player of rows) {
        if (!player || !Number.isInteger(player.id)) continue;
        const specs = (Array.isArray(player.specs) ? player.specs : [])
          .map((s: any) =>
            typeof s === "string" ? s : (s?.spec ?? s?.name ?? ""),
          )
          .join(" ")
          .toLowerCase();
        const role: Role = /tank/i.test(group)
          ? "tanks"
          : /heal/i.test(group)
            ? "healers"
            : /dps|damage/i.test(group)
              ? "dps"
              : "unknown";
        const reach = /melee/.test(specs)
          ? "melee"
          : /ranged/.test(specs)
            ? "ranged"
            : /balance|elemental|shadow|arcane|fire|frost|destruction|affliction|demonology|marksmanship|beast|survival/.test(
                  specs,
                )
              ? "ranged"
              : /feral|enhancement|retribution|arms|fury|combat|assassination|subtlety/.test(
                    specs,
                  )
                ? "melee"
                : null;
        roles.set(player.id, { role, reach });
      }
    }
    cached = { details: replay.raw.playerDetails, roles };
    roleCache.set(replay, cached);
  }
  const recorded = cached.roles.get(actor.id);
  const role =
    recorded?.role !== undefined && recorded.role !== "unknown"
      ? recorded.role
      : ["Mage", "Warlock", "Hunter", "Rogue"].includes(actor.class) &&
          replay.gameVersion !== "sod"
        ? "dps"
        : "unknown";
  const reach =
    recorded?.reach ??
    (rangedClasses.has(actor.class)
      ? "ranged"
      : ["Warrior", "Rogue", "Paladin"].includes(actor.class)
        ? "melee"
        : null);
  return { role, reach };
}
export function rangePlayers(replay: Replay): Actor[] {
  const friendly = new Set(replay.fight.friendlyPlayers);
  return replay.actors.filter((a) => a.type === "Player" && friendly.has(a.id));
}
export function rangeMatches(
  replay: Replay,
  actor: Actor,
  settings: RangeSettings,
): boolean {
  if (settings.group === "all") return true;
  if (settings.group === "individuals")
    return settings.players.includes(actor.key);
  const { role, reach } = rangePlayerRole(replay, actor);
  return settings.group === "ranged" || settings.group === "melee"
    ? role === "dps" && reach === settings.group
    : role === settings.group;
}
export interface RangePose {
  pos: [number, number, number | null];
  dead: boolean;
  estimated: boolean;
  wisp: boolean;
}
export function rangeCircles(
  replay: Replay | null,
  settings: RangeSettings,
  poseAt: (actor: Actor) => RangePose | null,
): RangeCircle[] {
  if (!replay || !settings.enabled || !Number.isFinite(settings.radius))
    return [];
  const radius = Math.max(1, Math.min(100, settings.radius));
  const players = rangePlayers(replay).flatMap((actor) => {
    const pose = poseAt(actor);
    return !pose || pose.dead || !pose.pos.slice(0, 2).every(Number.isFinite)
      ? []
      : [{ actor, pose }];
  });
  return players
    .filter(({ actor }) => rangeMatches(replay, actor, settings))
    .map(({ actor, pose }) => {
      let nearby = 0;
      for (const other of players) {
        if (other.actor.id === actor.id) continue;
        const dz =
          pose.pos[2] !== null && other.pose.pos[2] !== null
            ? pose.pos[2] - other.pose.pos[2]
            : 0;
        const inside =
          Math.hypot(
            pose.pos[0] - other.pose.pos[0],
            pose.pos[1] - other.pose.pos[1],
            dz,
          ) <= radius;
        if (!inside) continue;
        nearby++;
      }
      return {
        key: actor.key,
        position: [pose.pos[0], pose.pos[1], pose.pos[2] ?? 0],
        radius,
        status: nearby ? "crowded" : "clear",
        nearby,
      };
    });
}
