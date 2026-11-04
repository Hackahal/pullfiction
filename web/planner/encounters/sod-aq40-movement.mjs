// Recorded encounter actions mark discontinuities only. They supply no landing
// coordinates, route, altitude, or inferred cast schedule.
const SKERAM = 100709, FANKRISS = 100712, MAP = 531;
const TELEPORTS = new Set([20449, 8195, 4801]);
const ENTANGLES = new Set([731, 1121]);
const key = (id, instance) => Number.isSafeInteger(id) && id > 0
  && (instance == null || Number.isSafeInteger(instance) && instance > 0)
  ? `${id}:${instance ?? 1}` : null;

export function encounterJumpEvents(replay) {
  const result = new Map(), raw = replay.raw;
  if (replay.gameVersion !== 'sod' || !raw) return result;
  if ([raw.gameVersion, raw.report?.gameVersion].some(v => v != null && v !== 'sod')) return result;
  const origin = raw.fight?.startTime, duration = replay.duration;
  if (!Number.isFinite(origin) || !Number.isFinite(duration) || duration <= 0) return result;
  const actors = new Map((replay.actors ?? []).map(a => [a.key, a]));
  const catalog = new Map((raw.actors ?? raw.report?.masterData?.actors ?? []).map(a => [a.id, a]));
  const fight = replay.fight ?? raw.fight;
  const chapters = fight.chapters?.length ? fight.chapters : [fight];
  const scopes = chapters.flatMap(c => {
    const encounterID = c.encounterID ?? c.encounterId;
    if (![SKERAM, FANKRISS].includes(encounterID)) return [];
    const map = c.gameZone?.id ?? fight.gameZone?.id ?? replay.map;
    if (map !== MAP) return [];
    const start = Number.isFinite(c.startTime) ? c.startTime - origin : c.start;
    const end = Number.isFinite(c.endTime) ? c.endTime - origin : c.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
    return [{ chapter: c, encounterID, start: Math.max(0, start), end: Math.min(duration, end) }];
  });
  if (!scopes.length) return result;
  const seen = new Set(), rows = [], events = raw.events ?? [];
  for (let order = 0; order < events.length; order++) {
    const event = events[order];
    if (event.type !== 'cast' && event.type !== 'applydebuff') continue;
    const spell = event.abilityGameID ?? event.ability?.guid;
    if (!(event.type === 'cast' ? TELEPORTS : ENTANGLES).has(spell)) continue;
    const t = event.timestamp - origin;
    if (Number.isFinite(t) && t >= 0 && t <= duration) rows.push({ event, order, t });
  }
  rows.sort((a, b) => a.t - b.t || a.order - b.order);
  for (const { event: e, order, t } of rows) {
    const spell = e.abilityGameID ?? e.ability?.guid;
    const sourceKey = key(e.sourceID, e.sourceInstance);
    const source = actors.get(sourceKey), declared = catalog.get(e.sourceID);
    for (const { chapter, encounterID, start, end } of scopes) {
      if (t < start || t > end || chapter.id != null && e.fight != null && e.fight !== chapter.id) continue;
      const template = encounterID === SKERAM ? 15263 : 15510;
      // Require both imported actor identity and this chapter's reported enemy
      // membership. A matching spell on a player, clone, or unrelated NPC is not
      // evidence for these encounter-specific movement rules.
      if (source?.type !== 'NPC' || source.gameID !== template
        || declared?.type !== 'NPC' || declared.gameID !== template
        || !chapter.enemyNPCs?.some(a => a.id === e.sourceID)) continue;
      let actorKey, kind, basis;
      if (encounterID === SKERAM && e.type === 'cast' && TELEPORTS.has(spell)) {
        actorKey = sourceKey;
        kind = 'recorded-source-teleport';
        basis = 'recorded Skeram teleport cast; later position anchor is an estimated landing';
      } else if (encounterID === FANKRISS && e.type === 'applydebuff' && ENTANGLES.has(spell)) {
        actorKey = key(e.targetID, e.targetInstance);
        const target = actors.get(actorKey), targetDeclaration = catalog.get(e.targetID);
        if (!['Player', 'Pet'].includes(target?.type) || targetDeclaration?.type !== target.type) continue;
        kind = 'recorded-target-entangle';
        basis = 'recorded Fankriss Entangle application on this recipient; later position anchor is an estimated landing';
      } else continue;
      const identity = `${actorKey}/${t}/${spell}/${sourceKey}/${kind}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const records = result.get(actorKey) ?? [];
      records.push({ t, spell, kind, basis, source: sourceKey, target: actorKey,
        encounterID, chapterId: chapter.id, eventIndex: order });
      result.set(actorKey, records);
    }
  }
  return result;
}
