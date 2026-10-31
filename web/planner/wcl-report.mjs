// Report pagination and encounter semantics shared by the browser importer and replay tests.
import { reportRaids, raidByMap, raidForZone } from "./raids.mjs";

export const REPORT_QUERY = `query($code:String!) { reportData { report(code:$code) {
 code title startTime endTime visibility revision segments
 masterData { actors { id name type subType gameID petOwner } }
 fights { id name encounterID startTime endTime kill completeRaid friendlyPlayers enemyNPCs { id instanceCount } gameZone { id name } }
} } }`;

export async function collectEvents(loadPage, start, end, options = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Invalid replay time range.");
  }
  const events = [];
  let cursor = start;
  for (let page = 0; page < 250; page++) {
    options.signal?.throwIfAborted();
    const result = await loadPage(cursor);
    options.signal?.throwIfAborted();
    if (!Array.isArray(result?.data)) throw new Error("Invalid event page.");
    if (events.length + result.data.length > 2500000) {
      throw new Error("This import is too large. Choose a single encounter.");
    }
    for (const event of result.data) events.push(event);
    const next = result.nextPageTimestamp;
    options.onProgress?.({
      pages: page + 1,
      events: events.length,
      time: cursor,
      end,
    });
    if (next == null) return events;
    if (!Number.isFinite(next) || next <= cursor)
      throw new Error("Warcraft Logs pagination did not advance.");
    if (next > end) return events;
    cursor = next;
  }
  throw new Error(
    "Import exceeded the page limit. Choose a shorter encounter.",
  );
}

export function fullRunFight(report, map) {
  const available = reportRaids(report);
  if (!available.length)
    throw new Error("This report contains no supported raid encounters.");
  if (map == null && available.length > 1)
    throw new Error(
      "This report contains multiple raids. Choose a raid for full-run playback.",
    );
  const raid = map == null ? available[0] : raidByMap(map, report.gameVersion);
  if (!raid || !available.some((r) => r.map === raid.map))
    throw new Error("Selected raid is not present in this report.");
  const chapters = report.fights
    .filter(
      (f) =>
        raidForZone(f.gameZone, report.gameVersion)?.map === raid.map &&
        !f.completeRaid,
    )
    .sort((a, b) => a.startTime - b.startTime);
  return {
    id: "run",
    name: `Full ${raid.name} run`,
    completeRaid: true,
    gameZone: { id: raid.map, name: raid.name },
    startTime: chapters[0].startTime,
    endTime: Math.max(...chapters.map((f) => f.endTime)),
    friendlyPlayers: [
      ...new Set(chapters.flatMap((f) => f.friendlyPlayers ?? [])),
    ],
    chapters,
  };
}
