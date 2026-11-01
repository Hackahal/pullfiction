import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCouncilPresentation} from './sod-reborn-council.mjs';
const event=(t,type,sourceID,targetID,abilityGameID,extra={})=>({timestamp:1000+t,type,sourceID,targetID,abilityGameID,...extra});
const basin=(t,type='applybuff')=>event(t,type,10,10,1231133);
const flame=(t,n)=>event(t,'applybuff',11,11,1236152,{sourceInstance:n,targetInstance:n});
const actor=n=>({key:`11:${n}`,gameID:244819,initiallyPresent:true});
function fixture(events){return {gameVersion:'sod',fight:{encounterID:3188},duration:200000,actors:[{key:'10:1',gameID:242660},...Array.from({length:4},(_,i)=>actor(i+1))],raw:{fight:{startTime:1000},events}};}
const input=()=>fixture([basin(99855),flame(99936,1),flame(99936,2),basin(149783,'removebuff'),flame(173685,3),flame(173685,4),basin(173686),event(186034,'encounterend')]);
const windows=r=>r.actors.filter(a=>a.gameID===244819).map(a=>a.presentationWindows);
const visible=(a,t)=>a.presentationWindows?.some(([s,e])=>s<=t&&t<e);
test('links original and death-triggered pairs to their own recorded Basin intervals',()=>{
 const original=input(),before=structuredClone(original),r=applyCouncilPresentation(original);
 assert.deepEqual(windows(r),[[[99936,149783]],[[99936,149783]],[[173685,186034]],[[173685,186034]]]);
 assert.deepEqual(original,before,'helper does not mutate replay or source events');
 assert.equal(r.actors[3].presentationEvidence.orderingSkewMs,1);
 assert.equal(r.actors[1].presentationEvidence.kind,'encounter-lifecycle-inference');
 for(const t of [180000,160000,100000,99855,180000,149783,99936,186034]) {
  const active=r.actors.filter(a=>visible(a,t)).map(a=>a.key);
  assert.deepEqual(active,t>=173685&&t<186034?['11:3','11:4']:t>=99936&&t<149783?['11:1','11:2']:[]);
 }
 assert.deepEqual(applyCouncilPresentation(r),r,'repeated application is deterministic');
});
test('keeps open observed Basin active through replay duration, not last buffered event',()=>{
 const raw=fixture([basin(99855),flame(99936,1)]),r=applyCouncilPresentation(raw);
 assert.deepEqual(r.actors[1].presentationWindows,[[99936,200000]]);
 assert.match(r.actors[1].presentationEvidence.endEvidence,/unobserved/);
 const expanded=applyCouncilPresentation({...r,raw:{...raw.raw,events:[...raw.raw.events,basin(149783,'removebuff')]}});
 assert.deepEqual(expanded.actors[1].presentationWindows,[[99936,149783]]);
});
test('does not infer without Basin application or positive Flame activation',()=>{
 for(const events of [[flame(100,1)],[basin(100)],[basin(100,'removebuff'),flame(200,1)],[basin(100),flame(97,1)],[basin(100),event(200,'damage',-1,11,1236157)]])
  assert.equal(applyCouncilPresentation(fixture(events)).actors[1].presentationWindows,undefined);
 const r=applyCouncilPresentation(input());
 assert.equal(applyCouncilPresentation({...r,raw:{...r.raw,events:[]}}).actors[1].presentationWindows,undefined,'buffer rebuild removes obsolete own inference');
});
test('strict ruleset, encounter, NPC and spell identities prevent cross-fight inference',()=>{
 for(const change of [{gameVersion:'vanilla'},{fight:{encounterID:3187}}]) {const r={...input(),...change};assert.equal(applyCouncilPresentation(r),r);}
 const r=input();r.actors[0].gameID=123;assert.equal(applyCouncilPresentation(r).actors[1].presentationWindows,undefined);
 const s=input();s.raw.events=s.raw.events.map(e=>e.abilityGameID===1231133?{...e,abilityGameID:1231376}:e);assert.equal(applyCouncilPresentation(s).actors[1].presentationWindows,undefined);
});
test('recorded summon, destroy and death boundaries constrain inferred visibility',()=>{
 const r=fixture([basin(100),flame(200,1),event(250,'destroy',-1,11,0,{targetInstance:1}),event(300,'summon',-1,11,0,{targetInstance:1}),event(400,'death',-1,11,0,{targetInstance:1}),basin(500,'removebuff')]);
 assert.deepEqual(applyCouncilPresentation(r).actors[1].presentationWindows,[[200,250],[300,400]]);
 const delayed=fixture([basin(100),flame(200,1),event(300,'summon',-1,11,0,{targetInstance:1})]);delayed.actors[1].initiallyPresent=false;
 assert.deepEqual(applyCouncilPresentation(delayed).actors[1].presentationWindows,[[300,200000]]);
});
test('duplicate aura applications preserve original window; unsorted buffers are stable',()=>{
 const r=fixture([flame(200,1),basin(150),basin(100),basin(500,'removebuff'),basin(900),flame(901,2)]);
 assert.deepEqual(windows(applyCouncilPresentation(r)).slice(0,2),[[[200,500]],[[901,200000]]]);
});
test('full-run chapters scope independent pulls and retain unrelated presentation',()=>{
 const r=fixture([
  {...basin(100),fight:1}, {...flame(200,1),fight:1},
  {...event(800,'encounterend'),fight:1,encounterID:3188},
  // These look like Council spell IDs but belong to an unrelated encounter.
  {...basin(1100),fight:2},{...flame(1200,2),fight:2},
  {...event(1300,'encounterend'),fight:2,encounterID:3187},
  {...basin(2100),fight:3},{...flame(2200,1),fight:3},
  // An unrelated end inside the later chapter must not truncate its window.
  {...event(2300,'encounterend'),fight:2,encounterID:3187},
 ]);
 r.duration=4000;r.fight={chapters:[
  {id:1,encounterID:3188,startTime:1000,endTime:2000},
  {id:2,encounterID:3187,startTime:2000,endTime:3000},
  {id:3,encounterID:3188,startTime:3000,endTime:4000},
 ]};
 const out=applyCouncilPresentation(r),a=out.actors[1];
 assert.deepEqual(a.presentationWindows,[[200,800],[1000,2000],[2200,4000]]);
 assert.deepEqual(a.presentationEvidence.intervals.map(x=>x.chapterId),[1,3]);
 assert.deepEqual(a.presentationEvidence.intervals.map(x=>x.basinWindow),[[100,800],[2100,3000]]);
 assert.equal(out.actors[2],r.actors[2],'unrelated-only actor remains untouched');
 for(const t of [2500,900,1500,300,2500])assert.equal(!!visible(a,t),t===900?false:true);
});
test('reused actor-instance can reactivate in distinct Basin windows in one chapter',()=>{
 const r=fixture([basin(100),flame(150,1),flame(151,1),basin(200,'removebuff'),basin(300),flame(350,1),basin(400,'removebuff')]);
 const a=applyCouncilPresentation(r).actors[1];
 assert.deepEqual(a.presentationWindows,[[150,200],[350,400]]);
 assert.equal(a.presentationEvidence.intervals.length,2);
});
test('chapter inference preserves pre-existing restrictions and unrelated evidence on rebuild',()=>{
 const r=fixture([basin(100),flame(150,1),basin(500,'removebuff')]);
 r.duration=1000;r.fight={chapters:[{id:1,encounterID:3188,startTime:1000,endTime:1600},{id:2,encounterID:3187,startTime:1600,endTime:2000}]};
 r.actors[1].presentationWindows=[[0,200],[400,800]];
 r.actors[1].presentationEvidence={kind:'other-presentation',reason:'fixture'};
 const a=applyCouncilPresentation(r),actor=a.actors[1];
 assert.deepEqual(actor.presentationWindows,[[150,200],[400,500],[600,800]]);
 assert.deepEqual(applyCouncilPresentation(a),a);
 const rebuilt=applyCouncilPresentation({...a,raw:{...a.raw,events:[]}});
 assert.deepEqual(rebuilt.actors[1].presentationWindows,r.actors[1].presentationWindows);
 assert.deepEqual(rebuilt.actors[1].presentationEvidence,r.actors[1].presentationEvidence);
});
test('unrelated chapters alone cannot annotate Flame actors',()=>{
 const r=input();r.fight={chapters:[{id:2,encounterID:3187,startTime:1000,endTime:201000}]};
 assert.equal(applyCouncilPresentation(r),r);
});
