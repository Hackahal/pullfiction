import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, parsePlan, validatePlan, addPoint, routeLength } from './plan.mjs';
test('World positions and metadata survive a portable plan roundtrip', () => {
  let plan = addPoint(emptyPlan(), 'marker', [1080, -481, -104]);
  plan = addPoint(plan, 'route', [1080, -481, -104]);
  plan = addPoint(plan, 'route', [1083, -477, -104]);
  assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
  assert.equal(routeLength(plan.route), 5);
  assert.equal(emptyPlan().markers.length, 0);
});
test('Import rejects wrong versions, maps, clients, malformed and oversized coordinates', () => {
  for (const patch of [{ version: 3 }, { mapId: 999999 }, {mapId: "409"}, { client: 'retail' }, { route: [[1, 2]] }, { markers: [[NaN, 1, 2]] }, { markers: [[20001, 1, 2]] }, { route: Array(2001).fill([1, 2, 3]) }, { name: 'x'.repeat(101) }]) {
    assert.throws(() => validatePlan({ ...emptyPlan(), version:1, ...patch }));
  }
  assert.throws(() => parsePlan('{broken'));
  assert.throws(() => parsePlan(' '.repeat(2000001)));
});
test('Edits produce an independent snapshot for undo and do not mutate the saved plan', () => {
  const saved = addPoint(emptyPlan(), 'route', [1, 2, 3]);
  const next = addPoint(saved, 'route', [4, 5, 6]);
  next.route[0][0] = 100;
  assert.deepEqual(saved.route, [[1, 2, 3]]);
  assert.equal(next.route.length, 2);
});

import {RAIDS,raidsForVersion} from './raids.mjs';
import {planStorageKey,STORAGE_KEY} from './plan.mjs';
test('Every Vanilla raid has a portable independent plan and MC retains its original storage key',()=>{
 const keys=new Set();
 for(const raid of raidsForVersion('vanilla')){const plan=emptyPlan(raid.map);assert.equal(parsePlan(JSON.stringify(plan)).mapId,raid.map);keys.add(planStorageKey(raid.map));}
 assert.equal(keys.size,7);assert.equal(planStorageKey(409),STORAGE_KEY);
});

import {newStep,newAnnotation} from './plan.mjs';
test('Legacy plans migrate deterministically without losing marker/route coordinates',()=>{
 const old={version:1,client:'vanilla-1.12.1',mapId:409,name:'Saved MC',markers:[[1080,-481,-104],[1070,-490,-104]],route:[[1,2,3],[4,5,6]]};
 const p=validatePlan(old);assert.equal(p.version,2);assert.equal(p.steps.length,1);assert.equal(p.steps[0].annotations.length,3);assert.deepEqual(p.markers,old.markers);assert.deepEqual(p.route,old.route);
 assert.deepEqual(validatePlan(old),validatePlan(old));assert.deepEqual(parsePlan(JSON.stringify(p)),p);assert.equal(old.version,1);
});
test('Steps, comments, locks, icon styling and time links survive save/import',()=>{
 const p=emptyPlan(),s={...newStep('Phase 2','phase'),layerId:'default-layer'};s.start=15000;s.end=20000;s.notes='Spread for the next wave';
 s.annotations=[newAnnotation('circle',[10,20,30],{size:12,notes:'Healers here',label:'Stack',locked:true,comments:[{id:'comment-one',text:'Use the wall',createdAt:'2026-10-25T12:00:00.000Z'}]})];p.steps.push(s);
 const normalized=validatePlan(p);assert.equal(normalized.steps[1].annotations[0].name,"Circle 1");assert.deepEqual(parsePlan(JSON.stringify(normalized)).steps,normalized.steps);
});
test('Version2 validation rejects duplicate identities, invalid shapes, bad time ranges and malformed coordinates',()=>{
 const p=emptyPlan();p.steps[0].annotations=[newAnnotation('arrow',[1,2,3])];
 for(const change of [{id:p.steps[0].id},{points:[[Infinity,1,2]]},{type:'script'},{color:'red'},{icon:'../../secret'},{width:99},{size:0}]){
  const bad=structuredClone(p);Object.assign(bad.steps[0].annotations[0],change);assert.throws(()=>validatePlan(bad));
 }
 const bad=structuredClone(p);bad.steps[0].start=1000;bad.steps[0].end=500;assert.throws(()=>validatePlan(bad));
});

