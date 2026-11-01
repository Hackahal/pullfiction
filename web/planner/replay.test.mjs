import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReplay,poseAt,ReplayClock,reportCode} from './replay.mjs';
import {collectEvents} from './wcl-report.mjs';
const raw={report:{code:'DyN7vF94QR8aj1Lc'},fight:{startTime:1000,endTime:11000,gameZone:{name:'Molten Core'},friendlyPlayers:[1]},actors:[{id:1,name:'Player',type:'Player',subType:'Mage'},{id:2,name:'Mob',type:'NPC',gameID:12118}],events:[
 {timestamp:1000,sourceID:1,targetID:2,targetInstance:1,resourceActor:2,x:97440,y:101187},
 {timestamp:2000,sourceID:1,targetID:2,targetInstance:2,resourceActor:2,x:97540,y:101287},
 {timestamp:3000,sourceID:1,targetID:2,targetInstance:1,resourceActor:2,x:97640,y:101387},
 {timestamp:4000,type:'death',targetID:2,targetInstance:1},
]};
test('Static ownership distinguishes boss pets from player pets without changing missing-owner defaults',()=>{
 const actors=[...raw.actors,{id:3,type:'Pet',name:'Ward',gameID:14987,petOwner:2},
  {id:4,type:'Pet',name:'Player pet',gameID:416,petOwner:1},{id:5,type:'Pet',name:'Unknown',petOwner:999},
  {id:6,type:'Pet',name:'Nested',petOwner:3},{id:7,type:'Pet',name:'Cycle',petOwner:8},
  {id:8,type:'Pet',name:'Cycle',petOwner:7},{id:9,type:'NPC',name:'Guardian',petOwner:1}];
 const r=normalizeReplay({...raw,actors,events:actors.map(a=>({timestamp:1000,type:'cast',sourceID:a.id}))});
 const friend=id=>r.actors.find(a=>a.id===id).friendly;
 assert.equal(friend(1),undefined,'player transport retains its existing defaults');
 for(const [id,expected]of [[2,false],[3,false],[4,true],[5,true],[6,false],[7,true],[8,true],[9,true]])assert.equal(friend(id),expected,String(id));
});
test('Recorded summon/create/destroy lifetimes survive seeks and keep independent add instances',()=>{
 const data={...raw,events:[
  {timestamp:2000,type:'summon',sourceID:1,targetID:2,targetInstance:1},
  {timestamp:2100,type:'damage',sourceID:2,sourceInstance:1,targetID:1,resourceActor:1,x:100,y:200},
  {timestamp:3000,type:'create',sourceID:1,targetID:2,targetInstance:2},
  {timestamp:3100,type:'damage',sourceID:2,sourceInstance:2,targetID:1,resourceActor:1,x:300,y:400},
  {timestamp:4000,type:'death',targetID:2,targetInstance:1},
  {timestamp:5000,type:'destroy',targetID:2,targetInstance:1},
  {timestamp:6000,type:'summon',targetID:2,targetInstance:1},
  {timestamp:6100,type:'damage',sourceID:2,sourceInstance:1,targetID:1,resourceActor:1,x:500,y:600},
 ]};
 const replay=normalizeReplay(data),a=replay.actors.find(a=>a.key==='2:1'),b=replay.actors.find(a=>a.key==='2:2');
 for(const t of [5000,0,4000,1000,3000,999,5000]){
  const pose=poseAt(a,t);
  assert.equal(!!pose,t>=1000&&t<4000||t>=5000,`instance 1 at ${t}`);
  if(pose)assert.equal(pose.dead,t>=3000&&t<5000);
 }
 assert.equal(poseAt(b,1999),null);assert.ok(poseAt(b,2000));assert.ok(poseAt(b,9000));
 assert.ok(poseAt(a,5050).discontinuity,'movement cannot interpolate through destruction and recreation');
});
test('An already observed NPC stays present before a later resummon; destroy-only tracks disappear exactly',()=>{
 const data={...raw,events:[
  {timestamp:1000,type:'damage',sourceID:2,targetID:1,resourceActor:1,x:100,y:200},
  {timestamp:3000,type:'summon',sourceID:1,targetID:2},
  {timestamp:4000,type:'destroy',targetID:2},
 ]};
 const a=normalizeReplay(data).actors.find(a=>a.key==='2:1');assert.ok(poseAt(a,0));assert.equal(poseAt(a,3000),null);
 const b=normalizeReplay({...data,events:data.events.filter(e=>e.type!=='summon')}).actors.find(a=>a.key==='2:1');
 assert.ok(poseAt(b,2999));assert.equal(poseAt(b,3000),null);assert.ok(poseAt(b,0));
});
test('Aura self provenance is instance-specific and survives refresh, removal and rewind',()=>{
 const data={...raw,events:[
  {timestamp:1000,type:'applybuff',sourceID:2,targetID:2,abilityGameID:27619},
  {timestamp:2000,type:'refreshbuff',sourceID:2,targetID:2,abilityGameID:27619},
  {timestamp:2500,type:'refreshbuff',targetID:2,abilityGameID:27619},
  {timestamp:2600,type:'removebuffstack',targetID:2,abilityGameID:27619,stack:1},
  {timestamp:3000,type:'applydebuff',sourceID:2,sourceInstance:2,targetID:2,abilityGameID:1604},
  {timestamp:4000,type:'applybuff',targetID:2,abilityGameID:27680},
  {timestamp:5000,type:'removebuff',targetID:2,abilityGameID:27619},
 ]};
 const actor=enrichCombat(normalizeReplay(data)).actors.find(a=>a.key==='2:1');
 for(const t of [3500,0,1500,4500,1600,1000]){
  const auras=combatStateAt(actor,t).auras;
  assert.equal(auras.find(a=>a.spell===27619)?.selfCast,t<4000?true:undefined);
  if(t>=2000)assert.equal(auras.find(a=>a.spell===1604).selfCast,false);
  if(t>=3000)assert.equal(auras.find(a=>a.spell===27680).selfCast,false);
 }
 const replacement=enrichCombat(normalizeReplay({...data,events:[...data.events,
  {timestamp:6000,type:'applybuff',targetID:2,abilityGameID:27619}]})).actors.find(a=>a.key==='2:1');
 assert.equal(combatStateAt(replacement,5000).auras.find(a=>a.spell===27619).selfCast,false);
});
test('Valid HP snapshots reconstruct revived adds and zero-HP deaths in single-fight replays',()=>{
 const r=normalizeReplay({...raw,events:[
  {timestamp:1000,type:'damage',sourceID:1,targetID:2,resourceActor:2,hitPoints:20,maxHitPoints:100,x:100,y:200},
  {timestamp:2000,type:'death',targetID:2},
  {timestamp:3000,type:'cast',sourceID:2,resourceActor:1,hitPoints:40,maxHitPoints:100,x:100,y:200},
  {timestamp:5000,type:'damage',sourceID:1,targetID:2,resourceActor:2,hitPoints:0,maxHitPoints:100,x:100,y:200},
 ]});
 const a=r.actors.find(a=>a.key==='2:1');
 for(const [t,dead] of [[2500,false],[1500,true],[4500,true],[0,false],[2000,false]])assert.equal(poseAt(a,t).dead,dead);
 assert.deepEqual(a.deaths,[[1000,true],[2000,false],[4000,true]]);
 const unknown=normalizeReplay({...raw,events:[
  {timestamp:1000,type:'damage',sourceID:2,resourceActor:1,hitPoints:0,maxHitPoints:0,x:100,y:200},
 ]}).actors.find(a=>a.key==='2:1');
 assert.equal(poseAt(unknown,0).dead,false,'unknown zero-cap resources are not death evidence');
});
test('Postmortem overkill ticks retaining positive HP do not resurrect a dead boss',()=>{
 for(const fight of [raw.fight,{...raw.fight,chapters:[{...raw.fight,id:1}]}]){
  const r=normalizeReplay({...raw,fight,events:[
   {timestamp:1000,type:'damage',sourceID:1,targetID:2,resourceActor:2,hitPoints:100,maxHitPoints:100,x:100,y:200},
   {timestamp:2000,type:'death',targetID:2},
   {timestamp:2109,type:'damage',sourceID:1,targetID:2,tick:true,amount:1,overkill:400,resourceActor:2,hitPoints:1,maxHitPoints:100,x:100,y:200},
   {timestamp:3000,type:'damage',sourceID:1,targetID:2,overkill:10,targetResources:{hitPoints:1,maxHitPoints:100}},
   {timestamp:4000,type:'damage',sourceID:2,targetID:1,overkill:20,resourceActor:1,hitPoints:40,maxHitPoints:100},
   {timestamp:5000,type:'damage',sourceID:1,targetID:2,overkill:20,resourceActor:2,hitPoints:0,maxHitPoints:100},
  ]});
  const a=r.actors.find(a=>a.key==='2:1');
  assert.deepEqual(a.deaths,[[1000,true],[3000,false],[4000,true]]);
  for(const t of [2999,1109,1000,2500,1109])assert.equal(poseAt(a,t).dead,true);
  assert.equal(poseAt(a,3000).dead,false);
  assert.equal(poseAt(a,4000).dead,true);
 }
});
test('An indefinite channel follows a recorded self aura and survives seeking without a fabricated timeout',()=>{
 const replay=enrichCombat(normalizeReplay({...raw,events:[
  {timestamp:1000,type:'applydebuff',sourceID:2,targetID:2,abilityGameID:30},
  {timestamp:1000,type:'cast',sourceID:2,targetID:-1,abilityGameID:30},
  {timestamp:8000,type:'removedebuff',targetID:2,abilityGameID:30},
 ]}),{}, {30:{channel:true,durationMs:-1}});
 const actor=replay.actors.find(a=>a.key==='2:1'),c=actor.casts.find(c=>c.channel);
 assert.equal(c.end,7000);assert.equal(c.inferredEnd,false);assert.equal(c.timingSource,'recorded self aura');
 for(const t of [6000,1,6999,4000])assert.equal(combatStateAt(actor,t).cast?.spell,30);
 assert.equal(combatStateAt(actor,7000).cast,null);
 const unknown=enrichCombat(normalizeReplay({...raw,events:[
  {timestamp:1000,type:'applybuff',sourceID:1,targetID:2,abilityGameID:30},
  {timestamp:1000,type:'cast',sourceID:2,abilityGameID:30},
 ]}),{}, {30:{channel:true,durationMs:-1}}).actors.find(a=>a.key==='2:1');
 assert.equal(combatStateAt(unknown,100).cast,null,'an aura from another actor cannot authorize an infinite channel');
});
test('Recorded interrupts and snapshot boundaries cap a self-aura-bound indefinite channel',()=>{
 for(const edge of [{timestamp:4000,type:'interrupt',sourceID:1,targetID:2,extraAbilityGameID:30},
                   {timestamp:4000,type:'combatantinfo',sourceID:2,auras:[]}]){
  const actor=enrichCombat(normalizeReplay({...raw,events:[
   {timestamp:1000,type:'applybuff',sourceID:2,targetID:2,abilityGameID:30},
   {timestamp:1000,type:'cast',sourceID:2,abilityGameID:30},edge,
   {timestamp:8000,type:'removebuff',targetID:2,abilityGameID:30},
  ]}),{}, {30:{channel:true,durationMs:-1}}).actors.find(a=>a.key==='2:1');
  assert.equal(combatStateAt(actor,2999).cast?.spell,30);assert.equal(combatStateAt(actor,3000).cast,null);
 }
});
test('Repeated untargeted area casts associate results with the latest launch and retain all victim times',()=>{
 const r=enrichCombat(normalizeReplay({...raw,gameVersion:'sod',fight:{...raw.fight,encounterID:3187},
  actors:[raw.actors[0],{...raw.actors[1],gameID:241904},{id:3,name:'Other player',type:'Player'}],events:[
  {timestamp:1000,type:'cast',sourceID:2,abilityGameID:1232829},
  {timestamp:1100,type:'damage',sourceID:2,targetID:1,abilityGameID:1232829},
  {timestamp:5000,type:'cast',sourceID:2,abilityGameID:1232829},
  {timestamp:5100,type:'damage',sourceID:2,targetID:1,abilityGameID:1232829},
  {timestamp:5110,type:'damage',sourceID:2,targetID:3,abilityGameID:1232829},
  {timestamp:5120,type:'damage',sourceID:2,targetID:3,abilityGameID:1232829},
 ]}),{},{});
 const launches=r.visualEvents.filter(e=>e.kind==='go');
 assert.deepEqual(launches.map(e=>e.impacts),[
  [{target:'1:1',t:100}],[{target:'1:1',t:4100},{target:'3:1',t:4110}],
 ]);
 assert.deepEqual(r.visualEvents.filter(e=>e.kind==='impact').map(e=>e.t),[100,4100,4110,4120]);
});
test('Unknown overlapping targetless projectiles retain unused launches instead of dropping a victim',()=>{
 const r=enrichCombat(normalizeReplay({...raw,events:[
  {timestamp:1000,type:'cast',sourceID:2,abilityGameID:30},
  {timestamp:1100,type:'cast',sourceID:2,abilityGameID:30},
  {timestamp:1200,type:'damage',sourceID:2,targetID:1,abilityGameID:30},
  {timestamp:1300,type:'damage',sourceID:2,targetID:1,abilityGameID:30},
 ]}),{},{});
 assert.deepEqual(r.visualEvents.filter(e=>e.kind==='go').map(e=>e.impacts),[
  [{target:'1:1',t:200}],[{target:'1:1',t:300}],
 ]);
});
test('Provider Falling damage retains chart data without colliding with positive client spell IDs',()=>{
 const r=enrichCombat(normalizeReplay({...raw,abilities:[{gameID:3,name:'Falling'}],events:[
  {timestamp:1000,type:'damage',sourceID:-1,targetID:1,abilityGameID:3,amount:123},
  {timestamp:2000,type:'damage',sourceID:2,targetID:1,abilityGameID:3,amount:10},
 ]}),{},{});
 assert.equal(r.combat.filter(e=>e.kind==='damage').length,2);
 assert.equal(r.combat[0].amount,123);assert.equal(r.combat[0].environmental,true);
 assert.deepEqual(r.visualEvents.filter(e=>e.kind==='impact').map(e=>e.source),['2:1']);
});
test('Targeted finite channels end at their uniquely owned victim aura removal',()=>{
 const base={...raw,actors:[...raw.actors,{id:3,name:'Other mob',type:'NPC'}],events:[
  {timestamp:1000,type:'cast',sourceID:2,targetID:1,abilityGameID:30},
  {timestamp:1002,type:'applydebuff',sourceID:2,targetID:1,abilityGameID:30},
  {timestamp:2000,type:'refreshdebuff',targetID:1,abilityGameID:30},
  {timestamp:4000,type:'removedebuff',targetID:1,abilityGameID:30},
 ]};
 const actor=enrichCombat(normalizeReplay(base),{}, {30:{channel:true,durationMs:7500}}).actors.find(a=>a.key==='2:1');
 const c=actor.casts.find(c=>c.channel);
 assert.equal(c.end,3000);assert.equal(c.timingSource,'recorded target aura');assert.equal(c.inferredEnd,false);
 for(const [t,active]of [[2999,true],[3000,false],[100,true],[2999,true]])assert.equal(!!combatStateAt(actor,t).cast,active);
 const overlap={...base,events:[...base.events.slice(0,2),
  {timestamp:1500,type:'applydebuff',sourceID:3,targetID:1,abilityGameID:30},base.events[3]]};
 const ambiguous=enrichCombat(normalizeReplay(overlap),{}, {30:{channel:true,durationMs:7500}}).actors.find(a=>a.key==='2:1');
 assert.equal(ambiguous.casts.find(c=>c.channel).end,7500,'unattributed overlapping removals cannot identify the caster');
 overlap.events.at(-1).sourceID=2;
 const known=enrichCombat(normalizeReplay(overlap),{}, {30:{channel:true,durationMs:7500}}).actors.find(a=>a.key==='2:1');
 assert.equal(known.casts.find(c=>c.channel).end,3000,'an explicit caster removal identifies its own channel');
 const mismatch={...base,events:[...base.events.slice(0,3),{...base.events[3],sourceID:3}]};
 const other=enrichCombat(normalizeReplay(mismatch),{}, {30:{channel:true,durationMs:7500}}).actors.find(a=>a.key==='2:1');
 assert.equal(other.casts.find(c=>c.channel).end,7500,'another explicit caster does not remove this source-owned channel');
});
test('The actual normalization/enrichment pipeline applies AQ teleports to NPCs and rooted pets',()=>{
 const input={...raw,gameVersion:'sod',fight:{...raw.fight,gameZone:{id:531},encounterID:100709,enemyNPCs:[{id:2}]},
  actors:[raw.actors[0],{...raw.actors[1],gameID:15263}],events:[
   {timestamp:1000,type:'damage',sourceID:2,resourceActor:1,x:100,y:100},
   {timestamp:1100,type:'cast',sourceID:2,abilityGameID:20449,resourceActor:1,x:100,y:100},
   {timestamp:1200,type:'damage',sourceID:2,resourceActor:1,x:10000,y:100},
  ]};
 const actor=enrichCombat(normalizeReplay(input),{},{}).actors.find(a=>a.key==='2:1');
 assert.deepEqual(poseAt(actor,99).pos,actor.samples[0].slice(1));
 assert.deepEqual(poseAt(actor,100).pos,actor.samples.at(-1).slice(1));
 assert.equal(poseAt(actor,100).positionSource,'ability jump estimate');
 assert.equal(poseAt(actor,100).estimated,true);
 const petInput={...input,fight:{...input.fight,encounterID:100712},
  actors:[raw.actors[0],{...raw.actors[1],gameID:15510},{id:3,type:'Pet',name:'Pet',petOwner:1}],events:[
   {timestamp:1000,type:'damage',sourceID:3,resourceActor:1,x:100,y:100},
   {timestamp:1500,type:'applydebuff',sourceID:2,targetID:3,abilityGameID:731},
   {timestamp:2000,type:'damage',sourceID:3,resourceActor:1,x:1200,y:100},
  ]};
 const pet=enrichCombat(normalizeReplay(petInput),{},{}).actors.find(a=>a.key==='3:1');
 assert.deepEqual(poseAt(pet,499).pos,pet.samples[0].slice(1));
 assert.deepEqual(poseAt(pet,500).pos,pet.samples.at(-1).slice(1));
 assert.equal(poseAt(pet,500).estimated,true);assert.equal(poseAt(pet,500).movement,null);
 const withDeparture={...petInput,events:petInput.events.map(e=>e.type==='applydebuff'?{...e,resourceActor:2,x:100,y:100}:e)};
 const anchored=enrichCombat(normalizeReplay(withDeparture),{},{}).actors.find(a=>a.key==='3:1');
 for(const t of [500,600,999,600]){
  assert.deepEqual(poseAt(anchored,t).pos,anchored.samples.at(-1).slice(1));
  assert.equal(poseAt(anchored,t).positionSource,'ability jump estimate');assert.equal(poseAt(anchored,t).movement,null);
 }
});
test('Mason charge annotation runs after named teleport cast reconstruction',()=>{
 const input={...raw,gameVersion:'sod',fight:{...raw.fight,encounterID:3197},
  actors:[{id:2,name:'Mason',type:'NPC',gameID:241021}],
  abilities:[{gameID:31,name:'Teleport'}],events:[
   {timestamp:1100,type:'cast',sourceID:2,abilityGameID:1228331,resourceActor:1,x:100,y:100},
   {timestamp:1200,type:'cast',sourceID:2,abilityGameID:31,resourceActor:1,x:600,y:100},
   {timestamp:1300,type:'cast',sourceID:2,abilityGameID:1228370,resourceActor:1,x:1100,y:100},
  ]};
 const r=enrichCombat(normalizeReplay(input),{},{}),actor=r.actors[0];
 assert.equal(actor.casts.find(c=>c.spell===31).name,'Teleport');
 assert.deepEqual(actor.chargeSegments,[[200,300]]);
 assert.equal(poseAt(actor,150).discontinuity,true);
 assert.deepEqual(poseAt(actor,150).pos,actor.samples[0].slice(1));
 const smooth=enrichCombat(normalizeReplay({...input,abilities:[],events:input.events.filter(e=>e.abilityGameID!==31).concat([
  {timestamp:1200,type:'damage',sourceID:2,resourceActor:1,x:600,y:100},
 ])}),{},{}).actors[0];
 assert.ok(poseAt(smooth,150).speed>35);assert.equal(poseAt(smooth,150).discontinuity,false);
});
test('Recorded self-aura removal caps finite channels without stretching their client timeout',()=>{
 for(const [durationMs,end,source] of [[60000,3000,'recorded self aura'],[2000,2000,'client spell data']]){
  const r=enrichCombat(normalizeReplay({...raw,events:[
   {timestamp:1000,type:'applybuff',sourceID:2,targetID:2,abilityGameID:30},
   {timestamp:1000,type:'cast',sourceID:2,abilityGameID:30},
   {timestamp:4000,type:'removebuff',targetID:2,abilityGameID:30},
  ]}),{}, {30:{channel:true,durationMs}});
  const c=r.actors.find(a=>a.key==='2:1').casts.find(c=>c.channel);
  assert.equal(c.end,end);assert.equal(c.timingSource,source);
 }
});
test('Council presentation windows participate in the normal import and pose path',()=>{
 const r=normalizeReplay({...raw,gameVersion:'sod',fight:{...raw.fight,encounterID:3188},
  actors:[{id:1,gameID:242660,type:'NPC',name:'Molten Basin'},{id:2,gameID:244819,type:'NPC',name:'Primordial Flame'}],
  events:[
   {timestamp:1000,type:'applybuff',sourceID:1,targetID:1,abilityGameID:1231133},
   {timestamp:1100,type:'applybuff',sourceID:2,targetID:2,abilityGameID:1236152,x:100,y:200,resourceActor:1},
   {timestamp:3000,type:'removebuff',targetID:1,abilityGameID:1231133},
  ]});
 const a=r.actors.find(a=>a.key==='2:1');
 assert.equal(a.presentationEvidence.kind,'encounter-lifecycle-inference');
 for(const [t,visible] of [[100,true],[2000,false],[0,false],[1999,true],[100,true]])assert.equal(!!poseAt(a,t),visible);
});
test('Current WCL resources map to the correct actor instance and WoW axes',()=>{
 const r=normalizeReplay(raw);const mob=r.actors.find(a=>a.key==='2:1');
 assert.deepEqual(mob.samples[0],[0,1011.87,-974.4,null]);
 assert.equal(r.actors.find(a=>a.key==='2:2').samples.length,1);
 assert.equal(r.actors.find(a=>a.key==='1:1').samples.length,0);
 const midway=poseAt(mob,1000);assert.ok(Math.abs(midway.pos[0]-1012.87)<1e-6);assert.ok(Math.abs(midway.pos[1]+975.4)<1e-6);
 assert.equal(poseAt(mob,3500).dead,true);assert.equal(poseAt(mob,500).dead,false);
 assert.equal(poseAt(mob,9000).stale,true);
});
test('Clock pauses, scrubs deterministically and stops at encounter end',()=>{
 const clock=new ReplayClock(1000);clock.toggle();clock.tick(300);clock.toggle();clock.tick(300);assert.equal(clock.time,300);
 clock.seek(100);assert.equal(clock.time,100);clock.rate=2;clock.toggle();clock.tick(1000);assert.equal(clock.time,1000);assert.equal(clock.playing,false);
 assert.equal(reportCode('https://vanilla.warcraftlogs.com/reports/DyN7vF94QR8aj1Lc?fight=4'),'DyN7vF94QR8aj1Lc');
 assert.throws(()=>reportCode('https://example.org/reports/DyN7vF94QR8aj1Lc'));
});
test('Pagination follows continuation even when a page is empty and rejects stalled cursors',async()=>{
 const cursors=[];const events=await collectEvents(async start=>{cursors.push(start);return start===0?{data:[],nextPageTimestamp:20}:{data:[{timestamp:20}],nextPageTimestamp:null};},0,30);
 assert.deepEqual(cursors,[0,20]);assert.equal(events.length,1);
 await assert.rejects(collectEvents(async()=>({data:[],nextPageTimestamp:0}),0,30),/did not advance/);
});

