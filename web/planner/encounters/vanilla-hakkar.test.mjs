import test from 'node:test';
import assert from 'node:assert/strict';
import {hakkarSnapshotPreservations} from './vanilla-hakkar.mjs';
import {normalizeReplay,enrichCombat,combatStateAt} from '../replay.mjs';
const event=(timestamp,type,extra={})=>({timestamp,type,sourceID:1,targetID:1,abilityGameID:24321,...extra});
const data=()=>({gameVersion:'vanilla',report:{code:'test'},fight:{startTime:0,endTime:1000,gameZone:{id:309},friendlyPlayers:[1],chapters:[{id:2,encounterID:50793,startTime:100,endTime:900,gameZone:{id:309}}]},actors:[{id:1,type:'Player',name:'P'},{id:2,type:'Player',name:'Q'}],events:[event(10,'applydebuff'),event(100,'combatantinfo',{auras:[],fight:2}),event(200,'refreshdebuff',{sourceID:undefined,fight:2}),event(300,'damage',{tick:true,fight:2}),event(400,'removedebuff',{sourceID:undefined,fight:2})]});
const poison=(a,t)=>combatStateAt(a,t).auras.find(a=>a.spell===24321);
test('recorded self poison survives omitted snapshot, source-free continuation, and deterministic seeks until exact removal',()=>{
 const raw=data(),before=JSON.stringify(raw),actor=enrichCombat(normalizeReplay(raw)).actors[0];
 assert.equal(JSON.stringify(raw),before);
 const reset=actor.auras.find(([,a])=>a.reset)[1];
 assert.deepEqual(reset.preserve,[24321]);assert.equal(reset.preserveEvidence.witnessTimestamp,200);
 for(const t of [100,399,400,10,299,100,400,200,399])assert.equal(poison(actor,t)?.selfCast,t<400?true:undefined);
 // Exercise the uncached fallback independently of the indexed checkpoint fold.
 actor.auras.push([NaN,{spell:999,remove:true}]);
 for(const t of [399,400,100])assert.equal(!!poison(actor,t),t<400);
});
test('terminal alone supports preservation; periodic damage requires the same recorded owner',()=>{
 for(const mode of ['removedebuff','damage']){
  const raw=data();raw.events=[raw.events[0],raw.events[1],event(400,mode,{tick:true,fight:2})];
  assert.equal(hakkarSnapshotPreservations(raw).size,1);
 }
});
test('unrelated scope, missing prior evidence, owners, instances and new applications cannot earn preservation',()=>{
 const changes=[r=>r.gameVersion='sod',r=>r.fight.gameZone.id=531,r=>r.fight.chapters[0].encounterID=50784,
 r=>r.events.shift(),r=>r.events.splice(2),r=>r.events[0].sourceID=2,r=>r.events[0].targetInstance=2,
 r=>r.events.forEach(e=>e.abilityGameID=24322),r=>r.events[1].fight=3,
 r=>r.fight.chapters.push({...r.fight.chapters[0]}),r=>r.events[2]=event(150,'applydebuff',{sourceID:undefined,fight:2}),
 r=>r.events[2]=event(150,'refreshdebuff',{sourceID:2,fight:2}),
 r=>r.events.splice(2,0,event(150,'death',{fight:2})),r=>r.events.splice(2,0,event(150,'zonechange')),
 r=>r.events.splice(1,0,event(90,'zonechange')),r=>r.events.splice(1,0,event(90,'encounterend')),
 r=>r.events.splice(1,0,event(90,'encounterstart',{fight:99})),r=>r.events.splice(2,0,event(150,'encounterend',{fight:2})),r=>r.events[1].auras=[{ability:24321}],
 r=>r.fight.endTime=150,r=>r.fight.chapters[0].endTime=150];
 for(const change of changes){const r=data();change(r);assert.equal(hakkarSnapshotPreservations(r).size,0,String(change));}
});
test('ordinary reset remains authoritative for unrelated aura ownership and does not seed single-pull poison',()=>{
 const raw=data();raw.events.unshift(event(5,'applybuff',{abilityGameID:111}));
 const actor=enrichCombat(normalizeReplay(raw)).actors[0];
 assert.equal(combatStateAt(actor,100).auras.some(a=>a.spell===111),false);
 const single=data();single.fight={...single.fight,startTime:100,chapters:undefined,id:2,encounterID:50793};single.events=single.events.filter(e=>e.timestamp>=100);
 assert.equal(poison(enrichCombat(normalizeReplay(single)).actors[0],0),undefined);
});
test('repeated pulls and actor instances keep independent evidence and snapshot policy is idempotent',()=>{
 const r=data();r.fight.chapters.push({id:3,encounterID:50793,startTime:500,endTime:900,gameZone:{id:309}});
 r.fight.chapters[0].endTime=450;
 r.events.push(event(490,'applydebuff',{sourceInstance:2,targetInstance:2}),event(500,'combatantinfo',{sourceInstance:2,auras:[],fight:3}),event(600,'removedebuff',{targetInstance:2,sourceInstance:2,fight:3}));
 const a=hakkarSnapshotPreservations(r),b=hakkarSnapshotPreservations(r);assert.equal(a.size,2);assert.deepEqual([...a],[...b]);
 const actors=enrichCombat(normalizeReplay(r)).actors;assert.ok(poison(actors.find(a=>a.key==='1:2'),550));assert.equal(poison(actors.find(a=>a.key==='1:1'),550),undefined);
});
test('self-aura channel reset consumer respects only explicit preserved state',()=>{
 const r=data();r.events.splice(1,0,event(10,'cast'));const replay=enrichCombat(normalizeReplay(r),{},{24321:{channel:true,durationMs:-1}});
 const channel=replay.actors[0].casts.find(c=>c.channel);assert.ok(channel);assert.equal(channel.end,400);
});

