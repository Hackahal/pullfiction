import type { Actor } from "./types";

export type CombatSide = "all" | "enemies" | "friendlies";
export type CombatSideSetting = CombatSide | "default";

// Incoming damage and healing keep their existing coverage, including the
// environment. Outgoing damage metrics default to known enemy targets.
export function defaultCombatSide(metric: string): CombatSide {
  return [
    "damage",
    "overkill",
    "unmitigated",
    "absorbed",
    "blocked",
    "resisted",
    "mitigated",
  ].includes(metric)
    ? "enemies"
    : "all";
}
export function matchesCombatSide(
  actor: Pick<Actor, "id" | "owner"> | undefined,
  players: ReadonlySet<number>,
  side: CombatSide,
) {
  if (side === "all") return true;
  if (!actor) return false;
  const friendly =
    players.has(actor.id) || (!!actor.owner && players.has(actor.owner));
  return side === "friendlies" ? friendly : !friendly;
}
export function perSecond(amount: number, seconds: number): number | null {
  return Number.isFinite(amount) && Number.isFinite(seconds) && seconds > 0
    ? amount / seconds
    : null;
}
export function formatRate(value: number | null, compact = false, digits = 0) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, {
        notation: compact ? "compact" : "standard",
        maximumFractionDigits: digits,
      });
}