import {enrichCombat,combatStateAt,eventsBetween} from './replay.mjs';
test('Combat state reconstructs health, cast completion, gear, race evidence and pet ownership after rewind',()=>{
 const data={...raw,abilities:[{gameID:10,name:'Healing Touch'},{gameID:20589,name:'Escape Artist'}],actors:[...raw.actors,{id:3,name:'Wolf',type:'Pet',gameID:1234567,petOwner:1}],events:[
 {timestamp:1000,type:'combatantinfo',sourceID:1,faction:1,gear:[{id:100}],auras:[{ability:20}]},
 {timestamp:1200,type:'begincast',sourceID:1,abilityGameID:10},
 {timestamp:1400,type:'damage',sourceID:2,targetID:1,resourceActor:2,hitPoints:60,maxHitPoints:100,abilityGameID:1,amount:40},
 {timestamp:2200,type:'cast',sourceID:1,targetID:1,abilityGameID:10},
 {timestamp:2300,type:'applybuff',targetID:1,sourceID:1,abilityGameID:30},
 {timestamp:2400,type:'removebuff',targetID:1,sourceID:1,abilityGameID:20},
 {timestamp:2500,type:'cast',sourceID:1,abilityGameID:20589},
 {timestamp:2600,type:'damage',sourceID:3,targetID:2,abilityGameID:1,amount:1},
 ]};
 const replay=enrichCombat(normalizeReplay(data),{100:{display:55}}),actor=replay.actors.find(a=>a.id===1);
 assert.equal(actor.gear[0].model.display,55);assert.equal(actor.race,7);assert.equal(actor.raceSource,'Recorded Escape Artist');
 assert.equal(combatStateAt(actor,500).health.percent,.6);assert.equal(combatStateAt(actor,500).cast.name,'Healing Touch');
 assert.equal(combatStateAt(actor,1250).cast,null);assert.deepEqual(combatStateAt(actor,1350).auras.map(a=>a.spell),[20,30]);
 assert.deepEqual(combatStateAt(actor,1450).auras.map(a=>a.spell),[30]);
 assert.equal(combatStateAt(actor,100).health,null);assert.equal(combatStateAt(actor,300).cast.name,'Healing Touch');
 assert.equal(replay.actors.find(a=>a.id===3).ownerName,'Player');
 assert.deepEqual(eventsBetween(replay,1100,1300).map(e=>e.kind),['go']);
});

