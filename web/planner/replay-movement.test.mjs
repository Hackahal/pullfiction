import test from 'node:test';
import assert from 'node:assert/strict';
import {poseAt, normalizeReplay, enrichCombat} from './replay.mjs';
import {prepareMovement} from './replay-movement.mjs';
const player = () => ({type:'Player', samples:[[0,0,0,null],[1000,6,0,null]], facings:[], deaths:[], casts:[], auras:[]});
test('short routes preserve anchors, normal run speed, moving-facing and seek independence', () => {
  const a=player(); a.samples.push([2000,6,0,null]);
  const mid=poseAt(a,500);
  assert.ok(mid.movement); assert.deepEqual(mid.movement.from,[0,0,null]);
  assert.equal(poseAt(a,0).movement.fraction,0);
  assert.deepEqual(poseAt(a,1000).pos,[6,0,null]);
  assert.equal(poseAt(a,999).speed,0);
  assert.equal(mid.speed,7);
  poseAt(a,1900); assert.deepEqual(poseAt(a,500),mid);
  a.facings=[[0,Math.PI/2]];
  assert.equal(poseAt(a,500).movement.recorded_facing,true);
  assert.equal(poseAt(a,500).facing,0);
  assert.equal(poseAt(a,999).facing,Math.PI/2);
});
test('Blink jumps at the recorded cast even below the old speed threshold', () => {
  const a=player(); a.casts=[{spell:1953,end:400,outcome:'completed',timingSource:'recorded'}]; prepareMovement(a);
  assert.deepEqual(poseAt(a,399).pos,[0,0,null]);
  assert.deepEqual(poseAt(a,400).pos,[6,0,null]);
  assert.equal(poseAt(a,400).speed,0); assert.equal(poseAt(a,400).movement,null);
  assert.equal(poseAt(a,400).discontinuity,true);
  assert.deepEqual(poseAt(a,1000).pos,[6,0,null]);
  assert.deepEqual(poseAt(a,399).pos,[0,0,null]);
  a.casts[0].timingSource='WCL inferred cast'; prepareMovement(a);
  assert.equal(poseAt(a,400).discontinuity,false);
});
test('Sprint application/removal changes speed at its timestamp without moving the endpoints', () => {
  const a=player(); a.auras=[[500,{spell:11305}],[800,{spell:11305,remove:true}]];prepareMovement(a);
  const before=poseAt(a,499), during=poseAt(a,500), after=poseAt(a,800);
  assert.ok(Math.abs(during.speed/before.speed-1.7)<1e-9);
  assert.ok(Math.abs(during.speed/after.speed-1.7)<1e-9);
  assert.deepEqual(poseAt(a,0).pos,[0,0,null]); assert.deepEqual(poseAt(a,1000).pos,[6,0,null]);
  assert.deepEqual(poseAt(a,500),during);
});
test('initial buffs, overlapping ranks, reset and Dash are deterministic', () => {
  const a=player(); a.initialAuras=[2983];
  a.auras=[[250,{spell:11305}],[500,{spell:11305,remove:true}],[750,{reset:[1850]}]];prepareMovement(a);
  assert.equal(a.movement.profile[0][1],1.5);
  assert.equal(a.movement.profile[1][1],1.7);
  assert.equal(a.movement.profile[2][1],1.5);
  assert.equal(a.movement.profile[3][1],1.5);
  assert.ok(poseAt(a,700).movement);
});
test('no route crosses a death, zone break or unloaded buffer hole; long gaps remain optional', () => {
  for (const extra of [{deaths:[[500,true]]},{positionBreaks:[500]},{bufferedRanges:[[0,400],[600,1000]]}]) {
    assert.equal(poseAt({...player(),...extra},750).movement,null);
  }
  const a=player();a.samples[1][0]=10000;
  assert.equal(poseAt(a,5000).movement,null);
  assert.equal(poseAt(a,5000,true).estimated,true);
  assert.equal(poseAt(a,5000,true).movement.unrestricted,true);
});
test('real normalization and combat enrichment feed ability reconstruction without rewriting raw logs', () => {
  const raw={report:{code:'DyN7vF94QR8aj1Lc'},fight:{startTime:1000,endTime:4000,gameZone:{name:'Molten Core'},friendlyPlayers:[1]},actors:[{id:1,type:'Player',name:'Mage',subType:'Mage'}],events:[
    {timestamp:1000,type:'cast',sourceID:1,resourceActor:1,x:100,y:100},
    {timestamp:1400,type:'cast',sourceID:1,abilityGameID:1953},
    {timestamp:2000,type:'cast',sourceID:1,resourceActor:1,x:100,y:700},
  ]};
  const original=JSON.stringify(raw), r=enrichCombat(normalizeReplay(raw)), a=r.actors[0];
  assert.deepEqual(poseAt(a,399).pos,[1,-1,null]);
  assert.deepEqual(poseAt(a,400).pos,[7,-1,null]);
  assert.equal(JSON.stringify(raw),original);
});

