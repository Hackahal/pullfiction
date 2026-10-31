import { BROWSER_ASSETS } from "./browser-mode";
import type { Actor, Replay } from "./types";
export const FOCUS_POSITION = "pullfiction.focus.position.v1";
export function clampFocus(
  x: number,
  y: number,
  width: number,
  height: number,
  panelWidth: number,
  panelHeight: number,
) {
  return {
    x: Math.max(
      0,
      Math.min(Math.max(0, width - panelWidth), Number.isFinite(x) ? x : 0),
    ),
    y: Math.max(
      0,
      Math.min(Math.max(0, height - panelHeight), Number.isFinite(y) ? y : 0),
    ),
  };
}
export function itemIconName(icon?: string) {
  if (typeof icon !== "string") return null;
  const stem = icon.replace(/\.(?:jpg|jpeg|png|blp)$/i, "");
  return /^[a-z0-9_-]+$/i.test(stem) ? stem.toLowerCase() : null;
}
export function itemIcon(icon?: string) {
  if (BROWSER_ASSETS) return null;
  const stem = itemIconName(icon);
  return stem
    ? `https://wow.zamimg.com/images/wow/icons/medium/${stem}.jpg`
    : null;
}
export const POWER_NAMES = ["Mana", "Rage", "Focus", "Energy", "Happiness"];
export const POWER_COLORS = [
  "#347bdc",
  "#cf4545",
  "#cc8544",
  "#e2c43b",
  "#32ad9d",
];

interface TargetEvidence {
  key: string;
  at: number;
  kind: string;
  priority: number;
}
const targetCache = new WeakMap<Replay, Map<string, TargetEvidence[]>>();
export function focusTargetAt(replay: Replay, actor: Actor, t: number) {
  let actors = targetCache.get(replay);
  if (!actors) {
    actors = new Map();
    targetCache.set(replay, actors);
  }
  let events = actors.get(actor.key);
  if (!events) {
    const known = new Set(replay.actors.map((a) => a.key));
    events = [];
    for (const raw of replay.raw.events as Record<string, any>[]) {
      if (
        `${raw.sourceID}:${raw.sourceInstance || 1}` !== actor.key ||
        raw.tick
      )
        continue;
      const kind = raw.type;
      if (
        ![
          "cast",
          "begincast",
          "damage",
          "heal",
          "interrupt",
          "dispel",
        ].includes(kind) ||
        ((kind === "damage" || kind === "heal") && raw.isAoE === true)
      )
        continue;
      const key = `${raw.targetID}:${raw.targetInstance || 1}`,
        at = raw.timestamp - replay.fight.startTime;
      if (!known.has(key) || at < 0 || at > replay.duration) continue;
      events.push({
        key,
        at,
        kind,
        priority: kind === "cast" || kind === "begincast" ? 2 : 1,
      });
    }
    events.sort((a, b) => a.at - b.at || a.priority - b.priority);
    actors.set(actor.key, events);
  }
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].at <= t) lo = mid + 1;
    else hi = mid;
  }
  const evidence = events[lo - 1];
  if (!evidence) return null;
  const target = replay.actors.find((a) => a.key === evidence.key);
  return target ? { target, at: evidence.at, kind: evidence.kind } : null;
}
