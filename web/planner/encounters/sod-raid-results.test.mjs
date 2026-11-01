import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReplay,enrichCombat} from '../replay.mjs';
import {raidResultPolicy} from './sod-raid-results.mjs';
test('verified Shazzrah and Gothik pulses retain the newest source-instance result group',()=>{
 for(const [map,encounterID,npc,spell]of [[409,100667,228434,19712],[409,100667,184361,19712],[533,201109,16060,1226282],[533,201109,16127,27989]]){
  const r=enrichCombat(normalizeReplay({report:{code:'fixture'},gameVersion:'sod',
   fight:{id:1,encounterID,startTime:1000,endTime:5000,gameZone:{id:map},friendlyPlayers:[1]},
   actors:[{id:1,type:'Player',name:'First'},{id:2,type:'NPC',name:'Source',gameID:npc},{id:3,type:'Player',name:'Second'}],
   events:[{timestamp:1000,type:'cast',sourceID:2,abilityGameID:spell},
    {timestamp:2000,type:'cast',sourceID:2,abilityGameID:spell},
    {timestamp:2010,type:'damage',sourceID:2,targetID:1,abilityGameID:spell},
    {timestamp:2020,type:'damage',sourceID:2,targetID:3,abilityGameID:spell}]}),{},{});
  assert.deepEqual(r.visualEvents.filter(e=>e.kind==='go').map(e=>e.impacts),[[],[{target:'1:1',t:1010},{target:'3:1',t:1020}]]);
  const event=r.visualEvents.find(e=>e.kind==='go');
  for(const changed of [{gameVersion:'vanilla'},{fight:{encounterID:999}},{actors:[]}])assert.equal(raidResultPolicy({...r,...changed},event),null);
  assert.equal(raidResultPolicy(r,{...event,spell:30}),null);
 }
});
test('Vanilla Shazzrah pulse association does not inherit SoD NPC identities',()=>{
 const r={gameVersion:'vanilla',map:409,raw:{fight:{startTime:1000}},fight:{encounterID:50667},duration:5000,actors:[{key:'2:1',type:'NPC',gameID:12264}]};
 const event={source:'2:1',spell:19712,t:100};
 assert.equal(raidResultPolicy(r,event)?.mechanic,'shazzrah-arcane-explosion-pulse');
 for(const changed of [{gameVersion:'sod'},{fight:{encounterID:100667}},{actors:[{key:'2:1',type:'NPC',gameID:228434}]}])assert.equal(raidResultPolicy({...r,...changed},event),null);
});