test('actual Hakkar carryover uses canonical zones and the replay Vanilla default',()=>{
 const cases=[
  ['numeric parent and chapter',()=>{}],
  ['name-only parent and chapter',r=>{r.fight.gameZone={name:"Zul'Gurub"};r.fight.chapters[0].gameZone={name:"Zul'Gurub"};}],
  ['numeric parent and name-only chapter',r=>{r.fight.chapters[0].gameZone={name:"Zul'Gurub"};}],
  ['name-only parent and numeric chapter',r=>{r.fight.gameZone={name:"Zul'Gurub"};}],
  ['chapter inherits parent zone',r=>{r.fight.gameZone={name:"Zul'Gurub"};delete r.fight.chapters[0].gameZone;}],
  ['canonical names override provider IDs',r=>{r.fight.gameZone={id:999,name:"Zul'Gurub"};r.fight.chapters[0].gameZone={id:888,name:"Zul'Gurub"};}],
  ['report declares Vanilla',r=>{delete r.gameVersion;r.report.gameVersion='vanilla';}],
  ['missing ruleset defaults to Vanilla',r=>{delete r.gameVersion;r.fight.gameZone={name:"Zul'Gurub"};r.fight.chapters[0].gameZone={name:"Zul'Gurub"};}],
 ];
 for(const[label,change]of cases){
  const raw=data();change(raw);const before=JSON.stringify(raw);
  const replay=enrichCombat(normalizeReplay(raw)),actor=replay.actors[0];
  assert.equal(replay.gameVersion,'vanilla',label);assert.equal(replay.map,309,label);
  assert.equal(hakkarSnapshotPreservations(raw).size,1,label);
  assert.equal(poison(actor,100)?.selfCast,true,label);assert.equal(poison(actor,399)?.selfCast,true,label);
  assert.equal(poison(actor,400),undefined,label);assert.equal(JSON.stringify(raw),before,label);
 }
});
test('SoD and canonical non-ZG zones cannot preserve Hakkar carryover',()=>{
 for(const change of [
  r=>{r.gameVersion='sod';r.fight.gameZone={name:"Zul'Gurub"};},
  r=>{delete r.gameVersion;r.report.gameVersion='sod';},
  r=>{r.fight.gameZone={id:309,name:'Molten Core'};},
  r=>{r.fight.chapters[0].gameZone={id:309,name:'Molten Core'};},
 ]){
  const raw=data();change(raw);assert.equal(hakkarSnapshotPreservations(raw).size,0);
  assert.equal(poison(enrichCombat(normalizeReplay(raw)).actors[0],100),undefined);
 }
 const unknown=data();unknown.gameVersion='unsupported';
 assert.throws(()=>hakkarSnapshotPreservations(unknown),/Unsupported game version/);
 assert.throws(()=>normalizeReplay(unknown),/Unsupported game version/);
});
