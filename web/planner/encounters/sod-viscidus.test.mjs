import test from 'node:test';
import assert from 'node:assert/strict';
import {applyViscidusPresentation} from './sod-viscidus.mjs';

const glob = (extra = {}) => ({key:'127:15', type:'NPC', gameID:15667,
  samples:[[0,1,2,null],[100,3,4,null]], deaths:[], lifeEvents:[], initiallyPresent:true, ...extra});
const cast = (t, extra = {}) => ({timestamp:1000+t, type:'cast', sourceID:127,
  sourceInstance:15, abilityGameID:25896, fight:12, ...extra});
const fixture = (events = [cast(40)], actor = glob(), extra = {}) => ({
  gameVersion:'sod', duration:100, fight:{id:12, encounterID:100713, startTime:1000, endTime:1100, gameZone:{id:531}},
  raw:{gameVersion:'sod', report:{gameVersion:'sod'}, fight:{startTime:1000}, events},
  actors:[actor], ...extra,
});
const retirement = r => r.actors[0].viscidusPresentation?.retirements;
// Parent owns the shared pose consumer. This checks the proposed annotation's
// seek contract directly, without claiming that poseAt already consumes it.
const retiredAt = (actor, t) => actor.viscidusPresentation?.retirements.some(r =>
  r.start <= t && (t < r.end || r.endInclusive && t === r.end)) ?? false;

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('recorded completion creates a pure labelled retirement without changing lifecycle or pose inputs', () => {
  const raw = freeze(fixture()), result = applyViscidusPresentation(raw), a = result.actors[0];
  assert.notEqual(result, raw); assert.notEqual(a, raw.actors[0]);
  assert.equal(a.samples, raw.actors[0].samples); assert.equal(a.deaths, raw.actors[0].deaths);
  assert.equal(a.lifeEvents, raw.actors[0].lifeEvents); assert.equal(result.raw, raw.raw);
  assert.deepEqual(retirement(result), [{start:40,end:100,endInclusive:true,chapterId:12,
    chapterWindow:[0,100],spellId:25896,eventIndex:0,
    startEvidence:'recorded Rejoin Viscidus cast completion',
    endEvidence:'chapter/replay bound; encounter end unobserved'}]);
  assert.equal(a.viscidusPresentation.disposition, 'retired-without-corpse');
  assert.equal(a.viscidusPresentation.mergeTransitionDurationMs, null);
  assert.equal(a.viscidusPresentation.kind, 'encounter-lifecycle-inference');
});

test('direct reverse and repeated seeks are stateless; rebuilding annotations is idempotent', () => {
  const original = fixture(), result = applyViscidusPresentation(original), a = result.actors[0];
  for (const [t, expected] of [[0,false],[39,false],[40,true],[99,true],[100,true],[101,false],
    [80,true],[10,false],[40,true],[40,true],[0,false]]) assert.equal(retiredAt(a,t), expected);
  assert.deepEqual(applyViscidusPresentation(result), result);
  assert.equal(original.actors[0].viscidusPresentation, undefined);
});

test('ruleset, encounter, map, NPC, source instance, fake casts and wrong spell are gated', () => {
  for (const raw of [fixture(undefined,glob(),{gameVersion:'vanilla'}),
    fixture(undefined,glob(),{fight:{encounterID:100715}}),
    fixture(undefined,glob(),{fight:{encounterID:100713,gameZone:{id:2856}}}),
    fixture(undefined,glob({gameID:15299})), fixture(undefined,glob({type:'Pet'})),
    fixture([cast(40,{sourceInstance:16})]), fixture([cast(40,{abilityGameID:25897})]),
    fixture([cast(40,{type:'begincast'})]), fixture([cast(40,{fake:true})])]) {
    assert.equal(applyViscidusPresentation(raw),raw);
  }
  const conflict=fixture();conflict.raw.report.gameVersion='vanilla';
  assert.equal(applyViscidusPresentation(conflict),conflict);
});

test('source spell fallback and duplicate chunk observations retain one retirement', () => {
  const e=cast(40,{abilityGameID:undefined,ability:{guid:25896}});
  assert.equal(retirement(applyViscidusPresentation(fixture([e,{...e}]))).length,1);
});

test('recorded encounter end bounds retirement and excludes later stale completions', () => {
  const end={timestamp:1070,type:'encounterend',encounterID:713,fight:12};
  const r=applyViscidusPresentation(fixture([cast(40),{timestamp:1060,type:'encounterend',encounterID:100715,fight:12},end,cast(80)]));
  assert.equal(retirement(r).length,1);assert.equal(retirement(r)[0].end,70);
  assert.equal(retirement(r)[0].endEvidence,'recorded encounter end');
  assert.equal(retiredAt(r.actors[0],70),true);assert.equal(retiredAt(r.actors[0],71),false);
});

