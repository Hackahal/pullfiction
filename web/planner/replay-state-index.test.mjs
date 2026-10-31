import test from 'node:test';
import assert from 'node:assert/strict';
import {combatStateAt,resourcesAt,enrichCombat,normalizeReplay} from './replay.mjs';

// Deliberately simple reference for the established first-cast and aura-order contract.
function expected(actor,t) {
 const cast=actor.casts.find(c=>!c.instant&&c.start<=t&&c.end>t)??null;
 const auras=new Map(actor.initialAuras.map(spell=>[spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false}]));
 for(const [at,a]of actor.auras){if(at>t)break;if(a.reset){auras.clear();for(const spell of a.reset)auras.set(spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false});}else if(a.remove)auras.delete(a.spell);else auras.set(a.spell,a);}
 const changes=actor.resourceChanges.filter(([at])=>at<=t&&at>t-5000),totals=new Map();
 for(const [,e]of changes){const sum=totals.get(e.type)??{type:e.type,gain:0,waste:0};sum.gain+=e.gain;sum.waste+=e.waste;totals.set(e.type,sum);}
 return {health:null,power:null,cast:cast?{...cast,progress:Math.min(1,(t-cast.start)/Math.max(1,cast.end-cast.start))}:null,
  auras:[...auras.values()],resources:{changes:changes.slice(-5).reverse().map(([at,e])=>({...e,at})),totals:[...totals.values()]}};
}
function actorFixture() {
 return {type:'Player',health:[],power:[],initialAuras:[1,2],
 casts:[{start:0,end:10000,name:'Earlier overlapping cast',spell:1},
  {start:0,end:3000,name:'Same start',spell:2},{start:2000,end:20000,name:'Later overlap',spell:3},
  {start:21000,end:21000,instant:true,spell:4}],
 auras:Array.from({length:520},(_,i)=>[Math.floor(i/3)*100,
  i%83===0?{reset:[9,8]}:i%7===0?{spell:i%21,remove:true}:{spell:i%21,stack:i+1,name:`Aura ${i}`,debuff:i%2===0}]),
 resourceChanges:Array.from({length:80},(_,i)=>[Math.floor(i/3)*500,{type:i%4,gain:i+.125,waste:i%3}])};
}

test('Indexed combat preserves exact forward, reverse and random seeks, overlaps, ties and aura checkpoint order',()=>{
 const actor=actorFixture(),times=[-1,0,99.999,100,5000,9999.999,10000,19999.999,20000,21000,30000];
 for(const [t]of actor.auras)times.push(t-.001,t,t+.001);
 for(const [t]of actor.resourceChanges)times.push(t,t+5000,t+5000.001);
 times.sort((a,b)=>a-b);
 let seed=17;
 const random=Array.from({length:200},()=>{seed=(seed*1664525+1013904223)>>>0;return seed%300000/10;});
 for(const t of [...times,...times.toReversed(),...random])assert.deepEqual(combatStateAt(actor,t),expected(actor,t),`time ${t}`);
 assert.equal(combatStateAt(actor,2500).cast.name,'Earlier overlapping cast');
 assert.equal(combatStateAt(actor,10000).cast.name,'Later overlap');
 assert.equal(combatStateAt(actor,20000).cast,null);
});

test('Actor array replacement and appended events invalidate cached combat data at the same time',()=>{
 const actor=actorFixture(),t=5000;
 assert.deepEqual(combatStateAt(actor,t),expected(actor,t));
 actor.auras=[[0,{reset:[55]}]];
 actor.casts=[{start:0,end:8000,spell:55,name:'New revision'}];
 actor.initialAuras=[66];
 actor.resourceChanges=[[5000,{type:0,gain:999,waste:1}]];
 assert.deepEqual(combatStateAt(actor,t),expected(actor,t));
 actor.auras.push([5000,{spell:77,stack:2}]);
 actor.casts.push({start:5000,end:9000,spell:77});
 actor.resourceChanges.push([5000,{type:1,gain:5,waste:2}]);
 assert.deepEqual(combatStateAt(actor,t),expected(actor,t));
 assert.deepEqual(combatStateAt({...actor,auras:[[0,{reset:[88]}]]},t).auras.map(a=>a.spell),[88]);
});

test('Resource bounds preserve strict lower edge, inclusive upper edge, timestamp ties and source ordering',()=>{
 const actor=actorFixture();
 for(const t of [0,500,5000,5500,10000,Infinity,-Infinity,NaN])assert.deepEqual(resourcesAt(actor,t),expected(actor,t).resources);
 actor.resourceChanges=[...actor.resourceChanges].reverse();
 assert.deepEqual(resourcesAt(actor,5000),expected(actor,5000).resources);
 actor.casts=[...actor.casts].reverse();
 assert.deepEqual(combatStateAt(actor,2500),expected(actor,2500));
 actor.auras=[...actor.auras].reverse();
 assert.deepEqual(combatStateAt(actor,2500),expected(actor,2500));
});

test('Returned aura arrays remain independent of later queries and caller array edits',()=>{
 const actor=actorFixture(),first=combatStateAt(actor,5000),copy=first.auras.slice();
 first.auras.reverse();
 assert.deepEqual(combatStateAt(actor,5000).auras,copy);
 combatStateAt(actor,10000);
 assert.deepEqual(first.auras,copy.toReversed());
});

test('Repeated enrichment rebuilds combat state instead of retaining the previous source revision',()=>{
 const raw={report:{code:'DyN7vF94QR8aj1Lc'},fight:{startTime:0,endTime:10000,gameZone:{name:'Molten Core'},friendlyPlayers:[1]},actors:[{id:1,name:'Mage',type:'Player',subType:'Mage'}],events:[{timestamp:1000,type:'applybuff',targetID:1,abilityGameID:10}]};
 const replay=enrichCombat(normalizeReplay(raw)),actor=replay.actors[0];
 assert.deepEqual(combatStateAt(actor,2000).auras.map(a=>a.spell),[10]);
 raw.events=[{timestamp:1000,type:'applybuff',targetID:1,abilityGameID:20}];
 enrichCombat(replay);
 assert.deepEqual(combatStateAt(actor,2000).auras.map(a=>a.spell),[20]);
});
