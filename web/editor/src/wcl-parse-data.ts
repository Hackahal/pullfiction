import type { GameVersion } from "./types";
import {
  predictionSupported,
  type ParseData,
  type ParseEncounter,
  type ParseOptions,
  type ParseReference,
  type ParseThreshold,
  type RankedPlayer,
} from "./playback-parses";

type Query = (
  query: string,
  variables: Record<string, unknown>,
  version: string,
  signal?: AbortSignal,
) => Promise<any>;
const positive = (n: unknown): n is number =>
  Number.isSafeInteger(n) && Number(n) > 0;
const percent = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
const PAGE_SIZE = 100;

type Category = {
  encounter: number;
  partition: number;
  difficulty: number;
  size: number;
};

/** Public leaderboard curves only. Final report results are never cached across accounts. */
export class WclParseData {
  private curves = new Map<string, { curve: ParseThreshold[]; at: number }>();
  constructor(
    private query: Query,
    private now = Date.now,
  ) {}
  clear() {
    this.curves.clear();
  }

  async load(
    code: string,
    encounter: ParseEncounter,
    version: GameVersion,
    options: ParseOptions,
    signal?: AbortSignal,
    selected?: { name: string; className: string },
  ): Promise<ParseData> {
    if (
      !/^[a-zA-Z0-9]{16}$/.test(code) ||
      !positive(encounter.id) ||
      !positive(encounter.encounterID)
    )
      throw new Error("Load a ranked Warcraft Logs boss fight.");
    const response = await this.query(
      "query($code:String!,$fight:Int!,$compare:RankingCompareType!,$timeframe:RankingTimeframeType!){reportData{report(code:$code){rankings(fightIDs:[$fight],playerMetric:dps,compare:$compare,timeframe:$timeframe)}}}",
      {
        code,
        fight: encounter.id,
        compare: options.compare,
        timeframe: options.timeframe,
      },
      version,
      signal,
    );
    signal?.throwIfAborted();
    const fights = response.rankings?.data;
    if (!Array.isArray(fights))
      throw new Error("WCL did not return ranking data for this fight.");
    const fight = fights.find((f: any) => f.fightID === encounter.id);
    if (!fight)
      throw new Error(
        "WCL has no rankings for this pull. Wipes and unranked fights cannot be compared.",
      );
    if (
      fight.encounter?.id !== encounter.encounterID ||
      fight.kill !== 1 ||
      !positive(fight.partition) ||
      !Number.isSafeInteger(fight.difficulty) ||
      fight.difficulty < 0 ||
      !positive(fight.size)
    )
      throw new Error(
        "WCL returned a different or unsupported ranking category.",
      );
    const category: Category = {
      encounter: encounter.encounterID,
      partition: fight.partition,
      difficulty: fight.difficulty,
      size: fight.size,
    };
    const references: ParseReference[] = [];
    for (const [role, value] of Object.entries(fight.roles ?? {})) {
      const characters = (value as any)?.characters;
      if (!Array.isArray(characters)) continue;
      for (const c of characters) {
        if (
          typeof c.name !== "string" ||
          typeof c.class !== "string" ||
          typeof c.spec !== "string"
        )
          continue;
        const player: RankedPlayer = {
          name: c.name,
          className: c.class,
          spec: c.spec,
          server: typeof c.server?.name === "string" ? c.server.name : "",
          role,
          amount: c.amount,
          percentile: percent(c.rankPercent),
          bracketPercentile: percent(c.bracketPercent),
          bracket: positive(c.bracket) ? c.bracket : null,
          population: positive(c.totalParses) ? c.totalParses : 0,
        };
        references.push({
          player,
          curve: null,
          note:
            role === "healers"
              ? "WCL ranks healer roles on healing; a damage prediction is unavailable."
              : !predictionSupported(options)
                ? "Playback predictions currently support Today + Rankings. The selected WCL result is available at the end of the fight."
                : null,
        });
      }
    }
    // Bound concurrency and reuse a spec's curve for all players with the same bracket.
    const pending = new Map<string, Promise<ParseThreshold[]>>();
    const candidates = references.filter(
      (r) =>
        !r.note &&
        (!selected ||
          (r.player.name === selected.name &&
            r.player.className === selected.className)),
    );
    let rateError: string | null = null;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, candidates.length) }, async () => {
        while (cursor < candidates.length) {
          signal?.throwIfAborted();
          const reference = candidates[cursor++];
          if (rateError) {
            reference.note = rateError;
            continue;
          }
          const bracket =
            options.bracket === "itemLevel" ? reference.player.bracket : null;
          if (options.bracket === "itemLevel" && bracket === null) {
            reference.note = "WCL has no item-level bracket for this player.";
            continue;
          }
          const key = JSON.stringify([
            version,
            category,
            reference.player.className,
            reference.player.spec,
            bracket,
            reference.player.population,
          ]);
          try {
            let operation = pending.get(key);
            if (!operation) {
              operation = this.curve(
                version,
                category,
                reference.player,
                bracket,
                key,
                signal,
              );
              pending.set(key, operation);
            }
            reference.curve = await operation;
          } catch (error) {
            signal?.throwIfAborted();
            if (/database points|rate limit|429/i.test(String(error)))
              rateError =
                "WCL API allowance reached. Try again after the hourly reset.";
            reference.note =
              rateError ??
              (error instanceof Error
                ? error.message
                : "WCL comparison data is unavailable.");
          }
        }
      }),
    );
    return { references, fetchedAt: this.now() };
  }

  private async curve(
    version: GameVersion,
    category: Category,
    player: RankedPlayer,
    bracket: number | null,
    key: string,
    signal?: AbortSignal,
  ): Promise<ParseThreshold[]> {
    const cached = this.curves.get(key);
    if (cached && this.now() - cached.at < 15 * 60 * 1000) return cached.curve;
    if (player.population < 2)
      throw new Error("Too few ranked players to estimate a percentile.");
    const pages = new Map<number, any[]>();
    const more = new Map<number, boolean>();
    const read = async (page: number) => {
      if (pages.has(page)) return pages.get(page)!;
      const data = await this.query(
        "query($encounter:Int!,$partition:Int!,$difficulty:Int!,$size:Int!,$className:String!,$specName:String!,$bracket:Int,$page:Int!){worldData{encounter(id:$encounter){characterRankings(partition:$partition,difficulty:$difficulty,size:$size,className:$className,specName:$specName,bracket:$bracket,metric:dps,page:$page)}}}",
        {
          ...category,
          className: player.className,
          specName: player.spec,
          bracket,
          page,
        },
        version,
        signal,
      );
      signal?.throwIfAborted();
      const result = data.worldData?.encounter?.characterRankings;
      if (
        !result ||
        result.page !== page ||
        !Array.isArray(result.rankings) ||
        result.count !== result.rankings.length ||
        result.rankings.length > PAGE_SIZE ||
        typeof result.hasMorePages !== "boolean" ||
        (result.hasMorePages && result.rankings.length !== PAGE_SIZE)
      )
        throw new Error("WCL returned an incomplete ranking page.");
      const rows = result.rankings;
      // Row size is actual attendance, not the ranking category size. WCL
      // legitimately includes 18/19-player kills in the 20-player SoD category.
      if (
        rows.some(
          (r: any, i: number) =>
            r.class !== player.className ||
            r.spec !== player.spec ||
            typeof r.amount !== "number" ||
            !Number.isFinite(r.amount) ||
            r.amount < 0 ||
            (i > 0 && r.amount > rows[i - 1].amount),
        )
      )
        throw new Error("WCL returned a different ranking category.");
      pages.set(page, rows);
      more.set(page, result.hasMorePages);
      return rows;
    };
    const first = await read(1);
    if (first.length < 2)
      throw new Error("Too few ranked players to estimate a percentile.");
    let lastPage = Math.ceil(player.population / PAGE_SIZE);
    if (bracket !== null) {
      // A bracket is a subset of the overall population. Discover its final page
      // rather than using the overall denominator for an item-level percentile.
      let lo = 1,
        hi = lastPage;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((await read(mid)).length) lo = mid;
        else hi = mid - 1;
      }
      lastPage = lo;
    }
    const last = await read(lastPage);
    const population = (lastPage - 1) * PAGE_SIZE + last.length;
    if (
      population < 2 ||
      !last.length ||
      (bracket === null && population !== player.population)
    )
      throw new Error(
        "WCL's ranking population changed. Refresh the comparison.",
      );
    // The terminal page must end the leaderboard. A stale report count must
    // not make a partial list look like a full percentile distribution.
    if (more.get(lastPage))
      throw new Error(
        "WCL's ranking population changed. Refresh the comparison.",
      );
    for (const fraction of [0.25, 0.5, 0.75])
      await read(Math.max(1, Math.ceil(lastPage * fraction)));
    const curve: ParseThreshold[] = [];
    for (const [page, rows] of pages) {
      if (page > lastPage) continue;
      rows.forEach((r, i) => {
        const rank = (page - 1) * PAGE_SIZE + i + 1;
        curve.push({
          dps: r.amount,
          percentile: rank === 1 ? 100 : (1 - rank / population) * 100,
        });
      });
    }
    const byRank = [...curve].sort((a, b) => b.percentile - a.percentile);
    if (byRank.some((p, i) => i > 0 && p.dps > byRank[i - 1].dps))
      throw new Error(
        "WCL's ranking pages changed while loading. Refresh the comparison.",
      );
    if (this.curves.size >= 64)
      this.curves.delete(this.curves.keys().next().value!);
    this.curves.set(key, { curve, at: this.now() });
    return curve;
  }
}
