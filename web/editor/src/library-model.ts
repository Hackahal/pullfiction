import type { Fight, GameVersion, RawReplay } from "./types";
import { speedrunRules } from "./speedrun-rules";
import type { LocalProject } from "./project-store";

export interface RunSummary {
  bossesKilled: number;
  bossCount: number | null;
  clearTime: number | null;
  elapsed: number | null;
}
export function summarizeRun(raw: RawReplay, map: number): RunSummary {
  const version = raw.gameVersion ?? raw.report.gameVersion ?? "vanilla";
  const chapters = (raw.fight as Fight & { chapters?: Fight[] }).chapters;
  const fights = chapters ?? [raw.fight];
  const kills = fights.filter((f) => f.kill && Number(f.encounterID) > 0);
  const bossesKilled = new Set(kills.map((f) => f.encounterID)).size;
  const ruleCount = speedrunRules(version, map)?.bossCount;
  const eraCounts: Record<number, number> = {
    409: 10,
    249: 1,
    469: 8,
    531: 9,
    533: 15,
  };
  const bossCount =
    version === "sod" && map === 409
      ? raw.fight.difficulty === 5
        ? 11
        : raw.fight.difficulty === 3 || raw.fight.difficulty === 4
          ? 10
          : null
      : ruleCount && ruleCount > 0
        ? ruleCount
        : (eraCounts[map] ?? null);
  const start = raw.fight.startTime;
  const end = raw.fight.endTime;
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? end - start
      : null;
  const firstKills = new Map<number, number>();
  for (const f of kills)
    if (Number.isFinite(f.endTime))
      firstKills.set(
        f.encounterID!,
        Math.min(firstKills.get(f.encounterID!) ?? Infinity, f.endTime),
      );
  const lastKill = Math.max(...firstKills.values());
  return {
    bossesKilled,
    bossCount,
    elapsed,
    // This is recorded first-pull-to-last-boss time, not WCL's penalty-adjusted leaderboard score.
    clearTime:
      raw.fight.id === "run" &&
      !raw.fight.categoryMixed &&
      bossCount !== null &&
      bossesKilled === bossCount &&
      Number.isFinite(start) &&
      Number.isFinite(lastKill) &&
      lastKill > start
        ? lastKill - start
        : null,
  };
}
export function validRunSummary(s: RunSummary) {
  return (
    s &&
    Number.isSafeInteger(s.bossesKilled) &&
    s.bossesKilled >= 0 &&
    (s.bossCount === null ||
      (Number.isSafeInteger(s.bossCount) &&
        s.bossCount > 0 &&
        s.bossesKilled <= s.bossCount)) &&
    [s.clearTime, s.elapsed].every(
      (n) => n === null || (Number.isFinite(n) && n >= 0),
    ) &&
    (s.clearTime === null ||
      (s.bossCount !== null && s.bossesKilled === s.bossCount))
  );
}
export const isSavedRun = (p: LocalProject) =>
  p.kind === "replay" && p.savedRun !== false;
export function viewedProjects(projects: LocalProject[]) {
  return projects
    .filter((p) => !p.deletedAt && p.kind === "replay")
    .sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0));
}
export function relativeDate(at?: number, now = Date.now()) {
  if (at === undefined) return "Not recorded";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  const days = Math.floor(minutes / 1440);
  return days === 1
    ? "Yesterday"
    : days < 7
      ? `${days} days ago`
      : new Date(at).toLocaleDateString();
}
export const raidZoneImages: Record<number, number> = {
  409: 2000,
  249: 2001,
  469: 2002,
  309: 2003,
  509: 2004,
  531: 2005,
  533: 2006,
  48: 2007,
  90: 2008,
  109: 2009,
  2856: 2018,
};
export const wclHost = (v: GameVersion) =>
  v === "sod" ? "sod.warcraftlogs.com" : "vanilla.warcraftlogs.com";