test('actual death or destroy restores authoritative lifecycle at its exact boundary', () => {
  for (const type of ['death','destroy']) {
    const event={timestamp:1060,type,targetID:127,targetInstance:15,fight:12};
    const r=applyViscidusPresentation(fixture([cast(40),event]));
    assert.equal(retirement(r)[0].end,60);assert.equal(retirement(r)[0].endInclusive,false);
    assert.equal(retiredAt(r.actors[0],59),true);assert.equal(retiredAt(r.actors[0],60),false);
    assert.equal(retirement(r)[0].endEvidence,`recorded ${type}`);
  }
});

test('summon create resurrection and positive health reactivate reused instances without affecting earlier retirement', () => {
  const boundaries=[...['summon','create','resurrect'].map(type=>({timestamp:1060,type,targetID:127,targetInstance:15,fight:12})),
    {timestamp:1060,type:'damage',targetID:127,targetInstance:15,resourceActor:2,hitPoints:500,maxHitPoints:1000,fight:12},
    {timestamp:1060,type:'cast',sourceID:127,sourceInstance:15,abilityGameID:1,fight:12}];
  for (const event of boundaries) {
    const r=applyViscidusPresentation(fixture([cast(40),event,cast(80)]));
    assert.deepEqual(retirement(r).map(s=>[s.start,s.end,s.endInclusive]),[[40,60,false],[80,100,true]]);
    assert.equal(retiredAt(r.actors[0],65),false);assert.equal(retiredAt(r.actors[0],80),true);
  }
});

test('positive health on a different instance or victim cannot reactivate the glob', () => {
  const r=applyViscidusPresentation(fixture([cast(40),{timestamp:1060,type:'damage',sourceID:127,sourceInstance:15,
    targetID:2,resourceActor:2,hitPoints:50,maxHitPoints:100,fight:12}]));
  assert.equal(retirement(r)[0].end,100);
});

test('normalized lifecycle edges and pre-existing absent or dead actors remain authoritative', () => {
  for(const extra of [{lifeEvents:[[30,false]]},{deaths:[[30,true]]},{initiallyPresent:false}])
    assert.equal(retirement(applyViscidusPresentation(fixture(undefined,glob(extra)))),undefined);
  const r=applyViscidusPresentation(fixture(undefined,glob({lifeEvents:[[60,true]],deaths:[[70,true]]})));
  assert.equal(retirement(r)[0].end,60);assert.equal(retirement(r)[0].endInclusive,false);
});

test('full-run and repeated Viscidus chapters keep root-relative spans and unrelated encounters unchanged', () => {
  const actor=glob({presentationWindows:[[0,500]],presentationEvidence:{kind:'existing'},
    lifeEvents:[[205,true]]});
  const full=fixture([cast(40),cast(140,{fight:13}),cast(240,{fight:14}),cast(250,{fight:13})],actor,{
    duration:500,fight:{chapters:[
      {id:12,encounterID:100713,startTime:1000,endTime:1100},
      {id:13,encounterID:100715,startTime:1100,endTime:1200},
      {id:14,encounterID:100713,startTime:1200,endTime:1300}]},
  });
  const r=applyViscidusPresentation(full);
  assert.deepEqual(retirement(r).map(s=>[s.start,s.end,s.chapterId]),[[40,100,12],[240,300,14]]);
  assert.equal(retiredAt(r.actors[0],150),false);assert.equal(retiredAt(r.actors[0],210),false);
  assert.equal(retiredAt(r.actors[0],350),false);
  assert.equal(r.actors[0].presentationWindows,actor.presentationWindows);
  assert.equal(r.actors[0].presentationEvidence,actor.presentationEvidence);
});

test('normalized chapter bounds, unsorted events, unobserved end and removed observations rebuild safely', () => {
  const raw=fixture([cast(80),cast(40)],glob(),{fight:{chapters:[{id:12,encounterID:100713,start:20,end:90}]}});
  const r=applyViscidusPresentation(raw);assert.deepEqual(retirement(r).map(s=>[s.start,s.end]),[[40,90],[80,90]]);
  const removed={...r,raw:{...r.raw,events:[]}};
  assert.equal(applyViscidusPresentation(removed).actors[0].viscidusPresentation,undefined);
});
