import { gameVersion } from "../../planner/game-versions.mjs";
import { raidByMap, raidForZone } from "../../planner/raids.mjs";
import type { Chapter, GameVersion } from "./types";

export type WclSpeedCategory = {
  zoneID: number;
  encounterID: number;
  partitions: { id: number; name: string; default: boolean }[];
  difficulties: { id: number; name: string; sizes: number[] }[];
};
export type WclSpeedSelection = {
  partition: number;
  difficulty: number;
  size: number | null;
  skips: boolean;
};
export type SpeedrunWorldRecord = {
  guild: string;
  duration: number;
  reportCode: string;
  fightID: number | null;
  url: string;
  leaderboardUrl: string;
  fetchedAt: number;
  category: WclSpeedSelection;
  splits: Chapter[];
  splitNote: string | null;
};
type Query = (
  query: string,
  variables: Record<string, unknown>,
  version: string,
  signal?: AbortSignal,
) => Promise<any>;
const validID = (n: unknown): n is number =>
  Number.isSafeInteger(n) && Number(n) > 0;

// WCL keeps full-raid encounters in separate API-only zones. These IDs were
// verified against the official leaderboards and authenticated catalogue.
const completeRaidZones: Record<string, Record<number, number>> = {
  vanilla: { 409: 2500, 469: 2500, 531: 2500, 533: 2500 },
  sod: {
    48: 2501,
    90: 2502,
    109: 2503,
    409: 2504,
    469: 2505,
    531: 2508,
    533: 2509,
    2856: 2510,
  },
};

export async function fetchSpeedCategory(
  query: Query,
  version: GameVersion,
  map: number,
  signal?: AbortSignal,
): Promise<WclSpeedCategory> {
  const raid = raidByMap(map, version);
  if (!raid) throw new Error("Unsupported speedrun raid.");
  const completeZone = completeRaidZones[version]?.[map];
  if (!completeZone)
    throw new Error(
      "WCL does not expose a Complete Raids API category for this raid.",
    );
  const data = await query(
    "query($completeZone:Int!){worldData{zones{id name partitions{id name default} difficulties{id name sizes}} completeRaids:zone(id:$completeZone){encounters{id name}}}}",
    { completeZone },
    version,
    signal,
  );
  const zones = data.worldData?.zones;
  if (!Array.isArray(zones))
    throw new Error("WCL did not return the raid catalogue.");
  const zone = zones.find(
    (z: any) =>
      raidForZone({ name: z.name }, version)?.map === map &&
      Array.isArray(z.partitions) &&
      z.partitions.some((p: any) => /\bdiscovery\b/i.test(p.name)) ===
        (version === "sod"),
  );
  if (!zone || !validID(zone.id))
    throw new Error("WCL has no speedrun category for this raid/version.");
  const encounter = data.worldData?.completeRaids?.encounters?.find(
    (e: any) => raidForZone({ name: e.name }, version)?.map === map,
  );
  if (!validID(encounter?.id))
    throw new Error(
      "WCL does not publish a Complete Raids leaderboard for this raid.",
    );
  const partitions = zone.partitions.filter(
    (p: any) =>
      validID(p.id) &&
      typeof p.name === "string" &&
      (version === "sod"
        ? /\bdiscovery\b/i.test(p.name)
        : !/\b(hardcore|mastery|som|discovery)\b/i.test(p.name)),
  );
  const difficulties = (zone.difficulties ?? []).filter(
    (d: any) =>
      Number.isSafeInteger(d.id) &&
      d.id >= 0 &&
      typeof d.name === "string" &&
      Array.isArray(d.sizes) &&
      d.sizes.every(validID),
  );
  if (!partitions.length || !difficulties.length)
    throw new Error("WCL returned no compatible ranking categories.");
  return {
    zoneID: zone.id,
    encounterID: encounter.id,
    partitions,
    difficulties,
  };
}
export function defaultSpeedSelection(
  category: WclSpeedCategory,
): WclSpeedSelection {
  const partition =
    category.partitions.find((p) => p.default) ??
    category.partitions.find((p) => p.name === "S0") ??
    category.partitions.at(-1)!;
  const difficulty = category.difficulties.at(-1)!;
  return {
    partition: partition.id,
    difficulty: difficulty.id,
    size: difficulty.sizes[0] ?? null,
    skips: false,
  };
}

