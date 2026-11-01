import test from 'node:test';import assert from 'node:assert/strict';
import {masonChargeEvidence,measuredMasonChargeSegment} from './sod-mason.mjs';
const a={key:'113:1',gameID:241021,samples:[[100,0,0,null],[200,5,0,null],[300,10,0,null],[400,15,0,null]]};
const r={gameVersion:'sod',fight:{encounterID:3197},duration:1000,raw:{fight:{startTime:1000},events:[{timestamp:1100,type:'cast',sourceID:113,abilityGameID:1228331},{timestamp:1400,type:'cast',sourceID:113,abilityGameID:1228370}]}};
test('observed actor-specific Blade Dance gates dense measured charge anchors',()=>{
 const e=masonChargeEvidence(r,a);assert.deepEqual(e.map(w=>[w.start,w.end]),[[100,400]]);
 for(const i of [1,0,2,0,2,1])assert.equal(measuredMasonChargeSegment(a,a.samples[i],a.samples[i+1],e),true);
 assert.deepEqual(a.samples,[[100,0,0,null],[200,5,0,null],[300,10,0,null],[400,15,0,null]]);
});
test('unrelated rulesets, encounters, NPCs, instances and missing phases remain gated',()=>{
 for(const rr of [{...r,gameVersion:'vanilla'},{...r,fight:{encounterID:3188}},{...r,raw:{...r.raw,events:r.raw.events.slice(1)}}])assert.deepEqual(masonChargeEvidence(rr,a),[]);
 assert.deepEqual(masonChargeEvidence(r,{...a,gameID:244122}),[]);assert.deepEqual(masonChargeEvidence(r,{...a,key:'113:2'}),[]);
});
test('rejects sparse, isolated, slow and nonconsecutive anchors',()=>{
 const e=masonChargeEvidence(r,a);
 assert.equal(measuredMasonChargeSegment(a,a.samples[0],a.samples[3],e),false);
 const sparse={...a,samples:[[100,0,0,null],[400,20,0,null]]};assert.equal(measuredMasonChargeSegment(sparse,...sparse.samples,e),false);
 const isolated={...a,samples:a.samples.slice(0,2)};assert.equal(measuredMasonChargeSegment(isolated,...isolated.samples,e),false);
 const slow={...a,samples:[[100,0,0,null],[200,1,0,null],[300,2,0,null]]};assert.equal(measuredMasonChargeSegment(slow,slow.samples[0],slow.samples[1],e),false);
});
test('explicit teleport, lifecycle, death and zone boundaries always win',()=>{
 const e=masonChargeEvidence(r,a);
 for(const extra of [{positionBreaks:[150]},{lifeEvents:[[150,false]]},{deaths:[[150,true]]},{movement:{blinks:[[150]]}},{teleports:[150]}])assert.equal(measuredMasonChargeSegment({...a,...extra},a.samples[0],a.samples[1],e),false);
});
test('full-run encounter chapters keep root-relative times and reject unrelated casts',()=>{
 const rr={...r,fight:{chapters:[{id:7,encounterID:3197,startTime:1000,endTime:2000},{id:8,encounterID:3188,startTime:2000,endTime:3000}]},duration:2000,raw:{...r.raw,events:[...r.raw.events.map(e=>({...e,fight:7})),{timestamp:2100,type:'cast',sourceID:113,abilityGameID:1228331,fight:8},{timestamp:2400,type:'cast',sourceID:113,abilityGameID:1228370,fight:8}]}};
 assert.deepEqual(masonChargeEvidence(rr,a).map(w=>[w.start,w.end]),[[100,400]]);
});
test('raw explicit teleport and completed named teleport veto a measured charge segment',()=>{
 const raw={...r,raw:{...r.raw,events:[...r.raw.events,{timestamp:1150,type:'teleport',sourceID:113}]}};
 assert.equal(measuredMasonChargeSegment(a,a.samples[0],a.samples[1],masonChargeEvidence(raw,a)),false);
 const named={...a,casts:[{name:'Teleport',outcome:'completed',end:150}]};
 assert.equal(measuredMasonChargeSegment(named,a.samples[0],a.samples[1],masonChargeEvidence(r,named)),false);
});