import {fullRunFight} from './wcl-report.mjs';
import {chapterAt} from './replay.mjs';
test('Full run preserves gaps, unions players and retains final boss without summary duplicates',()=>{
 const report={fights:[
  {id:9,name:'Other zone',startTime:0,endTime:999999,gameZone:{name:'Onyxia'}},
  {id:3,name:'Ragnaros',startTime:21000,endTime:25000,friendlyPlayers:[1,3],gameZone:{name:'Molten Core'}},
  {id:0,name:'Summary',completeRaid:true,startTime:0,endTime:30000,gameZone:{name:'Molten Core'}},
  {id:1,name:'Trash',startTime:1000,endTime:5000,friendlyPlayers:[1,2],gameZone:{name:'Molten Core'}},
 ]};
 const fight=fullRunFight(report,409),replay=normalizeReplay({...raw,fight});
 assert.equal(replay.duration,24000);assert.deepEqual(fight.friendlyPlayers,[1,2,3]);
 assert.deepEqual(replay.chapters.map(c=>c.start),[0,20000]);
 assert.equal(replay.gaps[0].hasEvents,false);
 assert.equal(chapterAt(replay,3000).name,'Trash');assert.equal(chapterAt(replay,10000),null);
 assert.equal(chapterAt(replay,21000).name,'Ragnaros');assert.equal(chapterAt(replay,24000).name,'Ragnaros');
 assert.equal(chapterAt(replay,0).name,'Trash');assert.throws(()=>fullRunFight({fights:[]}),/no supported raid/);
});
test('Run rewind restores life and buffs, and living NPC tracks persist between pulls',()=>{
 const fight={...raw.fight,chapters:[{...raw.fight,id:1}]};
 const events=[
 {timestamp:1000,type:'combatantinfo',sourceID:1,auras:[{ability:10}]},
 {timestamp:1200,type:'damage',sourceID:2,targetID:1,resourceActor:2,x:100,y:200,hitPoints:100,maxHitPoints:100},
 {timestamp:2000,type:'death',targetID:1},
 {timestamp:3000,type:'combatantinfo',sourceID:1,auras:[{ability:20}]},
 {timestamp:3200,type:'heal',targetID:1,sourceID:2,resourceActor:2,x:300,y:400,hitPoints:100,maxHitPoints:100},
 {timestamp:3200,type:'damage',sourceID:1,targetID:2,resourceActor:2,x:300,y:400},
 ];
 const r=enrichCombat(normalizeReplay({...raw,fight,events})),player=r.actors.find(a=>a.id===1),mob=r.actors.find(a=>a.id===2);
 assert.equal(poseAt(player,1500).dead,true);assert.equal(poseAt(player,2500).dead,false);
 assert.deepEqual(combatStateAt(player,2500).auras.map(a=>a.spell),[20]);
 assert.deepEqual(combatStateAt(player,500).auras.map(a=>a.spell),[10]);
 assert.ok(poseAt(mob,2500));assert.ok(poseAt(mob,8000));
});
test('Combat range selection keeps same-timestamp edges and stops pagination at requested end',async()=>{
 const replay={combat:[{t:1},{t:2},{t:2},{t:10}]};assert.deepEqual(eventsBetween(replay,1,2),[{t:2},{t:2}]);assert.deepEqual(eventsBetween(replay,5,3),[]);
 let pages=0;const events=await collectEvents(async()=>{pages++;return {data:[{timestamp:5}],nextPageTimestamp:20};},0,10);
 assert.equal(pages,1);assert.equal(events.length,1);
});
test('WCL negative melee sentinel maps to the client melee ID before the unsigned WASM bridge',()=>{
 const replay=enrichCombat(normalizeReplay({...raw,abilities:[{gameID:-4,name:'Melee'}],events:[
  {timestamp:1500,type:'cast',sourceID:1,targetID:2,abilityGameID:-4},
  {timestamp:1600,type:'damage',sourceID:1,targetID:2,abilityGameID:-4,amount:20},
 ]}));
 assert.equal(replay.combat[0].spell,1);assert.equal(replay.combat[0].name,'Melee');assert.equal(replay.combat[1].melee,true);
});
test('Optional gap smoothing is labelled, player-only and never changes recorded endpoints or combat state',()=>{
 const actor={type:'Player',samples:[[0,0,0,null],[80000,80,0,null]],deaths:[]};
 assert.equal(poseAt(actor,40000).pos[0],0);assert.equal(poseAt(actor,40000).estimated,false);
 const smooth=poseAt(actor,40000,true);assert.equal(smooth.pos[0],40);assert.equal(smooth.estimated,true);assert.equal(smooth.stale,true);
 assert.equal(poseAt(actor,80000,true).pos[0],80);assert.equal(poseAt(actor,80000,true).estimated,false);
 assert.equal(poseAt({...actor,type:'NPC'},40000,true).pos[0],0);
 assert.equal(poseAt({...actor,samples:[[0,0,0,null],[130000,80,0,null]]},40000,true).estimated,false);
});

