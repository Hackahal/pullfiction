import {
  fetchSpeedCategory,
  fetchSpeedWorldRecord,
  type WclSpeedCategory,
  type WclSpeedSelection,
} from "./speedrun-world-record";
import { gameVersion } from "../../planner/game-versions.mjs";
import { requireRaid, raidForZone } from "../../planner/raids.mjs";
import {
  REPORT_QUERY,
  collectEvents,
  fullRunFight,
} from "../../planner/wcl-report.mjs";
import { WclSession } from "./wcl-auth";
import type { RawReplay } from "./types";

export const REPLAY_STATE_FILTER = [
  "zonechange",
  "combatantinfo",
  "begincast",
  "cast",
  "interrupt",
  "summon",
  "create",
  "death",
  "destroy",
  "resurrect",
  "applybuff",
  "applydebuff",
  "applybuffstack",
  "applydebuffstack",
  "refreshbuff",
  "refreshdebuff",
  "removebuff",
  "removedebuff",
  "removebuffstack",
  "removedebuffstack",
]
  .map((type) => `type = '${type}'`)
  .join(" OR ");

type Progress = { pages: number; events: number; time: number; end: number };
type Options = {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};
type Query = (
  query: string,
  variables: Record<string, unknown>,
  version: string,
  signal?: AbortSignal,
) => Promise<any>;

export interface LogListing {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  visibility: string;
  zone: { id: number; name: string } | null;
  owner: { name: string } | null;
  guild: { name: string } | null;
}
export interface LogAccount {
  id: number;
  name: string;
  guilds: { id: number; name: string; server?: { name: string } }[];
}
export interface ReportSearch {
  guildID?: number;
  userID?: number;
  guildName?: string;
  guildServerSlug?: string;
  guildServerRegion?: string;
  page?: number;
  startTime?: number;
  endTime?: number;
  zoneID?: number;
}
export interface GuildSearch {
  name: string;
  realm: string;
  region: string;
}
export interface LogGuild {
  id: number;
  name: string;
  server: { name: string; slug: string; region: { slug: string } };
}
export interface LogZone {
  id: number;
  name: string;
}
export interface LogRealm {
  id: number;
  name: string;
  slug: string;
  seasonID: number;
}

export function browserQuery(
  session: Pick<WclSession, "accessToken" | "disconnect">,
  request: typeof fetch = fetch,
): Query {
  return async (query, variables, version, signal) => {
    const host = gameVersion(version).host;
    const token = await session.accessToken(signal);
    signal?.throwIfAborted();
    const response = await request(`https://${host}/api/v2/user`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
    });
    if (response.status === 401) session.disconnect();
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Warcraft Logs rate limit reached. Try again later."
          : `Warcraft Logs returned HTTP ${response.status}.`,
      );
    const data = await response.json();
    if (data.errors?.length)
      throw new Error(
        data.errors.map((e: { message: string }) => e.message).join("; "),
      );
    const report = data.data?.reportData?.report;
    if (!data.data)
      throw new Error(
        "Report not found or not accessible to your Warcraft Logs account.",
      );
    if (Object.hasOwn(data.data.reportData ?? {}, "report") && !report)
      throw new Error(
        "Report not found or not accessible to your Warcraft Logs account.",
      );
    return report ?? data.data;
  };
}

