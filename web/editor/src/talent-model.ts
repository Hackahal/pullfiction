import type { Actor, Replay } from "./types";
import type { TalentCatalog, TalentTree } from "./local-talents";
export function classTalentTrees(
  catalog: TalentCatalog | null,
  classId: number,
): (TalentTree | undefined)[] {
  const matching =
    catalog?.trees.filter((tree) => tree.classId === classId) ?? [];
  const length = Math.min(
    12,
    Math.max(3, ...matching.map((tree) => tree.order + 1)),
  );
  return Array.from({ length }, (_, index) =>
    matching.find((tree) => tree.order === index),
  );
}
export interface RecordedTalentBuild {
  at: number;
  points: number[] | null;
  allocations: { talentId?: number; spellId?: number; rank: number }[];
}
const caches = new WeakMap<
  Replay,
  {
    events: unknown[];
    details: unknown;
    builds: Map<number, RecordedTalentBuild[]>;
  }
>();
function parseBuild(
  info: Record<string, any>,
  at: number,
): RecordedTalentBuild | null {
  const totals =
    Array.isArray(info.talents) &&
    info.talents.length === 3 &&
    info.talents.every(
      (t: any) =>
        t &&
        typeof t === "object" &&
        Number.isInteger(t.id) &&
        t.id >= 0 &&
        t.id <= 100 &&
        !("rank" in t) &&
        !("spellID" in t),
    );
  const allocations: RecordedTalentBuild["allocations"] = [];
  for (const t of [
    ...(Array.isArray(info.talentTree) ? info.talentTree : []),
    ...(totals ? [] : Array.isArray(info.talents) ? info.talents : []),
  ]) {
    if (!t || typeof t !== "object") continue;
    const rank = t.rank ?? t.points;
    const talentId = t.talentID ?? t.talentId,
      spellId = t.spellID ?? t.spellId;
    if (!Number.isInteger(rank) || rank < 0 || rank > 20) continue;
    // An unqualified `id` can mean a tree total or a modern trait node. Do not guess.
    if (Number.isInteger(talentId) && talentId > 0)
      allocations.push({ talentId, rank });
    else if (Number.isInteger(spellId) && spellId > 0)
      allocations.push({ spellId, rank });
  }
  return totals || allocations.length
    ? {
        at,
        points: totals ? info.talents.map((t: any) => t.id) : null,
        allocations,
      }
    : null;
}
export function recordedTalents(
  replay: Replay | null,
  actor: Actor,
  time: number,
): RecordedTalentBuild | null {
  if (!replay) return null;
  let cached = caches.get(replay);
  if (
    !cached ||
    cached.events !== replay.raw.events ||
    cached.details !== replay.raw.playerDetails
  ) {
    const builds = new Map<number, RecordedTalentBuild[]>();
    const details = Object.values(
      replay.raw.playerDetails?.data?.playerDetails ?? {},
    ).flat() as any[];
    for (const d of details) {
      if (!d || typeof d !== "object" || !Number.isInteger(d.id)) continue;
      const b = d.combatantInfo ? parseBuild(d.combatantInfo, 0) : null;
      if (b) builds.set(d.id, [b]);
    }
    for (const raw of replay.raw.events as Record<string, any>[]) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type !== "combatantinfo" || !Number.isInteger(raw.sourceID))
        continue;
      const at = raw.timestamp - replay.raw.fight.startTime;
      if (!Number.isFinite(at) || at < 0 || at > replay.duration) continue;
      const b = parseBuild(raw, at);
      if (b) builds.set(raw.sourceID, [...(builds.get(raw.sourceID) ?? []), b]);
    }
    for (const entries of builds.values()) entries.sort((a, b) => a.at - b.at);
    cached = {
      events: replay.raw.events,
      details: replay.raw.playerDetails,
      builds,
    };
    caches.set(replay, cached);
  }
  return (
    cached.builds
      .get(actor.id)
      ?.filter((b) => b.at <= time)
      .at(-1) ?? null
  );
}
