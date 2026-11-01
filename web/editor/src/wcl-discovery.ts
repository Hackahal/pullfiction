import { gameVersion } from "../../planner/game-versions.mjs";
import { raidForZone } from "../../planner/raids.mjs";
import {
  fetchSpeedCategory,
  type WclSpeedCategory,
} from "./speedrun-world-record";
import type { GameVersion } from "./types";
import type { GuildSearch, LogGuild, LogListing } from "./wcl-browser";
import { characterClass, factionName, type Faction } from "./identity-model";
export type DiscoveryQuery = (
  query: string,
  variables: Record<string, unknown>,
  version: string,
  signal?: AbortSignal,
) => Promise<any>;
export interface LogCharacter {
  id: number;
  name: string;
  classID: number;
  server: LogGuild["server"];
}
export interface RankingRaid extends WclSpeedCategory {
  map: number;
  name: string;
  encounters: { id: number; name: string }[];
}
export type RankingMetric = "speed" | "dps" | "hps";
export interface RankingSearch {
  encounter: number;
  metric: RankingMetric;
  partition: number;
  difficulty: number;
  size: number | null;
  region: string;
  className: string;
  page: number;
}
export interface RankingEntry {
  position: number | null;
  name: string;
  server: string;
  amount: number;
  reportCode: string | null;
  fightID: number | null;
  className?: string | null;
  faction?: Faction | null;
}
export const listingFields =
  "code title startTime endTime visibility zone{id name} owner{name} guild{name}";
const id = (n: unknown): n is number =>
  Number.isSafeInteger(n) && Number(n) > 0;
