import test from 'node:test';import assert from 'node:assert/strict';
import {applyAq40IllusionPresentation as apply} from './sod-aq40-illusions.mjs';
const actor=n=>({key:`97:${n}`,gameID:235668,initiallyPresent:true,samples:[[100,1,2,null]],auras:[],deaths:[],lifeEvents:[]});
const cast=(t,id,n=1,extra={})=>({timestamp:1000+t,type:'cast',sourceID:97,sourceInstance:n,abilityGameID:id,...extra});
const birth=(t,n=1,extra)=>cast(t,26586,n,extra),shatter=(t,n=1,extra)=>cast(t,1214871,n,extra);
const fixture=events=>({map:531,gameVersion:'sod',duration:1000,fight:{encounterID:100710},raw:{fight:{startTime:1000},events},actors:[actor(1),actor(2)]});
const visible=(a,t)=>a.presentationWindows?.some(([s,e])=>s<=t&&t<e);
test('independent observed source instances and repeated activations have deterministic exclusive windows',()=>{
 const r=fixture([birth(100),birth(150,2),shatter(200),birth(300),shatter(400),shatter(500,2)]),before=structuredClone(r),out=apply(r);
 assert.deepEqual(out.actors.map(a=>a.presentationWindows),[[[100,200],[300,400]],[[150,500]]]);
 for(const t of [350,99,150,400,199,100,500,300,200,350])assert.equal(!!visible(out.actors[0],t),t>=100&&t<200||t>=300&&t<400);
 assert.deepEqual(r,before);assert.equal(out.actors[0].samples,r.actors[0].samples);assert.equal(out.actors[0].auras,r.actors[0].auras);
 assert.deepEqual(apply(out),out);assert.equal(out.actors[0].presentationEvidence.kind,'encounter-lifecycle-inference');
});
test('full-run sources remain observed across boss end and trash chapters',()=>{
 const r=fixture([birth(100,1,{fight:6}),{timestamp:1200,type:'encounterend',encounterID:710,fight:6},shatter(250,1,{fight:7}),birth(400,2,{fight:7}),shatter(600,2,{fight:7})]);
 r.fight={chapters:[{id:6,encounterID:100710,startTime:1000,endTime:1200},{id:7,encounterID:0,startTime:1250,endTime:1800}]};
 assert.deepEqual(apply(r).actors.map(a=>a.presentationWindows),[[[100,250]],[[400,600]]]);
});
test('absence of terminal stays open to replay bound with unknown provenance; no observations outside buffer bounds',()=>{
 const r=fixture([birth(100),shatter(1100),birth(-1,2),shatter(500,2)]),out=apply(r);
 assert.deepEqual(out.actors[0].presentationWindows,[[100,1000]]);assert.match(out.actors[0].presentationEvidence.intervals[0].endEvidence,/unknown/);
 assert.equal(out.actors[1].presentationWindows,undefined,'out-of-bounds Birth cannot authorize an interval');
 const rebuilt=apply({...out,raw:{...r.raw,events:[birth(100),shatter(400)]}});
 assert.deepEqual(rebuilt.actors[0].presentationWindows,[[100,400]]);
});
test('explicit life/death and prior presentation restrictions are retained on repeated calls and rebuild',()=>{
 const r=fixture([birth(100),shatter(800)]);Object.assign(r.actors[0],{lifeEvents:[[200,true],[400,false],[600,true]],initiallyPresent:false,deaths:[[700,true]],presentationWindows:[[0,300],[350,900]],presentationEvidence:{kind:'previous'}});
 const out=apply(r);assert.deepEqual(out.actors[0].presentationWindows,[[200,300],[350,400],[600,700]]);assert.deepEqual(apply(out),out);
 const restored=apply({...out,raw:{...r.raw,events:[]}});assert.deepEqual(restored.actors[0].presentationWindows,r.actors[0].presentationWindows);assert.deepEqual(restored.actors[0].presentationEvidence,{kind:'previous'});
});
test('rejects unrelated ruleset, map, NPC, spell, event and instance identities',()=>{
 for(const extra of [{map:2856},{map:530},{gameVersion:'vanilla'}]){const r={...fixture([birth(100)]),...extra};assert.equal(apply(r),r);}
 const r=fixture([birth(100)]);r.actors[0].gameID=15621;assert.equal(apply(r).actors[0],r.actors[0]);
 for(const events of [[cast(100,26585)],[{...birth(100),type:'applybuff'}],[shatter(200)],[birth(100,3)]])assert.equal(apply(fixture(events)).actors[0].presentationWindows,undefined);
});
test('duplicate, unordered and repeated Birth records preserve unknown prior terminal without guessing a gap',()=>{
 const out=apply(fixture([shatter(500),birth(300),birth(100),birth(100)]));
 assert.deepEqual(out.actors[0].presentationWindows,[[100,500]]);
 assert.deepEqual(out.actors[0].presentationEvidence.intervals.map(r=>[r.start,r.end]),[[100,300],[300,500]]);
 assert.match(out.actors[0].presentationEvidence.intervals[0].endEvidence,/prior terminal unknown/);
});
test('repeated pulls reuse the same source instance while explicit death remains authoritative',()=>{
 const r=fixture([birth(100,1,{fight:6}),shatter(200,1,{fight:6}),birth(500,1,{fight:8}),shatter(700,1,{fight:8})]);
 r.fight={chapters:[{id:6,encounterID:100710,startTime:1000,endTime:1300},{id:8,encounterID:100710,startTime:1400,endTime:1800}]};
 r.actors[0].deaths=[[150,true],[500,false]];
 const out=apply(r);assert.deepEqual(out.actors[0].presentationWindows,[[100,150],[500,700]]);
 assert.deepEqual(out.actors[0].deaths,r.actors[0].deaths);
});