// The browser importer returns the portable raw replay contract used by replay.mjs.
// All events/resources remain intact for the existing normalizeReplay/enrichCombat pipeline.
export class BrowserLogs {
  private realmCache = new Map<string, LogRealm[]>();
  constructor(private query: Query) {}
  speedCategory(version: "vanilla" | "sod", map: number, signal?: AbortSignal) {
    return fetchSpeedCategory(this.query, version, map, signal);
  }
  speedWorldRecord(
    version: "vanilla" | "sod",
    map: number,
    category: WclSpeedCategory,
    selection: WclSpeedSelection,
    signal?: AbortSignal,
  ) {
    return fetchSpeedWorldRecord(
      this.query,
      version,
      map,
      category,
      selection,
      signal,
    );
  }
  async realms(
    region: string,
    version = "vanilla",
    signal?: AbortSignal,
  ): Promise<LogRealm[]> {
    gameVersion(version);
    const slug = region.toLowerCase();
    if (!/^(eu|us|kr|tw|cn)$/.test(slug))
      throw new Error("Choose a valid region.");
    signal?.throwIfAborted();
    const key = `${version}:${slug}`;
    const cached = this.realmCache.get(key);
    if (cached) return cached;
    const data = await this.query(
      "query{worldData{regions{id slug}}}",
      {},
      version,
      signal,
    );
    const selected = data.worldData?.regions?.find(
      (r: { id: number; slug: string }) => r.slug?.toLowerCase() === slug,
    );
    if (!Number.isSafeInteger(selected?.id))
      throw new Error("This region is unavailable on Warcraft Logs.");
    const realms: LogRealm[] = [];
    for (let page = 1; page <= 50; page++) {
      signal?.throwIfAborted();
      const response = await this.query(
        "query($region:Int!,$page:Int!){worldData{region(id:$region){servers(limit:100,page:$page){data{id name slug seasonID} current_page has_more_pages}}}}",
        { region: selected.id, page },
        version,
        signal,
      );
      const result = response.worldData?.region?.servers;
      if (
        !Array.isArray(result?.data) ||
        result.current_page !== page ||
        result.data.some(
          (r: LogRealm) =>
            !Number.isSafeInteger(r?.id) ||
            r.id < 1 ||
            typeof r.name !== "string" ||
            typeof r.slug !== "string" ||
            !r.slug ||
            !Number.isInteger(r.seasonID),
        )
      )
        throw new Error("Could not load realms from Warcraft Logs.");
      realms.push(...result.data);
      if (!result.has_more_pages) {
        // Blizzard/WCL season 3 is Season of Discovery. The catalogue is
        // shared by both hosts; Era also includes Hardcore and legacy seasons.
        const filtered = realms.filter((r) =>
          version === "sod" ? r.seasonID === 3 : r.seasonID !== 3,
        );
        const unique = [
          ...new Map(filtered.map((r) => [r.slug, r])).values(),
        ].sort((a, b) => a.name.localeCompare(b.name));
        signal?.throwIfAborted();
        this.realmCache.set(key, unique);
        return unique;
      }
    }
    throw new Error("Warcraft Logs returned too many realm pages.");
  }
  async guild(
    search: GuildSearch,
    version = "vanilla",
    signal?: AbortSignal,
  ): Promise<LogGuild> {
    gameVersion(version);
    const name = search.name.trim();
    const serverSlug = search.realm
      .trim()
      .toLowerCase()
      .replaceAll("'", "")
      .replace(/\s+/g, "-");
    const serverRegion = search.region.toLowerCase();
    if (
      !name ||
      name.length > 100 ||
      !serverSlug ||
      serverSlug.length > 100 ||
      !/^(eu|us|kr|tw|cn)$/.test(serverRegion)
    )
      throw new Error("Enter the guild name, realm and region.");
    const data = await this.query(
      "query($name:String!,$serverSlug:String!,$serverRegion:String!){guildData{guild(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){id name server{name slug region{slug}}}}}",
      { name, serverSlug, serverRegion },
      version,
      signal,
    );
    const guild = data.guildData?.guild;
    if (!guild)
      throw new Error(
        "Guild not found. Check its full name, realm, region and game version.",
      );
    if (
      !Number.isSafeInteger(guild.id) ||
      guild.id < 1 ||
      !guild.name ||
      !guild.server?.name ||
      !guild.server?.slug ||
      !guild.server?.region?.slug
    )
      throw new Error("Invalid Warcraft Logs guild result.");
    const region = String(guild.server.region.slug).toLowerCase();
    if (!/^(eu|us|kr|tw|cn)$/.test(region))
      throw new Error("Invalid Warcraft Logs guild region.");
    return { ...guild, server: { ...guild.server, region: { slug: region } } };
  }
  async zones(version = "vanilla", signal?: AbortSignal): Promise<LogZone[]> {
    gameVersion(version);
    const data = await this.query(
      "query{worldData{zones{id name partitions{name}}}}",
      {},
      version,
      signal,
    );
    const zones = data.worldData?.zones;
    if (
      !Array.isArray(zones) ||
      zones.some(
        (z: LogZone) =>
          !Number.isSafeInteger(z?.id) ||
          z.id < 1 ||
          typeof z.name !== "string",
      )
    )
      throw new Error("Could not load raid filters from Warcraft Logs.");
    // The Era and SoD hosts share a zone catalogue. The catalogue's season
    // labels distinguish otherwise identical names without guessing zone IDs.
    return zones
      .filter((z: LogZone & { partitions?: { name: string }[] }) => {
        const discovery = (z.partitions ?? []).some((p) =>
          /\bdiscovery\b/i.test(p.name),
        );
        return version === "sod" ? discovery : !discovery;
      })
      .map(({ id, name }: LogZone) => ({ id, name }))
      .sort((a: LogZone, b: LogZone) => a.name.localeCompare(b.name));
  }
  async account(
    version = "vanilla",
    signal?: AbortSignal,
  ): Promise<LogAccount> {
    const data = await this.query(
      "query{userData{currentUser{id name guilds{id name server{name}}}}}",
      {},
      version,
      signal,
    );
    const user = data.userData?.currentUser;
    if (!user || !Number.isSafeInteger(user.id))
      throw new Error(
        "Your Warcraft Logs profile is unavailable. Reconnect or browse a guild instead.",
      );
    return { ...user, guilds: user.guilds ?? [] };
  }
  async reports(
    search: ReportSearch,
    version = "vanilla",
    signal?: AbortSignal,
  ): Promise<{
    data: LogListing[];
    current_page: number;
    has_more_pages: boolean;
  }> {
    gameVersion(version);
    const page = search.page ?? 1;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      [search.guildID, search.userID, search.zoneID].some(
        (v) => v !== undefined && (!Number.isSafeInteger(v) || v < 1),
      ) ||
      [search.startTime, search.endTime].some(
        (v) => v !== undefined && (!Number.isFinite(v) || v < 0),
      ) ||
      (search.startTime !== undefined &&
        search.endTime !== undefined &&
        search.endTime < search.startTime)
    )
      throw new Error("Invalid report search");
    if (
      !search.guildID &&
      !search.userID &&
      !(
        search.guildName?.trim() &&
        search.guildServerSlug?.trim() &&
        /^(eu|us|kr|tw|cn)$/i.test(search.guildServerRegion ?? "")
      )
    )
      throw new Error(
        "Choose your reports or enter a guild with its realm and region.",
      );
    const data = await this.query(
      `query($guildID:Int,$userID:Int,$guildName:String,$guildServerSlug:String,$guildServerRegion:String,$page:Int!,$startTime:Float,$endTime:Float,$zoneID:Int){reportData{reports(guildID:$guildID,userID:$userID,guildName:$guildName,guildServerSlug:$guildServerSlug,guildServerRegion:$guildServerRegion,page:$page,limit:20,startTime:$startTime,endTime:$endTime,zoneID:$zoneID){data{code title startTime endTime visibility zone{id name} owner{name} guild{name}} current_page has_more_pages}}}`,
      { ...search, page },
      version,
      signal,
    );
    const result = data.reportData?.reports;
    if (
      !result ||
      !Array.isArray(result.data) ||
      !Number.isSafeInteger(result.current_page)
    )
      throw new Error("Invalid Warcraft Logs report listing");
    return result;
  }
  async report(code: string, version = "vanilla", options: Options = {}) {
    gameVersion(version);
    if (!/^[A-Za-z0-9]{16}$/.test(code))
      throw new Error("Enter a valid Warcraft Logs report code.");
    const report = await this.query(
      REPORT_QUERY,
      { code },
      version,
      options.signal,
    );
    if (
      !Array.isArray(report.fights) ||
      !Array.isArray(report.masterData?.actors)
    )
      throw new Error("Invalid Warcraft Logs report.");
    return { ...report, gameVersion: version };
  }
  async replayHeader(
    code: string,
    id: number | "run",
    version = "vanilla",
    map?: number,
    options: Options = {},
  ): Promise<RawReplay> {
    const report = await this.report(code, version, options);
    const fight =
      id === "run"
        ? fullRunFight(report, map)
        : report.fights.find((f: any) => f.id === id);
    if (!fight) throw new Error("Encounter not found in this report.");
    const raid = requireRaid(fight.gameZone, version);
    const fights = id === "run" ? fight.chapters.map((f: any) => f.id) : [id];
    const detail = await this.query(
      `query($code:String!,$fights:[Int]!){reportData{report(code:$code){playerDetails(fightIDs:$fights,includeCombatantInfo:true) masterData{actors{id name type subType gameID petOwner icon server} abilities{gameID name icon type}}}}}`,
      { code, fights },
      version,
      options.signal,
    );
    return {
      gameVersion: version as RawReplay["gameVersion"],
      report: {
        code,
        title: report.title,
        gameVersion: version as RawReplay["gameVersion"],
      },
      fight,
      actors: detail.masterData?.actors ?? report.masterData.actors,
      abilities: detail.masterData?.abilities ?? [],
      playerDetails: detail.playerDetails,
      models: {},
      events: [],
      stream: {
        version: 1,
        id: crypto.randomUUID(),
        revision: report.revision,
        segments: report.segments,
        reportEnd: report.endTime,
        full: [],
        history: [],
        stateEvents: [],
        contextEvents: [],
        foreign:
          id === "run"
            ? report.fights
                .filter(
                  (f: any) =>
                    !f.completeRaid &&
                    raidForZone(f.gameZone, version) &&
                    raidForZone(f.gameZone, version)?.map !== raid.map,
                )
                .map((f: any) => [
                  f.startTime - fight.startTime,
                  f.endTime - fight.startTime,
                ])
            : [],
      },
    };
  }
  async verifyReplayRevision(raw: RawReplay, signal?: AbortSignal) {
    const report = await this.query(
      "query($code:String!){reportData{report(code:$code){revision segments endTime}}}",
      { code: raw.report.code },
      raw.gameVersion ?? "vanilla",
      signal,
    );
    if (
      report.revision !== raw.stream?.revision ||
      report.segments !== raw.stream?.segments ||
      report.endTime !== raw.stream?.reportEnd
    )
      throw new Error(
        "This report has changed on Warcraft Logs. Reload its source log before downloading more sections.",
      );
  }
  async replayRange(
    raw: RawReplay,
    start: number,
    end: number,
    stateOnly: boolean,
    options: Options = {},
  ) {
    const duration = raw.fight.endTime - raw.fight.startTime;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > duration ||
      end <= start
    )
      throw new Error("Invalid replay section.");
    const single = raw.fight.id !== "run";
    const events = await collectEvents(
      async (cursor: number) =>
        (
          await this.query(
            `query($code:String!,$start:Float!,$end:Float!,$filter:String${single ? ",$fight:Int!" : ""}){reportData{report(code:$code){events(${single ? "fightIDs:[$fight]," : ""}startTime:$start,endTime:$end,filterExpression:$filter,includeResources:true,limit:10000){data nextPageTimestamp}}}}`,
            {
              code: raw.report.code,
              start: cursor,
              end: raw.fight.startTime + end,
              filter: stateOnly ? REPLAY_STATE_FILTER : null,
              ...(single ? { fight: Number(raw.fight.id) } : {}),
            },
            raw.gameVersion ?? "vanilla",
            options.signal,
          )
        ).events,
      raw.fight.startTime + start,
      raw.fight.startTime + end,
      options,
    );
    return events.filter(
      (e: any) =>
        Number.isFinite(e.timestamp) &&
        e.timestamp >= raw.fight.startTime + start &&
        e.timestamp <= raw.fight.startTime + end &&
        !(raw.stream?.foreign ?? []).some(
          ([a, b]) =>
            e.timestamp - raw.fight.startTime >= a &&
            e.timestamp - raw.fight.startTime <= b,
        ),
    );
  }
  async replay(
    code: string,
    id: number | "run",
    version = "vanilla",
    map?: number,
    options: Options = {},
  ) {
    if (id !== "run" && (!Number.isInteger(id) || id < 1))
      throw new Error("Choose a valid encounter.");
    const report = await this.report(code, version, options);
    const fight =
      id === "run"
        ? fullRunFight(report, map)
        : report.fights.find((f: { id: number }) => f.id === id);
    if (!fight) throw new Error("Encounter not found in this report.");
    const raid = requireRaid(fight.gameZone, version);
    const variables = id === "run" ? { code } : { code, fight: id };
    const selection = id === "run" ? "" : "fightIDs:[$fight],";
    const declaration = id === "run" ? "" : ",$fight:Int!";
    const events = await collectEvents(
      async (start: number) =>
        (
          await this.query(
            `query($code:String!,$start:Float!,$end:Float!${declaration}){reportData{report(code:$code){events(${selection}startTime:$start,endTime:$end,includeResources:true,limit:10000){data nextPageTimestamp}}}}`,
            { ...variables, start, end: fight.endTime },
            version,
            options.signal,
          )
        ).events,
      fight.startTime,
      fight.endTime,
      options,
    );
    options.signal?.throwIfAborted();
    const fights =
      id === "run" ? fight.chapters.map((f: { id: number }) => f.id) : [id];
    const detail = await this.query(
      `query($code:String!,$fights:[Int]!){reportData{report(code:$code){
      playerDetails(fightIDs:$fights,includeCombatantInfo:true)
      masterData{actors{id name type subType gameID petOwner icon server} abilities{gameID name icon type}}
    }}}`,
      { code, fights },
      version,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const foreign =
      id === "run"
        ? report.fights.filter((f: any) => {
            const other = raidForZone(f.gameZone, version);
            return !f.completeRaid && other && other.map !== raid.map;
          })
        : [];
    return {
      gameVersion: version,
      report: { code, title: report.title, gameVersion: version },
      fight,
      actors: detail.masterData?.actors ?? report.masterData.actors,
      abilities: detail.masterData?.abilities ?? [],
      playerDetails: detail.playerDetails,
      // Missing NPC-entry/display associations stay unresolved. Never scrape or proxy game art.
      models: {},
      events: foreign.length
        ? events.filter(
            (e: any) =>
              !foreign.some(
                (f: any) =>
                  e.timestamp >= f.startTime && e.timestamp <= f.endTime,
              ),
          )
        : events,
    };
  }
}
