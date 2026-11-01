// Recorded Rejoin completions retire the exact glob instance for presentation.
// No births, split schedule, positions, deaths, animation or alias links are inferred.
const ENCOUNTER = 100713, RAW_ENCOUNTER = 713, MAP = 531, GLOB = 15667, REJOIN = 25896;
const MECHANIC = 'sod-viscidus-rejoin';
const key = (e, side) => `${e[`${side}ID`]}:${e[`${side}Instance`] || 1}`;
const spell = e => e.abilityGameID ?? e.ability?.guid;
const sameFight = (e, scope) => scope.id == null || e.fight == null || String(e.fight) === String(scope.id);

function restore(actor) {
  if (actor.viscidusPresentation?.mechanic !== MECHANIC) return actor;
  const {viscidusPresentation, ...rest} = actor;
  return rest;
}

// A later explicit lifecycle edge or fresh observed activity bounds a reused
// instance. This conservative resume bound must not overwrite recorded deaths.
function nextBoundary(actor, rows, start, end) {
  const boundaries = [];
  for (const {event: e, t} of rows) {
    if (!(t > start && t <= end)) continue;
    if (key(e, 'target') === actor.key &&
        ['summon', 'create', 'resurrect', 'death', 'destroy'].includes(e.type))
      boundaries.push({t, reason: `recorded ${e.type}`});
    if (key(e, 'source') === actor.key && e.type === 'cast' && spell(e) !== REJOIN)
      boundaries.push({t, reason: 'recorded later cast'});
    for (const side of ['source', 'target']) {
      if (key(e, side) !== actor.key) continue;
      const resource = e[`${side}Resources`] ??
        (e.resourceActor === (side === 'source' ? 1 : 2) ? e : null);
      if (Number.isFinite(resource?.hitPoints) && resource.hitPoints >= 0 && resource.maxHitPoints > 0)
        boundaries.push({t, reason: resource.hitPoints > 0 ? 'recorded positive health' : 'recorded zero health'});
    }
  }
  for (const [t] of actor.lifeEvents ?? [])
    if (t > start && t <= end) boundaries.push({t, reason: 'recorded actor lifecycle edge'});
  for (const [t] of actor.deaths ?? [])
    if (t > start && t <= end) boundaries.push({t, reason: 'recorded actor death/resurrection edge'});
  return boundaries.sort((a, b) => a.t - b.t)[0];
}

function absentAt(actor, t) {
  let present = actor.initiallyPresent !== false, dead = false;
  for (const [at, value] of actor.lifeEvents ?? []) { if (at > t) break; present = value; }
  for (const [at, value] of actor.deaths ?? []) { if (at > t) break; dead = value; }
  return !present || dead;
}

export function applyViscidusPresentation(replay) {
  const actors = replay.actors ?? [];
  const clean = actors.map(restore);
  const finish = updated => updated.every((actor, i) => actor === actors[i]) ? replay : {...replay, actors: updated};
  if (replay.gameVersion !== 'sod' ||
      [replay.raw?.gameVersion, replay.raw?.report?.gameVersion].some(v => v != null && v !== 'sod'))
    return finish(clean);
  const origin = replay.raw?.fight?.startTime, duration = replay.duration;
  if (!Number.isFinite(origin) || !Number.isFinite(duration) || duration <= 0) return finish(clean);
  const chapters = replay.fight?.chapters?.length ? replay.fight.chapters : [replay.fight];
  const scopes = chapters.filter(c => c?.encounterID === ENCOUNTER &&
    (c.gameZone?.id == null || c.gameZone.id === MAP)).map(c => ({
      id: c.id,
      start: Math.max(0, Number.isFinite(c.startTime) ? c.startTime - origin : c.start ?? 0),
      end: Math.min(duration, Number.isFinite(c.endTime) ? c.endTime - origin : c.end ?? duration),
    })).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start < c.end);
  if (!scopes.length) return finish(clean);
  const events = (replay.raw?.events ?? []).map((event, index) => ({event, index, t: event.timestamp - origin}))
    .filter(({t}) => Number.isFinite(t) && t >= 0 && t <= duration)
    .sort((a, b) => a.t - b.t || a.index - b.index);
  const byKey = new Map(clean.map(a => [a.key, a])), retired = new Map();
  for (const scope of scopes) {
    const rows = events.filter(({event, t}) => scope.start <= t && t <= scope.end && sameFight(event, scope));
    const ended = rows.find(({event: e}) => e.type === 'encounterend' &&
      // WCL's SoD fight metadata uses100713; retained encounter events use713.
      (e.encounterID == null || e.encounterID === ENCOUNTER || e.encounterID === RAW_ENCOUNTER));
    const end = ended?.t ?? scope.end;
    for (const {event: e, t, index} of rows) {
      if (e.type !== 'cast' || e.fake || spell(e) !== REJOIN || !(scope.start <= t && t < end)) continue;
      const actor = byKey.get(key(e, 'source'));
      if (!actor || actor.type !== 'NPC' || actor.gameID !== GLOB || absentAt(actor, t)) continue;
      const list = retired.get(actor.key) ?? [];
      if (list.some(r => r.start === t && r.chapterId === scope.id)) continue;
      const boundary = nextBoundary(actor, rows, t, end);
      list.push({
        start: t, end: boundary?.t ?? end, endInclusive: !boundary,
        chapterId: scope.id ?? null, chapterWindow: [scope.start, end],
        spellId: REJOIN, eventIndex: index,
        startEvidence: 'recorded Rejoin Viscidus cast completion',
        endEvidence: boundary?.reason ?? (ended ? 'recorded encounter end' : 'chapter/replay bound; encounter end unobserved'),
      });
      retired.set(actor.key, list);
    }
  }
  return finish(clean.map(actor => {
    const retirements = retired.get(actor.key);
    if (!retirements?.length) return actor;
    return {...actor, viscidusPresentation: {
      kind: 'encounter-lifecycle-inference', mechanic: MECHANIC,
      retirements: retirements.sort((a, b) => a.start - b.start),
      units: 'milliseconds relative to replay start', startInclusive: true,
      disposition: 'retired-without-corpse', mergeTransitionDurationMs: null,
      limitations: 'Presentation retirement begins at recorded completion; native merge duration unknown. No birth, split visibility, scale, position or identity merging inferred.',
    }};
  }));
}