export async function fetchSpeedWorldRecord(
  query: Query,
  version: GameVersion,
  map: number,
  category: WclSpeedCategory,
  selection: WclSpeedSelection,
  signal?: AbortSignal,
): Promise<SpeedrunWorldRecord | null> {
  // WCL's advanced filter ignores the website's allowskips parameter. Returning
  // the default leaderboard here would silently compare against another category.
  if (version === "vanilla" && selection.skips)
    throw new Error(
      "WCL's API cannot verify the With skips leaderboard. Choose Without skips or open Warcraft Logs.",
    );
  const difficulty = category.difficulties.find(
    (d) => d.id === selection.difficulty,
  );
  if (
    !category.partitions.some((p) => p.id === selection.partition) ||
    !difficulty ||
    (difficulty.sizes.length
      ? !difficulty.sizes.includes(selection.size!)
      : selection.size !== null)
  )
    throw new Error("Choose a valid WCL speedrun category.");
  const data = await query(
    "query($encounter:Int!,$partition:Int!,$difficulty:Int!,$size:Int){worldData{encounter(id:$encounter){fightRankings(metric:speed,page:1,partition:$partition,difficulty:$difficulty,size:$size)}}}",
    {
      encounter: category.encounterID,
      partition: selection.partition,
      difficulty: selection.difficulty,
      size: selection.size,
    },
    version,
    signal,
  );
  const result = data.worldData?.encounter?.fightRankings;
  if (!Array.isArray(result?.rankings))
    throw new Error("WCL returned an invalid speed leaderboard.");
  if (!result.rankings.length) return null;
  // WCL returns page one in rank order. Never substitute a lower ranked entry
  // when the winning entry is malformed or its log cannot be opened.
  const winner = result.rankings[0];
  const duration = winner.duration;
  const reportCode = winner.report?.code;
  const fightID = Number.isSafeInteger(winner.report?.fightID)
    ? winner.report.fightID
    : null;
  const rankingBounds =
    Number.isFinite(winner.report?.startTime) &&
    Number.isFinite(winner.report?.endTime) &&
    winner.report.startTime >= 0 &&
    winner.report.endTime > winner.report.startTime
      ? {
          startTime: winner.report.startTime as number,
          endTime: winner.report.endTime as number,
        }
      : null;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof reportCode !== "string" ||
    !/^[A-Za-z0-9]{16}$/.test(reportCode)
  )
    throw new Error("The WCL world-record entry has no usable time or report.");
  const host = gameVersion(version).host;
  const record: SpeedrunWorldRecord = {
    guild:
      typeof winner.guild?.name === "string" ? winner.guild.name : "World #1",
    duration,
    reportCode,
    fightID,
    url: rankingBounds
      ? `https://${host}/reports/${reportCode}?boss=-3&start=${rankingBounds.startTime}&end=${rankingBounds.endTime}&type=summary`
      : `https://${host}/reports/${reportCode}${fightID === null ? "" : `#fight=${fightID}&type=summary`}`,
    leaderboardUrl: `https://${host}/zone/rankings/${category.zoneID}?metric=speed&partition=${selection.partition}&difficulty=${selection.difficulty}${selection.size === null ? "" : `&size=${selection.size}`}${version === "vanilla" ? `&allowskips=${selection.skips ? 1 : 0}` : ""}`,
    fetchedAt: Date.now(),
    category: { ...selection },
    splits: [],
    splitNote: null,
  };
  try {
    const report = await query(
      "query($code:String!){reportData{report(code:$code){code fights{id name encounterID startTime endTime kill completeRaid gameZone{id name}}}}}",
      { code: reportCode },
      version,
      signal,
    );
    if (!Array.isArray(report.fights))
      throw new Error("WCL did not return reference fights.");
    const run =
      rankingBounds ??
      report.fights.find(
        (f: any) =>
          f.id === fightID &&
          f.completeRaid &&
          raidForZone(f.gameZone, version)?.map === map,
      );
    const reportEnd = Math.max(
      0,
      ...report.fights.map((f: any) =>
        Number.isFinite(f.endTime) ? f.endTime : 0,
      ),
    );
    if (
      !run ||
      run.endTime > reportEnd ||
      !Number.isFinite(run.startTime) ||
      !Number.isFinite(run.endTime) ||
      run.endTime <= run.startTime
    )
      throw new Error(
        "WCL did not expose the winning run's exact start/end. Total WR time is available; split comparison is unavailable.",
      );
    record.splits = report.fights
      .filter(
        (f: any) =>
          !f.completeRaid &&
          f.encounterID > 0 &&
          f.kill === true &&
          f.startTime >= run.startTime &&
          f.endTime <= run.endTime &&
          f.endTime > f.startTime &&
          raidForZone(f.gameZone, version)?.map === map,
      )
      .sort((a: any, b: any) => a.startTime - b.startTime)
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        encounterID: f.encounterID,
        kill: true,
        start: f.startTime - run.startTime,
        end: f.endTime - run.startTime,
      }));
    if (!record.splits.length)
      record.splitNote =
        "No boss splits are exposed for this world-record run.";
  } catch (error) {
    signal?.throwIfAborted();
    record.splitNote =
      error instanceof Error
        ? error.message
        : "The world-record log could not be loaded.";
  }
  return record;
}
