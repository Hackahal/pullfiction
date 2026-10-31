import type { Replay, Chapter } from "./types";
import { speedrunRules } from "./speedrun-rules";
const nameKey = (name: string) =>
  name.toLowerCase().replaceAll("’", "'").trim();
const named = (name: string, names: string[]) =>
  names.some((n) => nameKey(n) === nameKey(name));
const countAt = (times: number[], t: number) => {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
export function coveredThrough(replay: Replay, from: number, to: number) {
  if (!replay.raw.stream) return true;
  let end = from;
  for (const [a, b] of [...replay.raw.stream.full].sort(
    (x, y) => x[0] - y[0],
  )) {
    if (b < end) continue;
    if (a > end) return false;
    end = Math.max(end, b);
    // Stream caches use half-open intervals. Include the event at the cursor.
    if (end > to || (end >= replay.duration && to === replay.duration))
      return true;
  }
  return false;
}
export interface SpeedrunOptions {
  heat: 1 | 2 | 3;
}
export function indexSpeedrun(
  replay: Replay,
  options: SpeedrunOptions = { heat: 1 },
) {
  const rules = speedrunRules(replay.gameVersion, replay.map);
  const chapters: Chapter[] = replay.chapters.length
    ? replay.chapters
    : [
        {
          id: Number(replay.fight.id),
          name: replay.fight.name,
          start: 0,
          end: replay.duration,
          kill: replay.fight.kill,
          encounterID: replay.fight.encounterID,
        },
      ];
  const bosses = chapters
    .filter((c) => c.encounterID)
    .sort((a, b) => a.start - b.start);
  const catalog = new Map(
    (replay.raw.actors as { id: number; name: string; type: string }[]).map(
      (a) => [a.id, a],
    ),
  );
  // Use combat events, not firstSeen (which can be a pre-pull buff/position).
  let firstCombat: number | null = null,
    anchor: number | null = null;
  for (const event of replay.raw.events as {
    type: string;
    timestamp: number;
    sourceID?: number;
    targetID?: number;
  }[]) {
    if (!["damage", "miss", "missed"].includes(event.type)) continue;
    const npcs = [
      catalog.get(event.sourceID ?? 0),
      catalog.get(event.targetID ?? 0),
    ].filter((a) => a?.type === "NPC");
    if (!npcs.length) continue;
    const t = event.timestamp - replay.fight.startTime;
    if (!Number.isFinite(t) || t < 0 || t > replay.duration) continue;
    firstCombat = firstCombat === null ? t : Math.min(firstCombat, t);
    if (
      rules?.startKind === "combat" &&
      npcs.some((a) => named(a!.name, rules.start))
    )
      anchor = anchor === null ? t : Math.min(anchor, t);
  }
  if (rules?.startKind === "boss")
    anchor = bosses.find((c) => named(c.name, rules.start))?.start ?? null;
  const pull =
    rules?.startKind === "combat"
      ? chapters.find((c) =>
          c.enemyNPCs?.some((n) => {
            const actor = catalog.get(n.id);
            return actor?.type === "NPC" && named(actor.name, rules.start);
          }),
        )
      : undefined;
  // WCL pull metadata includes combat before the first damage lands. If a file
  // lacks it, an observed hostile event supplies only an estimated start.
  const estimated =
    !rules?.start.length || (rules.startKind === "combat" && !pull);
  const start = rules?.start.length
    ? (pull?.start ?? anchor)
    : (firstCombat ?? bosses[0]?.start ?? null);
  const finishNames =
    replay.gameVersion === "sod" && replay.map === 409
      ? [options.heat === 3 ? "The Molten Core" : "Ragnaros"]
      : (rules?.finish ?? []);
  const finish =
    bosses.find(
      (c) =>
        c.kill &&
        named(c.name, finishNames) &&
        (start === null || c.end >= start),
    )?.end ?? null;
  // One confirmed death per recorded actor instance. Repeated deaths or health
  // resets on a corpse must not inflate requirements; respawns have new instances.
  const deaths = replay.actors
    .filter((a) => a.type === "NPC")
    .flatMap((a) => {
      const death = a.deaths.find(
        ([t, dead]) =>
          dead &&
          start !== null &&
          t >= start &&
          (finish === null || t <= finish),
      );
      return death ? [{ t: death[0], id: a.gameID, key: a.key }] : [];
    });
  const requirements = (rules?.requirements ?? []).map((req) => {
    let matches = deaths.filter((d) => req.ids.includes(d.id));
    if (req.distinct)
      matches = [...new Set(matches.map((d) => d.id))].map(
        (id) => matches.filter((d) => d.id === id).sort((a, b) => a.t - b.t)[0],
      );
    return { ...req, times: matches.map((d) => d.t).sort((a, b) => a - b) };
  });
  const razuvious = bosses.find(
    (c) => c.kill && named(c.name, ["Instructor Razuvious"]),
  );
  return {
    replay,
    rules,
    bosses,
    start,
    finish,
    estimated,
    requirements,
    deaths,
    razuvious,
    options,
  };
}
export function speedrunAt(
  index: ReturnType<typeof indexSpeedrun>,
  cursor: number,
) {
  const { replay, rules, start, finish } = index;
  const t = Math.max(0, Math.min(replay.duration, cursor));
  const cutoff = Math.min(t, finish ?? replay.duration);
  const fullRun = !!replay.fight.completeRaid;
  const coverage = start !== null && coveredThrough(replay, 0, cutoff);
  const started = start !== null && t >= start;
  const finished = started && finish !== null && t >= finish;
  const requirements = index.requirements.map((req) => {
    const count = started ? countAt(req.times, cutoff) : 0;
    const missing = Math.max(0, req.count - count);
    return {
      ...req,
      count,
      required: req.count,
      missing,
      met: missing === 0,
      penalty: rules?.penalty
        ? (missing / req.count) * (req.penaltyPool ?? 300000)
        : 0,
    };
  });
  const deadline = index.razuvious;
  const captainPenalty =
    rules?.version === "sod" &&
    rules.map === 533 &&
    started &&
    deadline &&
    cutoff >= deadline.end &&
    index.deaths.filter((d) => d.id === 16145 && d.t < deadline.end).length < 12
      ? 300000
      : 0;
  const penalty = requirements.reduce(
    (sum, r) => sum + r.penalty,
    captainPenalty,
  );
  const splits = index.bosses.map((c) => ({
    ...c,
    completed: started && c.kill === true && c.end <= cutoff && c.end >= start!,
    elapsed: start === null || c.end < start ? null : c.end - start,
  }));
  const killed = new Set(
    splits.filter((c) => c.completed).map((c) => c.encounterID),
  ).size;
  const expectedBosses =
    rules?.map === 409 && rules.version === "sod" && index.options.heat === 3
      ? 11
      : (rules?.bossCount ?? 0);
  const allBosses = expectedBosses > 0 && killed >= expectedBosses;
  return {
    t,
    cutoff,
    fullRun,
    coverage,
    started,
    finished,
    requirements,
    penalty,
    captainPenalty,
    splits,
    killed,
    expectedBosses,
    allBosses,
    elapsed: started ? Math.max(0, cutoff - start!) : 0,
    finalPenalty:
      finished && coverage && fullRun && rules?.coverage === "published",
  };
}
export function timerTime(ms: number) {
  const value = Math.max(0, Math.floor(ms / 10));
  const seconds = Math.floor(value / 100);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(value % 100).padStart(2, "0")}`;
}
