import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReplay,enrichCombat} from '../replay.mjs';
const cast=(timestamp=2000,extra={})=>({timestamp,type:'cast',sourceID:2,abilityGameID:25178,...extra});
const aura=(timestamp=2001,extra={})=>({timestamp,type:'applydebuff',sourceID:2,targetID:3,abilityGameID:25178,...extra});
const input=(events=[cast(),aura()])=>({report:{code:'fixture'},gameVersion:'sod',
 fight:{id:1,encounterID:100723,startTime:1000,endTime:5000,gameZone:{id:509}},
 actors:[{id:2,type:'NPC',name:'Crystal',gameID:15590},{id:3,type:'NPC',name:'Ossirian',gameID:15339},{id:4,type:'NPC',name:'Other',gameID:15339}],events});
const build=raw=>enrichCombat(normalizeReplay(raw),{},{});
const launches=r=>r.visualEvents.filter(e=>e.kind==='go');
test('Ossirian crystal chains use the unique recorded aura recipient without generating an impact or changing raw cast targets',()=>{
 const raw=input(),before=JSON.stringify(raw),r=build(raw),[go]=launches(r);
 assert.equal(go.target,'3:1');assert.equal(go.targetEvidence.applicationTimeMs,1001);assert.deepEqual(go.impacts,[]);
 assert.equal(r.visualEvents.filter(e=>e.kind==='impact').length,0);
 assert.equal(r.combat.find(e=>e.kind==='go').target,null);assert.equal(JSON.stringify(raw),before);
 assert.equal(launches(build(input([cast(2000,{targetID:4}),aura()])))[0].target,'4:1');
});
test('Missing, ambiguous, mismatched, early or late aura records never choose a crystal target',()=>{
 for(const events of [[cast()],[aura(1999),cast()],[cast(),aura(2251)],
  [cast(),aura(2001,{sourceInstance:2})],[cast(),aura(2001,{abilityGameID:25180})],
  [cast(),aura(),aura(2002,{targetID:4})],[cast(),{...aura(),type:'refreshdebuff'}]])
  assert.equal(launches(build(input(events)))[0].target,null,JSON.stringify(events));
});
test('Only the latest recorded cast can own the following aura and reused instance keys stay local to each import',()=>{
 const r=build(input([cast(),cast(2010),aura(2011)]));
 assert.deepEqual(launches(r).map(e=>e.target),[null,'3:1']);
 for(const start of [1000,25000]){
  const raw=input([cast(start+1000),aura(start+1001)]);raw.fight={...raw.fight,startTime:start,endTime:start+4000};
  assert.equal(launches(build(raw))[0].target,'3:1');
 }
});
test('Crystal target binding stays inside the observed SoD Ossirian chapter and preserves other rulesets',()=>{
 for(const change of [{gameVersion:'vanilla'},{fight:{...input().fight,encounterID:100722}},
  {fight:{...input().fight,gameZone:{id:531}}},{actors:input().actors.map(a=>a.id===2?{...a,gameID:1}:a)}])
  assert.equal(launches(build({...input(),...change}))[0].target,null);
 const raw=input();raw.fight={...raw.fight,chapters:[{encounterID:100723,startTime:2000,endTime:3000},{encounterID:100722,startTime:3001,endTime:5000}]};
 assert.equal(launches(build(raw))[0].target,'3:1');
 raw.fight.chapters[0].endTime=2000;
 assert.equal(launches(build(raw))[0].target,null,'application after chapter end cannot bind');
}
);