test('Recorded facing drives stationary mobs and interpolates across angle wrap by the short arc',()=>{
 const events=[
  {timestamp:1000,sourceID:1,targetID:2,resourceActor:2,x:100,y:200,facing:-470},
  {timestamp:2000,sourceID:1,targetID:2,resourceActor:2,x:100,y:200,facing:-475},
 ];
 const mob=normalizeReplay({...raw,events}).actors.find(a=>a.id===2);
 const first=-events[0].facing/100-Math.PI/2;
 assert.ok(Math.abs(poseAt(mob,0).facing-first)<1e-9);
 assert.ok(Math.abs(poseAt(mob,500).facing-(first+.025))<1e-9);
 assert.equal(poseAt(mob,500).speed,0);
 assert.equal(poseAt(mob,2000).facing,mob.facings[1][1]);
 const wrapped={...mob,facings:[[0,Math.PI-.05],[1000,-Math.PI+.05]]};
 assert.ok(Math.abs(poseAt(wrapped,500).facing-Math.PI)<1e-9);
 assert.deepEqual(poseAt(mob,500),poseAt(mob,500));
});
test('Missing facing holds the last movement heading when a mob stops, independent of seek order',()=>{
 const events=[1000,2000,3000,4000].map((timestamp,i)=>({timestamp,sourceID:1,targetID:2,resourceActor:2,x:i?200:100,y:200}));
 const mob=normalizeReplay({...raw,events}).actors.find(a=>a.id===2);
 assert.equal(poseAt(mob,500).facing,-Math.PI/2);
 assert.equal(poseAt(mob,2500).facing,-Math.PI/2);
 assert.equal(poseAt(mob,2500).speed,0);
 assert.equal(poseAt(mob,500).facing,poseAt(mob,2500).facing);
});

