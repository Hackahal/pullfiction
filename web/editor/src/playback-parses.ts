import { indexEvents } from "./analysis-model";
import { matchesCombatSide } from "./combat-metrics";
import type { Replay } from "./types";

export type ParseOptions = {
  compare: "Parses" | "Rankings";
  timeframe: "Historical" | "Today";
  bracket: "overall" | "itemLevel";
};
export const defaultParseOptions: ParseOptions = {
  compare: "Parses",
  timeframe: "Today",
  bracket: "overall",
};
export type ParseEncounter = {
  id: number;
  encounterID: number;
  name: string;
  start: number;
  end: number;
  kill?: boolean;
};
export type ParseThreshold = { dps: number; percentile: number };
export type RankedPlayer = {
  name: string;
  className: string;
  spec: string;
  server: string;
  role: string;
  amount: number;
  percentile: number | null;
  bracketPercentile: number | null;
  bracket: number | null;
  population: number;
};
export type ParseReference = {
  player: RankedPlayer;
  curve: ParseThreshold[] | null;
  note: string | null;
};
export type ParseData = { references: ParseReference[]; fetchedAt: number };

/** Keep the last pull visible between pulls, but never select a future boss. */
export function parseEncounter(
  replay: Replay | null,
  time: number,
): ParseEncounter | null {
  if (!replay || !Number.isFinite(time)) return null;
  const chapters = replay.chapters;
  if (chapters.length) {
    const chapter = chapters
      .filter((c) => c.start <= time)
      .reduce<(typeof chapters)[number] | null>(
        (a, b) => (!a || b.start > a.start ? b : a),
        null,
      );
    // A trash chapter must not inherit the preceding boss's parse.
    return chapter && chapter.encounterID && chapter.encounterID > 0
      ? { ...chapter, encounterID: chapter.encounterID }
      : null;
  }
  const fight = replay.fight;
  return !fight.completeRaid &&
    typeof fight.id === "number" &&
    fight.encounterID &&
    fight.encounterID > 0 &&
    time >= 0
    ? {
        id: fight.id,
        encounterID: fight.encounterID,
        name: fight.name,
        start: 0,
        end: replay.duration,
        kill: fight.kill,
      }
    : null;
}

/** Interpolate only within observed thresholds; never extrapolate missing ranks. */
export function percentileAt(
  dps: number,
  thresholds: ParseThreshold[],
): number | null {
  if (!Number.isFinite(dps) || dps < 0 || thresholds.length < 2) return null;
  const sorted = [...thresholds].sort(
    (a, b) => a.dps - b.dps || a.percentile - b.percentile,
  );
  if (
    sorted.some(
      (p, i) =>
        !Number.isFinite(p.dps) ||
        p.dps < 0 ||
        !Number.isFinite(p.percentile) ||
        p.percentile < 0 ||
        p.percentile > 100 ||
        (i > 0 && p.percentile < sorted[i - 1].percentile),
    )
  )
    return null;
  if (dps < sorted[0].dps) return 0;
  if (dps > sorted.at(-1)!.dps) return 100;
  // For ties, use the highest observed percentile for this score.
  const exact = sorted.filter((p) => p.dps === dps).at(-1);
  if (exact) return exact.percentile;
  const upper = sorted.findIndex((p) => p.dps > dps);
  if (upper < 1) return null;
  const lo = sorted[upper - 1],
    hi = sorted[upper];
  return (
    lo.percentile +
    ((hi.percentile - lo.percentile) * (dps - lo.dps)) / (hi.dps - lo.dps)
  );
}

export function predictionSupported(options: ParseOptions) {
  return options.compare === "Rankings" && options.timeframe === "Today";
}

/** Match report actors, not WCL's unrelated global character IDs. Reject ambiguous names. */
export function referenceFor(replay: Replay, key: string, data: ParseData) {
  const actor = replay.actors.find((a) => a.key === key);
  if (!actor) return null;
  const actors = replay.actors.filter(
    (a) =>
      a.type === "Player" && a.name === actor.name && a.class === actor.class,
  );
  const raw = replay.raw.actors as { id: number; server?: string }[];
  const rawServer = raw.find((a) => a.id === actor.id)?.server;
  const server = typeof rawServer === "string" ? rawServer : undefined;
  // ReportActor.server is a compact realm name (LivingFlame), whereas
  // ranking JSON uses the display name (Living Flame).
  const realm = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const matches = data.references.filter(
    (r) =>
      r.player.name === actor.name &&
      r.player.className === actor.class &&
      (!server || realm(r.player.server) === realm(server)),
  );
  return actors.length === 1 && matches.length === 1 ? matches[0] : null;
}

/** Damage through the playhead only, including pets and excluding friendly fire. */
export function parsePace(
  replay: Replay,
  encounter: ParseEncounter,
  time: number,
) {
  const end = Math.max(encounter.start, Math.min(time, encounter.end));
  const elapsed = (end - encounter.start) / 1000;
  const friendly = new Set(replay.fight.friendlyPlayers);
  const actors = new Map(replay.actors.map((a) => [a.key, a]));
  const totals = new Map<string, number>();
  for (const event of indexEvents(replay)) {
    if (event.t < encounter.start) continue;
    if (event.t > end) break;
    if (
      event.kind !== "damage" ||
      event.amount < 0 ||
      !matchesCombatSide(actors.get(event.target), friendly, "enemies")
    )
      continue;
    const source = actors.get(event.source);
    const owner = source?.owner
      ? replay.actors.find((a) => a.type === "Player" && a.id === source.owner)
      : source;
    if (!owner || owner.type !== "Player" || !friendly.has(owner.id)) continue;
    totals.set(owner.key, (totals.get(owner.key) ?? 0) + event.amount);
  }
  return replay.actors
    .filter((a) => a.type === "Player" && friendly.has(a.id))
    .map((actor) => ({
      actor,
      damage: totals.get(actor.key) ?? 0,
      dps: elapsed > 0 ? (totals.get(actor.key) ?? 0) / elapsed : null,
    }));
}
