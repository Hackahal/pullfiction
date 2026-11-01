import { raidForZone } from "./raids.mjs";

const validTime = (value) => Number.isFinite(value) && value >= 0;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// Provider chapters can start after a recorded encounter. Raw encounter IDs are
// paired only with each other; the observed end links the pair to a chapter.
export function resolveEncounterBounds(report, fight, boundaryEvents) {
  if (
    !fight ||
    fight.id === "run" ||
    fight.completeRaid ||
    fight.recordedPrelude ||
    !fight.encounterID ||
    !validTime(fight.startTime) ||
    !(fight.endTime > fight.startTime)
  )
    return fight;
  const map = (zone) => raidForZone(zone, report.gameVersion)?.map ?? zone?.id;
  const selectedMap = map(fight.gameZone);
  if (selectedMap == null) return fight;
  const chapters = (report.fights ?? []).filter((f) => !f.completeRaid);
  const selected = chapters.filter((f) => sameId(f.id, fight.id));
  if (
    selected.length !== 1 ||
    selected[0].startTime !== fight.startTime ||
    selected[0].endTime !== fight.endTime
  )
    return fight;
  const edges = (boundaryEvents ?? [])
    .filter(
      (e) =>
        (e.type === "encounterstart" || e.type === "encounterend") &&
        validTime(e.timestamp) &&
        Number.isSafeInteger(e.encounterID) &&
        e.encounterID > 0,
    )
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const open = new Map(),
    candidates = [];
  for (const edge of edges) {
    if (edge.type === "encounterstart") {
      const prior = open.get(edge.encounterID);
      open.set(edge.encounterID, { edge, ambiguous: !!prior });
      continue;
    }
    const active = open.get(edge.encounterID);
    open.delete(edge.encounterID);
    if (
      !active ||
      active.ambiguous ||
      active.edge.timestamp >= edge.timestamp ||
      !sameId(edge.fight, fight.id) ||
      edge.timestamp !== fight.endTime
    )
      continue;
    candidates.push({ start: active.edge, end: edge });
  }
  // Duplicate or conflicting terminal evidence cannot establish a unique pair.
  const terminals = edges.filter(
    (e) =>
      e.type === "encounterend" &&
      sameId(e.fight, fight.id) &&
      e.timestamp === fight.endTime,
  );
  if (candidates.length !== 1 || terminals.length !== 1) return fight;
  const { start, end } = candidates[0];
  if (start.timestamp >= fight.startTime) return fight;
  const startChapter = chapters.filter(
    (f) =>
      sameId(f.id, start.fight) &&
      f.startTime <= start.timestamp &&
      f.endTime >= start.timestamp,
  );
  if (startChapter.length !== 1) return fight;
  const related = chapters.filter(
    (f) => f.startTime < end.timestamp && f.endTime > start.timestamp,
  );
  if (
    related.some(
      (f) =>
        (map(f.gameZone) != null && map(f.gameZone) !== selectedMap) ||
        (f.encounterID && !sameId(f.id, fight.id)),
    )
  )
    return fight;
  if (
    [start, end].some((e) => {
      const zone =
        e.gameZone ??
        ((e.mapID ?? e.mapId) != null ? { id: e.mapID ?? e.mapId } : null);
      return zone && map(zone) !== selectedMap;
    })
  )
    return fight;
  // Any intervening start may be a different pull, including the same raw ID.
  if (
    edges.some(
      (e) =>
        e !== start &&
        e.type === "encounterstart" &&
        e.timestamp >= start.timestamp &&
        e.timestamp <= end.timestamp,
    )
  )
    return fight;
  if (
    edges.some(
      (e) =>
        e.encounterID !== start.encounterID &&
        e.timestamp > start.timestamp &&
        e.timestamp <= end.timestamp,
    )
  )
    return fight;
  related.sort((a, b) => a.startTime - b.startTime);
  const chapterIds = [...new Set(related.map((f) => f.id))];
  const players = [
    ...new Set([
      ...(fight.friendlyPlayers ?? []),
      ...related.flatMap((f) => f.friendlyPlayers ?? []),
    ]),
  ];
  const enemies = new Map();
  for (const npc of [
    ...related.flatMap((f) => f.enemyNPCs ?? []),
    ...(fight.enemyNPCs ?? []),
  ])
    enemies.set(npc.id, npc);
  return {
    ...fight,
    startTime: start.timestamp,
    friendlyPlayers: players,
    enemyNPCs: [...enemies.values()],
    reportedBounds: { startTime: fight.startTime, endTime: fight.endTime },
    recordedPrelude: {
      kind: "recorded-encounter-boundaries",
      rawEncounterID: start.encounterID,
      startEvent: { timestamp: start.timestamp, fight: start.fight },
      endEvent: { timestamp: end.timestamp, fight: end.fight },
      chapterIds,
    },
  };
}