export async function findCharacter(
  query: DiscoveryQuery,
  search: GuildSearch,
  version: GameVersion,
  signal?: AbortSignal,
): Promise<LogCharacter> {
  gameVersion(version);
  if (
    !search.name.trim() ||
    search.name.trim().length > 100 ||
    !/^[\w-]{1,100}$/.test(search.realm) ||
    !/^(eu|us|kr|tw|cn)$/.test(search.region)
  )
    throw new Error("Enter the character name, realm and region.");
  const data = await query(
    "query($name:String!,$realm:String!,$region:String!){characterData{character(name:$name,serverSlug:$realm,serverRegion:$region){id name classID server{name slug region{slug}}}}}",
    { name: search.name.trim(), realm: search.realm, region: search.region },
    version,
    signal,
  );
  const c = data.characterData?.character;
  if (!c)
    throw new Error(
      "Character not found on this realm. Check the spelling, realm and game version.",
    );
  if (
    !id(c.id) ||
    typeof c.name !== "string" ||
    !c.name ||
    !id(c.classID) ||
    !c.server?.name ||
    !c.server?.slug ||
    !/^(eu|us|kr|tw|cn)$/.test(String(c.server.region?.slug).toLowerCase())
  )
    throw new Error("Invalid Warcraft Logs character.");
  return {
    id: c.id,
    name: c.name,
    classID: c.classID,
    server: {
      ...c.server,
      region: { slug: String(c.server.region.slug).toLowerCase() },
    },
  };
}
export async function characterReports(
  query: DiscoveryQuery,
  characterID: number,
  page: number,
  version: GameVersion,
  signal?: AbortSignal,
): Promise<{ data: LogListing[]; has_more_pages: boolean }> {
  if (!id(characterID) || !id(page))
    throw new Error("Invalid character report search.");
  const data = await query(
    `query($id:Int!,$page:Int!){characterData{character(id:$id){recentReports(limit:20,page:$page){data{${listingFields}} current_page has_more_pages}}}}`,
    { id: characterID, page },
    version,
    signal,
  );
  const result = data.characterData?.character?.recentReports;
  if (!Array.isArray(result?.data) || result.current_page !== page)
    throw new Error("Could not load character reports.");
  return result;
}
export async function rankingRaids(
  query: DiscoveryQuery,
  version: GameVersion,
  signal?: AbortSignal,
): Promise<RankingRaid[]> {
  const data = await query(
    "query{worldData{zones{id name encounters{id name} partitions{id name default} difficulties{id name sizes}}}}",
    {},
    version,
    signal,
  );
  if (!Array.isArray(data.worldData?.zones))
    throw new Error("Could not load WCL ranking categories.");
  return data.worldData.zones.flatMap((z: any) => {
    const raid = raidForZone({ name: z.name }, version);
    const partitions = (z.partitions ?? []).filter(
      (p: any) =>
        id(p.id) &&
        typeof p.name === "string" &&
        (version === "sod"
          ? /discovery/i.test(p.name)
          : !/hardcore|mastery|som|discovery/i.test(p.name)),
    );
    const difficulties = (z.difficulties ?? []).filter(
      (d: any) =>
        Number.isSafeInteger(d.id) &&
        d.id >= 0 &&
        typeof d.name === "string" &&
        Array.isArray(d.sizes) &&
        d.sizes.every(id),
    );
    if (!raid || !id(z.id) || !partitions.length || !difficulties.length)
      return [];
    return [
      {
        map: raid.map,
        name: raid.name,
        zoneID: z.id,
        encounterID: 0,
        partitions,
        difficulties,
        encounters: (z.encounters ?? []).filter(
          (e: any) => id(e.id) && typeof e.name === "string",
        ),
      },
    ];
  });
}
export async function rankingPage(
  query: DiscoveryQuery,
  search: RankingSearch,
  version: GameVersion,
  signal?: AbortSignal,
): Promise<{ entries: RankingEntry[]; more: boolean }> {
  gameVersion(version);
  if (
    !id(search.encounter) ||
    !id(search.partition) ||
    !id(search.page) ||
    !Number.isSafeInteger(search.difficulty) ||
    search.difficulty < 0 ||
    (search.size !== null && !id(search.size)) ||
    !["speed", "dps", "hps"].includes(search.metric) ||
    !/^$|^(eu|us|kr|tw|cn)$/.test(search.region) ||
    !/^$|^[A-Za-z]{1,40}$/.test(search.className)
  )
    throw new Error("Choose a valid ranking category.");
  const field =
    search.metric === "speed" ? "fightRankings" : "characterRankings";
  const metricType =
    search.metric === "speed"
      ? "FightRankingMetricType"
      : "CharacterRankingMetricType";
  const classDecl =
    search.metric === "speed" || !search.className ? "" : ",$className:String";
  const classArg =
    search.metric === "speed" || !search.className
      ? ""
      : ",className:$className";
  const data = await query(
    `query($encounter:Int!,$metric:${metricType}!,$partition:Int!,$difficulty:Int!,$size:Int,$region:String,$page:Int!${classDecl}){worldData{encounter(id:$encounter){${field}(metric:$metric,partition:$partition,difficulty:$difficulty,size:$size,serverRegion:$region,page:$page${classArg})}}}`,
    {
      ...search,
      region: search.region || null,
      className: search.className || null,
    },
    version,
    signal,
  );
  const result = data.worldData?.encounter?.[field];
  if (!Array.isArray(result?.rankings))
    throw new Error("WCL did not return a ranking list for this category.");
  const entries = result.rankings.map((r: any, index: number): RankingEntry => {
    const amount = search.metric === "speed" ? r.duration : r.amount;
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("WCL returned an invalid ranking value.");
    return {
      position: id(r.rank) ? r.rank : search.page === 1 ? index + 1 : null,
      name: String(
        (search.metric === "speed" ? (r.guild?.name ?? r.name) : r.name) ??
          "Unknown",
      ),
      server: String(r.server?.name ?? r.guild?.server?.name ?? ""),
      amount,
      reportCode:
        typeof r.report?.code === "string" &&
        /^[A-Za-z0-9]{16}$/.test(r.report.code)
          ? r.report.code
          : null,
      fightID: id(r.report?.fightID) ? r.report.fightID : null,
      className:
        search.metric === "speed"
          ? null
          : (characterClass(r.class) ??
            characterClass(r.classID) ??
            characterClass(r.type) ??
            characterClass(r.className)),
      faction: factionName(r.guild?.faction ?? r.faction),
    };
  });
  return {
    entries,
    more: result.hasMorePages === true || result.has_more_pages === true,
  };
}
export { fetchSpeedCategory };
