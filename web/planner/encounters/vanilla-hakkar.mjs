// Preserve only recorded Poisonous Blood carryover in the Vanilla Hakkar pull.
// A snapshot is still authoritative for every other aura. This policy neither
// seeds state nor assigns a duration; its witnesses remain raw log events.
const POISON = 24321;
const key = (e, side) => `${e[`${side}ID`]}:${e[`${side}Instance`] || 1}`;
const spell = e => e.abilityGameID ?? e.ability?.guid;
const sameScope = (e, c) => e.timestamp >= c.startTime && e.timestamp <= c.endTime &&
  (e.fight == null || e.fight === c.id);
export function hakkarSnapshotPreservations(raw) {
  const result = new Map();
  if ((raw.gameVersion ?? raw.report?.gameVersion) !== 'vanilla' || Number(raw.fight?.gameZone?.id) !== 309) return result;
  const chapters = raw.fight.chapters?.length ? raw.fight.chapters : [raw.fight];
  const scopes = chapters.filter(c => c.encounterID === 50793 && Number(c.gameZone?.id ?? raw.fight.gameZone.id) === 309);
  const players = new Set(raw.actors.filter(a => a.type === 'Player').map(a => a.id));
  const rows = raw.events.filter(e => Number.isFinite(e.timestamp) && e.timestamp >= raw.fight.startTime && e.timestamp <= raw.fight.endTime)
    .map((e, i) => ({e, i})).sort((a,b) => a.e.timestamp-b.e.timestamp || a.i-b.i).map(r => r.e);
  const active = new Set();
  for (let i=0;i<rows.length;i++) {
    const e=rows[i], target=key(e,'target'), source=key(e,'source');
    if (e.type === 'zonechange' || e.type === 'encounterend' ||
        (e.type === 'encounterstart' && !scopes.some(c => sameScope(e,c)))) { active.clear(); continue; }
    if (['death','destroy','resurrect','create','summon'].includes(e.type)) active.delete(target);
    if (e.type === 'combatantinfo') {
      const matching = scopes.filter(c => sameScope(e,c));
      const omitted = !(e.auras ?? []).some(a => (a.ability ?? a.abilityGameID) === POISON);
      let witness;
      if (players.has(e.sourceID) && active.has(source) && omitted && matching.length === 1) {
        const c=matching[0];
        for (let j=i+1;j<rows.length;j++) {
          const f=rows[j];
          if (f.timestamp > c.endTime || f.type === 'zonechange' || f.type === 'encounterend') break;
          if (!sameScope(f,c)) { if (f.type === 'encounterstart') break; continue; }
          if (key(f,'target') !== source) continue;
          if (['death','destroy','resurrect','create','summon'].includes(f.type)) break;
          if (spell(f) !== POISON) continue;
          if (f.type === 'applydebuff' || f.type === 'applybuff') break;
          const owner = f.sourceID == null || key(f,'source') === source;
          if (!owner) break;
          if (f.type === 'removedebuff' || f.type === 'removebuff' ||
              ['refreshdebuff','refreshbuff','applydebuffstack','applybuffstack','removedebuffstack','removebuffstack'].includes(f.type) ||
              (f.type === 'damage' && f.tick && key(f,'source') === source)) { witness=f; break; }
        }
      }
      if (witness) result.set(e, {preserve:[POISON], preserveEvidence:{mechanic:'vanilla-hakkar-recorded-poison-continuation',
        encounterID:50793, snapshotTimestamp:e.timestamp, witnessTimestamp:witness.timestamp, witnessType:witness.type,
        actor:source, provenance:'recorded prior self-aura and subsequent continuation; snapshot omission reconciled'}});
      else active.delete(source);
    }
    if (spell(e) === POISON && /^(apply|refresh|remove)(buff|debuff)/.test(e.type)) {
      const remove=e.type.startsWith('remove') && !e.type.endsWith('stack');
      if (remove) active.delete(target);
      else if (e.sourceID != null) {
        if (source === target && players.has(e.targetID)) active.add(target); else active.delete(target);
      } else if (e.type.startsWith('apply') && !e.type.endsWith('stack')) active.delete(target);
    }
  }
  return result;
}