test('Step snapshots persist source positions and reject malformed appearance and duplicate actors',()=>{
 const plan=emptyPlan();
 plan.steps[0].snapshot={report:'public-report',time:5000,actors:[{key:'1:1',name:'Ward',class:'Pet',type:'Pet',friendly:false,position:[10,20,30],recorded:[0,20,30],facing:1,recordedFacing:0,race:3,sex:1,scale:1,displayID:55,gameID:0}]};
 const roundtrip=parsePlan(JSON.stringify(plan));
 assert.deepEqual(roundtrip.steps[0].snapshot,plan.steps[0].snapshot);
 for(const patch of [{position:[NaN,0,0]},{facing:Infinity},{race:'3'},{scale:0},{recorded:[1,2]},{displayID:-1},{friendly:'false'},{friendly:0},{friendly:null}]){
  const invalid=structuredClone(plan);Object.assign(invalid.steps[0].snapshot.actors[0],patch);assert.throws(()=>validatePlan(invalid));
 }
 const duplicate=structuredClone(plan);duplicate.steps[0].snapshot.actors.push(structuredClone(duplicate.steps[0].snapshot.actors[0]));assert.throws(()=>validatePlan(duplicate));
});

test('Legacy plans migrate to one row, named layer pages roundtrip and orphaned pages are rejected',()=>{
 const legacy=emptyPlan();delete legacy.layers;delete legacy.steps[0].layerId;
 const migrated=validatePlan(legacy);assert.equal(migrated.layers.length,1);assert.equal(migrated.steps[0].layerId,migrated.layers[0].id);
 migrated.layers.push({id:'healing-row',name:'Healing assignments',hidden:true});migrated.steps[0].layerId='healing-row';
 assert.deepEqual(parsePlan(JSON.stringify(migrated)),migrated);
 const invalid=structuredClone(migrated);invalid.steps[0].layerId='missing';assert.throws(()=>validatePlan(invalid));
});

test('Edit names survive migration, deletion, new edits and portable saves',()=>{
 let p=emptyPlan();p.steps[0].annotations=[newAnnotation('circle',[0,0,0]),newAnnotation('circle',[1,0,0]),newAnnotation('cone',[2,0,0])];
 p=validatePlan(p);assert.deepEqual(p.steps[0].annotations.map(a=>a.name),['Circle 1','Circle 2','Cone 1']);
 p.steps[0].annotations.shift();p.steps[0].annotations.push(newAnnotation('circle',[3,0,0]));
 p=validatePlan(p);assert.equal(p.steps[0].annotations[0].name,'Circle 2');
 assert.equal(new Set(p.steps[0].annotations.map(a=>a.name)).size,3);
 p.steps[0].annotations[0].name='Healers';assert.deepEqual(parsePlan(JSON.stringify(p)),p);
});

test('Snapshot gameIDs preserve large WCL player and pet identifiers within the native u32 range',()=>{
 const plan=emptyPlan();
 plan.steps[0].snapshot={report:'public-report',time:5000,actors:[
  {key:'1:1',name:'Mage',class:'Mage',type:'Player',position:[10,20,30],facing:0,gameID:77753361},
  {key:'2:1',name:'Pet',class:'Pet',type:'Pet',position:[11,20,30],facing:0,gameID:15334284},
  {key:'3:1',name:'Enemy',class:'NPC',type:'NPC',position:[12,20,30],facing:0,gameID:0xffffffff}
 ]};
 assert.deepEqual(parsePlan(JSON.stringify(plan)).steps[0].snapshot,plan.steps[0].snapshot);
 for(const patch of [{gameID:-1},{gameID:0x100000000},{gameID:1.5},{gameID:Infinity},{gameID:'77753361'},{displayID:10000001},{sex:3}]){
  const invalid=structuredClone(plan);Object.assign(invalid.steps[0].snapshot.actors[0],patch);
  assert.throws(()=>validatePlan(invalid));
 }
});
