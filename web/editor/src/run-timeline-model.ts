import type { Actor, Replay } from "./types";

export interface RunSegment {
  key: string;
  name: string;
  start: number;
  end: number;
  actor?: Actor;
  count: number;
  kill?: boolean;
}
export interface RunRange {
  start: number;
  span: number;
}
export function runRange(
  start: number,
  span: number,
  duration: number,
): RunRange {
  const total = Math.max(1, duration);
  const length = Math.max(Math.min(1000, total), Math.min(total, span));
  return { start: Math.max(0, Math.min(total - length, start)), span: length };
}
export function zoomRunRange(
  range: RunRange,
  factor: number,
  anchor: number,
  duration: number,
) {
  const fraction = Math.max(0, Math.min(1, anchor));
  const next = runRange(0, range.span / factor, duration);
  return runRange(
    range.start + range.span * fraction - next.span * fraction,
    next.span,
    duration,
  );
}
export function runTimeAt(
  pixel: number,
  width: number,
  range: RunRange,
  duration: number,
) {
  return Math.max(
    0,
    Math.min(
      duration,
      range.start +
        Math.max(0, Math.min(1, pixel / Math.max(1, width))) * range.span,
    ),
  );
}
const boss = (a: Actor) =>
  a.class === "Boss" || a.icon?.toLowerCase() === "boss";

export function runSegments(replay: Replay): {
  bosses: RunSegment[];
  mobs: RunSegment[];
} {
  const chapters = replay.chapters.length
    ? replay.chapters
    : [
        {
          id: replay.fight.id,
          name: replay.fight.name,
          start: 0,
          end: replay.duration,
          encounterID: replay.fight.encounterID,
          kill: replay.fight.kill,
          enemyNPCs: undefined,
        },
      ];
  const npcs = replay.actors.filter(
    (a) =>
      a.type === "NPC" &&
      Number.isFinite(a.firstSeen) &&
      Number.isFinite(a.lastSeen) &&
      a.firstSeen <= replay.duration,
  );
  const activeIn = (a: Actor, start: number, end: number) =>
    a.firstSeen < end && a.lastSeen >= start;
  const bosses = chapters
    .filter((c) => c.encounterID)
    .map((c) => {
      const candidates = npcs.filter(
        (a) =>
          activeIn(a, c.start, c.end) &&
          (!c.enemyNPCs?.length || c.enemyNPCs.some((n) => n.id === a.id)),
      );
      const actor =
        candidates.find((a) => boss(a) && a.name === c.name) ??
        candidates.find(boss) ??
        candidates.find((a) => a.name === c.name) ??
        (replay.raw?.stream
          ? replay.actors.find((a) => a.name === c.name)
          : undefined);
      return {
        key: `boss-${c.id}`,
        name: c.name,
        start: c.start,
        end: c.end,
        actor,
        count: 1,
        kill: c.kill,
      };
    });
  // Group each creature type within a pull. Outside recorded pulls, separate
  // observations into 15s buckets rather than inventing one long pull.
  const groups = new Map<string, RunSegment>();
  for (const a of npcs.filter((a) => !boss(a))) {
    const overlaps = chapters.filter((c) => activeIn(a, c.start, c.end));
    const windows = overlaps.length
      ? overlaps
      : [
          {
            id: `gap-${Math.floor(a.firstSeen / 15000)}`,
            start: a.firstSeen,
            end: a.lastSeen,
          },
        ];
    for (const c of windows) {
      const start = Math.max(0, a.firstSeen, c.start);
      const end = Math.min(replay.duration, Math.max(start, a.lastSeen), c.end);
      if (end < start) continue;
      const key = `${c.id}:${a.gameID || a.name}`;
      const group = groups.get(key);
      if (group) {
        group.start = Math.min(group.start, start);
        group.end = Math.max(group.end, end);
        group.count++;
      } else
        groups.set(key, { key, name: a.name, start, end, actor: a, count: 1 });
    }
  }
  return {
    bosses,
    mobs: [
      ...groups.values(),
      ...(replay.raw?.stream
        ? chapters.flatMap((c) => {
            if (
              replay.raw.stream!.full.some(
                ([a, b]) => a <= c.start && b >= c.end,
              )
            )
              return [];
            return (c.enemyNPCs ?? []).flatMap((n) => {
              const actor = replay.actors.find((a) => a.id === n.id);
              const metadata = (replay.raw.actors as any[]).find(
                (a) => a.id === n.id,
              );
              if (
                !metadata ||
                boss(
                  actor ??
                    ({ class: metadata.subType, icon: metadata.icon } as Actor),
                ) ||
                groups.has(
                  `${c.id}:${actor?.gameID || metadata.gameID || metadata.name}`,
                )
              )
                return [];
              return [
                {
                  key: `metadata-${c.id}-${n.id}`,
                  name: metadata.name,
                  start: c.start,
                  end: c.end,
                  actor,
                  count: (n as any).instanceCount ?? 1,
                },
              ];
            });
          })
        : []),
    ].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)),
  };
}

// Coalesce crowded portraits into buckets at the current navigation scale.
// Zooming in splits them again; all underlying mob names remain in the tooltip.
export function visibleRunMobs(
  mobs: RunSegment[],
  range: RunRange,
  width: number,
): (RunSegment & { names: string })[] {
  const visible: (RunSegment & { names: string })[] = [];
  for (const mob of mobs) {
    if (mob.end < range.start || mob.start > range.start + range.span) continue;
    const old = visible.at(-1);
    const pixel = (t: number) =>
      Math.max(0, ((t - range.start) / range.span) * width);
    const description = `${mob.name}${mob.count > 1 ? ` ×${mob.count}` : ""}`;
    if (old && pixel(mob.start) - pixel(old.start) < 46) {
      old.end = Math.max(old.end, mob.end);
      old.count += mob.count;
      old.names += `\n${description}`;
    } else visible.push({ ...mob, names: description });
  }
  return visible;
}
