import definitions from './raids.json' with { type: 'json' };
export const RAIDS = definitions;
export function raidsForVersion(version) {return RAIDS.filter(r=>!version||!r.rulesets||r.rulesets.includes(version));}
export function raidByMap(map,version) { return raidsForVersion(version).find(r => r.map === Number(map)); }
const normalize = name => String(name ?? '').toLowerCase().replaceAll('’', "'").trim();
export function raidForZone(zone,version) {
  // WCL gameZone ids are not guaranteed to be client Map.dbc ids; resolve the
  // canonical zone name first and accept map ids only when a name is absent.
  if (zone?.name) return raidsForVersion(version).find(r => [r.name,...r.aliases].some(n => normalize(n) === normalize(zone.name)));
  return raidByMap(zone?.id,version);
}
export function reportRaids(report) {
  const maps = new Set((report?.fights ?? []).filter(f => !f.completeRaid).map(f => raidForZone(f.gameZone,report?.gameVersion)?.map));
  return raidsForVersion(report?.gameVersion).filter(r => maps.has(r.map));
}
export function requireRaid(zone,version) {
  const raid = raidForZone(zone,version);
  if (!raid) throw new Error(`Unsupported raid: ${zone?.name ?? 'unknown zone'}. Choose a supported raid instance for this game version.`);
  return raid;
}