test('Swiftness potion uses its aura, and crafting the potion does not change speed', () => {
  const a=player(); a.auras=[[500,{spell:2379}]]; prepareMovement(a);
  assert.ok(Math.abs(poseAt(a,500).speed/poseAt(a,499).speed-1.5)<1e-9);
  a.auras=[[500,{spell:2335}]]; prepareMovement(a);
  assert.equal(poseAt(a,500).speed,7);
});

test('very dense observations cannot send a rate outside native transport bounds', () => {
  const a=player(); a.samples=[[0,0,0,null],[1,0.034,0,null],[2,0.034,0,null]];
  for(let t=0;t<2;t+=0.05){
    const pose=poseAt(a,t);
    assert.ok(!pose.movement || pose.movement.rate<=1000);
    assert.ok(Number.isFinite(pose.speed));
  }
});

test('a feasible short span runs at seven yards per second with deterministic holds', () => {
  const a=player();a.samples=[[0,0,0,null],[2000,7,0,null]];
  const raw=JSON.stringify(a.samples);
  for(const [t,x,speed] of [[0,0,0],[200,0,0],[600,.7,7],[1000,3.5,7],[1400,6.3,7],[1800,7,0],[2000,7,0]]){
    const p=poseAt(a,t);assert.ok(Math.abs(p.pos[0]-x)<1e-9);assert.equal(p.speed,speed);
  }
  assert.equal(JSON.stringify(a.samples),raw);
  const p=poseAt(a,1000);assert.equal(p.movement.travel_budget,14);assert.equal(p.movement.run_speed,7);
  poseAt(a,1900);assert.deepEqual(poseAt(a,1000),p);
});
test('recorded speed auras change translation pace as well as the native gait setting',()=>{
  const a=player();a.samples=[[0,0,0,null],[2000,14,0,null]];
  a.auras=[[500,{spell:11305}],[1500,{spell:11305,remove:true}]];prepareMovement(a);
  for(const [t,speed] of [[400,7],[600,11.9],[1550,7]]){
    const p=poseAt(a,t),next=poseAt(a,t+1);
    assert.ok(Math.abs(p.speed-speed)<1e-9);
    assert.ok(Math.abs((next.pos[0]-p.pos[0])*1000-speed)<1e-9);
    assert.equal(p.movement.run_speed,speed);
  }
  assert.deepEqual(poseAt(a,0).pos,[0,0,null]);assert.deepEqual(poseAt(a,2000).pos,[14,0,null]);
});
test('an impossible normal-run budget preserves recorded anchors and exposes the normal gait separately',()=>{
  const a=player();a.samples[1][1]=20;
  const p=poseAt(a,500);assert.equal(p.pos[0],10);assert.equal(p.speed,20);
  assert.equal(p.movement.run_speed,7);assert.equal(p.movement.travel_budget,7);
  assert.deepEqual(poseAt(a,1000).pos,[20,0,null]);
});
test('moving NPCs face the actual tangent despite a recorded facing, and held NPCs retain recorded facing',()=>{
  const a={...player(),type:'NPC',facings:[[0,Math.PI/2]]};
  assert.equal(poseAt(a,500).facing,0);assert.equal(poseAt(a,1000).facing,Math.PI/2);
});
test('wisps carry complete endpoint routes and free timing beyond normal running speed',()=>{
  const a=player();a.samples=[[0,0,0,null],[4000,100,0,null]];
  const p=poseAt(a,2500,true);assert.equal(p.wisp,true);assert.equal(p.speed,25);
  assert.equal(p.movement.unrestricted,true);assert.equal(p.movement.duration,4);
  assert.deepEqual(p.movement.to,[100,0,null]);assert.equal(p.movement.fraction,.625);
  assert.equal(poseAt(a,2500,false).movement,null);
  a.deaths=[[2000,true]];assert.equal(poseAt(a,2500,true).movement,null);
});