test('Mobs spawn at their first known location from the start, hold gaps and disappear only at recorded death',()=>{
 const events=[
  {timestamp:5000,sourceID:1,targetID:2,resourceActor:2,x:100,y:200,facing:-470},
  {timestamp:7000,sourceID:1,targetID:2,resourceActor:2,x:200,y:400,facing:-470},
  {timestamp:10000,type:'death',targetID:2},
 ];
 const replay=normalizeReplay({...raw,fight:{...raw.fight,chapters:[{...raw.fight,id:1}]},events});
 const mob=replay.actors.find(a=>a.id===2);
 assert.deepEqual(poseAt(mob,0).pos,[2,-1,null]);
 assert.equal(poseAt(mob,0).speed,0);assert.equal(poseAt(mob,0).dead,false);
 assert.equal(poseAt(mob,0).facing,mob.facings[0][1]);
 assert.deepEqual(poseAt(mob,8500).pos,[4,-2,null]);
 assert.equal(poseAt(mob,9000).dead,true);
 assert.equal(poseAt(mob,0).dead,false);
 assert.equal(poseAt({...mob,type:'Player'},0),null);
 assert.equal(poseAt({...mob,samples:[]},0),null);
});

test('Pre-spawned mobs start at full recorded maximum HP and switch to exact log health on time',()=>{
 const actor={type:'NPC',health:[[5000,{current:800,max:1000,percent:.8}],[6000,{current:200,max:1000,percent:.2}]]};
 assert.deepEqual(combatStateAt(actor,0).health,{current:1000,max:1000,percent:1,initial:true});
 assert.equal(combatStateAt(actor,4999).health.percent,1);
 assert.deepEqual(combatStateAt(actor,5000).health,actor.health[0][1]);
 assert.equal(combatStateAt(actor,6500).health.current,200);
 assert.equal(combatStateAt(actor,0).health.current,1000);
 assert.equal(combatStateAt({...actor,type:'Player'},0).health,null);
 assert.equal(combatStateAt({type:'NPC'},0).health.percent,1);
});

test('Resource-change caps and gains belong to the recipient and never fabricate a current pool', async()=>{
 const {enrichCombat,combatStateAt}=await import('./replay.mjs');
 const raw={report:{code:'DyN7vF94QR8aj1Lc'},fight:{startTime:1000,endTime:10000,gameZone:{name:'Molten Core'},friendlyPlayers:[1,2]},actors:[{id:1,name:'Priest',type:'Player',subType:'Priest'},{id:2,name:'Mage',type:'Player',subType:'Mage'}],abilities:[{gameID:1,name:'Restore mana'}],events:[
 {timestamp:2000,type:'resourcechange',sourceID:1,targetID:2,abilityGameID:1,resourceChangeType:0,resourceChange:325,maxResourceAmount:7982,waste:25},
 {timestamp:3000,type:'cast',sourceID:2,abilityGameID:1,sourceResources:{classResources:[{type:0,amount:0,max:7982}]}},
 {timestamp:4000,type:'resourcechange',sourceID:1,targetID:2,abilityGameID:1,resourceChangeType:0,resourceChange:200,maxResourceAmount:7982,waste:0,targetResources:{classResources:[{type:0,amount:500,max:7982}]}},
 {timestamp:5000,type:'resourcechange',sourceID:1,targetID:2,abilityGameID:1,resourceChangeType:27,resourceChange:35,maxResourceAmount:1000000,waste:0},
 ]};
 const r=enrichCombat(normalizeReplay(raw)),mage=r.actors.find(a=>a.id===2),priest=r.actors.find(a=>a.id===1);
 assert.equal(combatStateAt(mage,999).power,null);
 assert.deepEqual(combatStateAt(mage,1000).power,{type:0,current:null,max:7982});assert.equal(priest.resourceChanges.length,0);
 assert.equal(combatStateAt(mage,2000).power.current,0);
 assert.equal(combatStateAt(mage,3000).power.current,500);
 assert.equal(combatStateAt(mage,4000).power.type,0);
 assert.equal(combatStateAt(mage,1000).resources.changes[0].gain,325);assert.equal(combatStateAt(mage,1000).resources.totals[0].waste,25);
 assert.equal(combatStateAt(mage,999).resources.changes.length,0);
 assert.equal(combatStateAt(mage,9000).resources.changes.length,0);
});
test('Rage and energy caps retain their resource type and separate five-second totals',async()=>{
 const {enrichCombat,combatStateAt}=await import('./replay.mjs');
 const raw={report:{code:'DyN7vF94QR8aj1Lc'},fight:{startTime:0,endTime:10000,gameZone:{name:'Molten Core'},friendlyPlayers:[1]},actors:[{id:1,name:'Druid',type:'Player',subType:'Druid'}],events:[{timestamp:1000,type:'resourcechange',sourceID:1,targetID:1,resourceChangeType:1,resourceChange:10,maxResourceAmount:1000,waste:0},{timestamp:2000,type:'resourcechange',sourceID:1,targetID:1,resourceChangeType:3,resourceChange:25,maxResourceAmount:100,waste:5}]};
 const a=enrichCombat(normalizeReplay(raw)).actors[0];
 assert.deepEqual(combatStateAt(a,1000).power,{type:1,current:null,max:1000});assert.deepEqual(combatStateAt(a,2000).power,{type:3,current:null,max:100});assert.deepEqual(combatStateAt(a,2000).resources.totals,[{type:1,gain:10,waste:0},{type:3,gain:25,waste:5}]);
});

import {RAIDS,raidForZone,reportRaids} from './raids.mjs';
test('Every raid normalizes to its client map without trusting WCL zone ids',()=>{
 for(const raid of RAIDS){
  const replay=normalizeReplay({...raw,gameVersion:raid.rulesets?.[0]??'vanilla',fight:{...raw.fight,gameZone:{id:999,name:raid.name}}});
  assert.equal(replay.map,raid.map);
 }
 assert.equal(raidForZone({name:'Onyxia'}).map,249);
 assert.equal(raidForZone({name:"Ahn'Qiraj"}).map,531);
 assert.equal(raidForZone({id:409,name:'Unsupported raid'}),undefined);
 assert.throws(()=>normalizeReplay({...raw,fight:{...raw.fight,gameZone:{name:'Karazhan'}}}),/Unsupported raid/);
});
test('Mixed reports require a raid choice and full runs never mix chapters or players from different maps',()=>{
 const report={fights:[
  {...raw.fight,id:1,gameZone:{name:'Molten Core'},friendlyPlayers:[1]},
  {...raw.fight,id:2,gameZone:{name:'Blackwing Lair'},friendlyPlayers:[2]},
 ]};
 assert.equal(reportRaids(report).length,2);
 assert.throws(()=>fullRunFight(report),/multiple raids/);
 assert.equal(fullRunFight(report,409).chapters.length,1);
 assert.deepEqual(fullRunFight(report,469).friendlyPlayers,[2]);
 assert.equal(fullRunFight(report,469).gameZone.name,'Blackwing Lair');
 assert.throws(()=>fullRunFight(report,533),/not present/);
});

import {visualEventsBetween} from './replay.mjs';
const actions=(events,spells={})=>enrichCombat(normalizeReplay({...raw,events}),{},spells);
test('Instant procs retain timestamps and do not consume another spell pending cast',()=>{
 const r=actions([
  {timestamp:1100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:1200,type:'cast',sourceID:1,abilityGameID:20},
  {timestamp:3100,type:'cast',sourceID:1,abilityGameID:10},
 ]);
 const casts=r.actors.find(a=>a.id===1).casts;
 assert.equal(casts[0].end,2100);assert.equal(casts[0].timingSource,'recorded');
 assert.equal(casts[1].start,200);assert.equal(casts[1].end,200);assert.equal(casts[1].instant,true);
});
test('Unmatched casts use local/observed hints and never invent a ten second cast',()=>{
 const r=actions([
  {timestamp:1100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:3600,type:'cast',sourceID:1,abilityGameID:10},
  {timestamp:4100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:5100,type:'begincast',sourceID:1,abilityGameID:20},
  {timestamp:6100,type:'begincast',sourceID:1,abilityGameID:30},
 ],{20:{castMs:3000}});
 const casts=r.actors.find(a=>a.id===1).casts;
 assert.equal(casts[1].timingSource,'observed casts');assert.equal(casts[1].outcome,'superseded');assert.equal(casts[1].end,4100);
 assert.equal(casts[1].interrupted,false);assert.equal(casts[2].timingSource,'client spell data');assert.equal(casts[2].end,5100);
 assert.equal(casts[3].timingSource,'unknown');assert.equal(casts[3].end,casts[3].start);
});
test('Recorded interrupts match the interrupted spell and death closes a channel at its logged timestamp',()=>{
 const r=actions([
  {timestamp:1100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:1200,type:'interrupt',sourceID:2,targetID:1,extraAbilityGameID:20},
  {timestamp:1300,type:'interrupt',sourceID:2,targetID:1,extraAbilityGameID:10},
  {timestamp:2000,type:'cast',sourceID:1,targetID:2,abilityGameID:30},
  {timestamp:3500,type:'death',targetID:1},
 ],{10:{castMs:3000},30:{channel:true,durationMs:8000}});
 const a=r.actors.find(a=>a.id===1);
 assert.equal(a.casts[0].end,300);assert.equal(a.casts[0].interrupted,true);assert.equal(a.casts[0].inferredEnd,false);
 const channel=a.casts[1];assert.equal(channel.channel,true);assert.equal(channel.start,1000);assert.equal(channel.end,2500);assert.equal(channel.outcome,'death');
 assert.equal(combatStateAt(a,2499).cast.channel,true);assert.equal(combatStateAt(a,2500).cast,null);
});
test('Casts cannot pair through a new encounter or out-of-order raw delivery',()=>{
 const r=actions([
  {timestamp:5000,type:'cast',sourceID:1,abilityGameID:10},
  {timestamp:1100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:2500,type:'encounterstart'},
 ],{10:{castMs:3000}});
 const cs=r.actors.find(a=>a.id===1).casts;
 assert.equal(cs[0].outcome,'encounter boundary');assert.equal(cs[0].end,1500);assert.equal(cs[1].instant,true);
});
test('Recorded completions and owned channel state survive an encounter end without a fabricated interrupt',()=>{
 const r=actions([
  {timestamp:1100,type:'begincast',sourceID:1,abilityGameID:10},
  {timestamp:2500,type:'encounterend'},
  {timestamp:5000,type:'cast',sourceID:1,abilityGameID:10},
 ],{10:{castMs:3000}});
 const c=r.actors.find(a=>a.id===1).casts;
 assert.equal(c.length,1);assert.equal(c[0].end,4000);assert.equal(c[0].outcome,'completed');assert.equal(c[0].inferredEnd,false);
 const held=actions([
  {timestamp:1100,type:'applybuff',sourceID:1,targetID:1,abilityGameID:10},
  {timestamp:1100,type:'cast',sourceID:1,targetID:1,abilityGameID:10},
  {timestamp:2500,type:'encounterend'},
  {timestamp:5000,type:'removebuff',targetID:1,abilityGameID:10},
 ],{10:{channel:true,durationMs:-1}}).actors.find(a=>a.id===1);
 assert.equal(held.casts.find(c=>c.channel).end,4000);
 assert.equal(combatStateAt(held,3999).cast?.spell,10);assert.equal(combatStateAt(held,4000).cast,null);
});
test('Visual playback keeps direct damage/healing times and multihit targets without firing missiles for DoT ticks',()=>{
 const r=actions([
  {timestamp:1100,type:'cast',sourceID:1,targetID:2,abilityGameID:10},
  {timestamp:1701,type:'damage',sourceID:1,targetID:2,abilityGameID:10,amount:20},
  {timestamp:1701,type:'heal',sourceID:1,targetID:1,abilityGameID:10,amount:5},
  {timestamp:1900,type:'damage',sourceID:1,targetID:2,abilityGameID:10,amount:2,tick:true},
 ]);
 assert.deepEqual(r.visualEvents.map(e=>[e.kind,e.t]),[['go',100],['impact',701],['impact',701]]);
 assert.deepEqual(r.visualEvents[0].impacts,[{target:'2:1',t:701},{target:'1:1',t:701}]);
 assert.equal(visualEventsBetween(r,100,701).length,2);assert.equal(visualEventsBetween(r,701,1000).length,0);
 assert.equal(r.combat.filter(e=>e.kind==='damage').length,2);
});
test('Movement smoothing preserves every anchor, eases a stop and never overshoots its segment',()=>{
 const a={type:'Player',samples:[[0,0,0,null],[1000,5,0,null],[2000,10,2,null],[3000,10,2,null]],deaths:[]};
 for(const s of a.samples)assert.deepEqual(poseAt(a,s[0]).pos,s.slice(1));
 for(let t=1000;t<=2000;t+=10){const p=poseAt(a,t);assert.ok(p.pos[0]>=5&&p.pos[0]<=10);assert.ok(p.pos[1]>=0&&p.pos[1]<=2);}
 assert.ok(poseAt(a,1999).speed<.1);assert.equal(poseAt(a,2500).speed,0);
 assert.deepEqual(poseAt(a,1500),poseAt(a,1500));
});
test('Movement holds teleports and life changes, qualifies sparse player movement and never changes raw samples',()=>{
 const samples=[[0,0,0,null],[1000,100,0,null]],a={type:'Player',samples,deaths:[]};
 assert.equal(poseAt(a,500,true).pos[0],0);assert.equal(poseAt(a,500,true).discontinuity,true);
 assert.equal(poseAt(a,1000).pos[0],100);
 const life={...a,samples:[[0,0,0,null],[2000,10,0,null]],deaths:[[500,true],[1500,false]]};
 assert.equal(poseAt(life,1600,true).pos[0],0);
 const sparse={...a,samples:[[0,0,0,null],[4000,10,0,null]]};
 assert.equal(poseAt(sparse,2000,false).positionSource,'held');assert.equal(poseAt(sparse,2000,true).estimated,true);
 assert.equal(poseAt({...sparse,type:'NPC'},2000,true).pos[0],0);
 assert.deepEqual(samples,[[0,0,0,null],[1000,100,0,null]]);
});

test('Repeated living resource snapshots do not break movement interpolation or create resurrection boundaries',()=>{
 const fight={...raw.fight,chapters:[{...raw.fight,id:1}]};
 const r=normalizeReplay({...raw,fight,events:[
 {timestamp:1000,sourceID:1,targetID:2,resourceActor:1,x:100,y:100,hitPoints:100},
 {timestamp:2000,sourceID:1,targetID:2,resourceActor:1,x:100,y:600,hitPoints:100},
 ]});
 const a=r.actors.find(a=>a.id===1);
 assert.deepEqual(a.deaths,[]);assert.equal(poseAt(a,500).pos[0],3.5);
});
test('Overlapping same-spell projectiles retain the correct target and FIFO result times',()=>{
 const r=actions([
 {timestamp:1100,type:'cast',sourceID:1,targetID:2,abilityGameID:10},
 {timestamp:1200,type:'cast',sourceID:1,targetID:2,abilityGameID:10},
 {timestamp:1600,type:'damage',sourceID:1,targetID:2,abilityGameID:10,amount:5},
 {timestamp:1700,type:'damage',sourceID:1,targetID:2,abilityGameID:10,amount:7},
 ]);
 assert.deepEqual(r.visualEvents.filter(e=>e.kind==='go').map(e=>e.impacts),[[{target:'2:1',t:600}],[{target:'2:1',t:700}]]);
});

test('Creature display scale survives replay normalization for every instance',()=>{
 const replay=normalizeReplay(raw,{'12118':{displayID:13031,scale:3}});
 assert.deepEqual(replay.actors.filter(a=>a.type==='NPC').map(a=>a.scale),[3,3]);
 assert.equal(replay.actors.find(a=>a.type==='Player').scale,1);
});

test('Unpositioned summons emit a brief illustrative cast cue, while tracked pets retain their recorded playback', async () => {
 const {enrichCombat}=await import('./replay.mjs');
 const input={...raw,actors:[...raw.actors,{id:3,name:'Summon',type:'Pet',gameID:220064,petOwner:1}],events:[...raw.events,{timestamp:2000,type:'summon',sourceID:1,targetID:3,abilityGameID:440802}]};
 const replay=enrichCombat(normalizeReplay(input));
 const cues=replay.visualEvents.filter(e=>e.kind==='summon-cue');
 assert.equal(cues.length,1);assert.equal(cues[0].t,1000);assert.equal(cues[0].source,'1:1');assert.equal(cues[0].illustrative,true);
 const tracked={...input,events:[...input.events,{timestamp:2100,type:'damage',sourceID:3,targetID:2,resourceActor:1,x:100,y:200,abilityGameID:440809}]};
 assert.equal(enrichCombat(normalizeReplay(tracked)).visualEvents.some(e=>e.kind==='summon-cue'),false);
});

test('Wisp presentation uses actor activity and active casts without hiding position uncertainty',()=>{
 const actor={type:'Player',samples:[[0,0,0,null],[30000,30,0,null]],deaths:[],activity:[0,10000]};
 assert.equal(poseAt(actor,1000,true).wisp,false,'a fresh position keeps the model');
 const active=poseAt(actor,12000,true);assert.equal(active.estimated,true);assert.equal(active.wisp,false);
 assert.equal(poseAt(actor,18000,true).wisp,true,'inactive inferred travel becomes a wisp');
 const channel={...actor,activity:[],casts:[{start:0,end:12000,instant:false}]};
 assert.equal(poseAt(channel,9000,true).wisp,false,'the full observed cast interval covers long channels');
 assert.equal(poseAt(channel,13000,true).wisp,true);
 const stationary={...actor,activity:[],samples:[[0,10,10,null],[30000,10,10,null]]};
 assert.equal(poseAt(stationary,15000,true).wisp,false,'stationary endpoints do not imply inferred travel');
 assert.equal(poseAt(actor,30000,true).estimated,false);
 assert.equal(poseAt(actor,18000,false).wisp,false);
});

test('Position-free cast, damage and healing events preserve actor coverage without manufacturing coordinates',()=>{
 const r=normalizeReplay({...raw,fight:{...raw.fight,startTime:0,endTime:30000,chapters:[{id:1,name:'Pull',startTime:0,endTime:17000}]},events:[
 {timestamp:0,type:'damage',sourceID:1,targetID:2,resourceActor:1,x:100,y:200},
 {timestamp:10000,type:'cast',sourceID:1,abilityGameID:133},
 {timestamp:15000,type:'heal',sourceID:2,targetID:1,amount:10},
 {timestamp:30000,type:'damage',sourceID:1,targetID:2,resourceActor:1,x:100,y:3200}
 ]});
 const player=r.actors.find(a=>a.id===1);
 assert.deepEqual(player.activity,[0,10000,15000,30000]);
 assert.equal(player.samples.length,2);
 assert.deepEqual(player.activityWindows,[[0,17000]]);
 assert.equal(poseAt(player,8000,true).wisp,false,'observed combat participation spans pauses between actions');
 assert.equal(poseAt(player,16000,true).estimated,true);
 assert.equal(poseAt(player,16000,true).wisp,false);
 assert.equal(poseAt(player,25000,true).wisp,true);
});

test('same-map zone changes preserve portal jumps instead of smoothing a walk through the intervening world',()=>{
 const events=[
  {timestamp:1000,type:'cast',sourceID:1,resourceActor:1,x:100,y:100},
  {timestamp:31000,type:'zonechange',zoneID:409},
  {timestamp:61000,type:'cast',sourceID:1,resourceActor:1,x:100,y:50100},
 ];
 const input={...raw,fight:{...raw.fight,endTime:71000},events};
 const actor=normalizeReplay(input).actors.find(a=>a.id===1);
 assert.deepEqual(poseAt(actor,40000,true).pos,[1,-1,null]);
 assert.equal(poseAt(actor,40000,true).estimated,false);
 assert.deepEqual(poseAt(actor,60000,true).pos,[501,-1,null]);
 const ordinary=normalizeReplay({...input,events:events.filter(e=>e.type!=='zonechange')}).actors.find(a=>a.id===1);
 assert.equal(poseAt(ordinary,40000,true).estimated,true);
});
