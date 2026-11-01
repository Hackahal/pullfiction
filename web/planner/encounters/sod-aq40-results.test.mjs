import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReplay,enrichCombat} from '../replay.mjs';
import {aq40ResultPolicy} from './sod-aq40-results.mjs';
const input=(encounterID,npc,spell)=>({report:{code:'fixture'},gameVersion:'sod',
 fight:{id:1,encounterID,startTime:1000,endTime:5000,gameZone:{id:531},friendlyPlayers:[1]},
 actors:[{id:1,type:'Player',name:'First'},{id:2,type:'NPC',name:'Boss',gameID:npc},{id:3,type:'Player',name:'Second'}],
 events:[{timestamp:1000,type:'cast',sourceID:2,targetID:3,abilityGameID:spell},
  {timestamp:2000,type:'cast',sourceID:2,targetID:1,abilityGameID:spell},
  {timestamp:2010,type:'damage',sourceID:2,targetID:1,abilityGameID:spell},
  {timestamp:2020,type:'damage',sourceID:2,targetID:3,abilityGameID:spell}]});
test('known AQ pulses and beam chains retain the latest group even if an older cast names a secondary victim',()=>{
 for(const [encounter,npc,spell]of [[100711,15516,26084],[100717,15589,26134],[100717,15334,26134]]){
  const r=enrichCombat(normalizeReplay(input(encounter,npc,spell)),{},{});
  assert.deepEqual(r.visualEvents.filter(e=>e.kind==='go').map(e=>e.impacts),[
   [],[{target:'1:1',t:1010},{target:'3:1',t:1020}],
  ]);
  assert.equal(r.visualEvents.find(e=>e.kind==='go').associationEvidence.kind,'encounter-result-association');
  for(const changed of [{gameVersion:'vanilla'},{map:409},{fight:{encounterID:100712}},{actors:[]}])
   assert.equal(aq40ResultPolicy({...r,...changed},r.visualEvents.find(e=>e.kind==='go')),null);
 }
});
test('proven Vanilla AQ families use their own source templates and encounter identities',()=>{
 for(const [encounter,npc,spell]of [[50709,15263,26192],[50709,176525,26192],[50710,15544,19128],
  [50711,15516,26084],[50713,15299,25993],[50716,15517,26102],[50716,15517,26103],[50717,15589,26134]]){
  const raw=input(encounter,npc,spell);raw.gameVersion='vanilla';const r=enrichCombat(normalizeReplay(raw),{},{});
  assert.deepEqual(r.visualEvents.filter(e=>e.kind==='go').map(e=>e.impacts),[[],[{target:'1:1',t:1010},{target:'3:1',t:1020}]]);
  const event=r.visualEvents.find(e=>e.kind==='go');
  for(const changed of [{gameVersion:'sod'},{fight:{encounterID:100711}},{actors:[]},{map:409}])assert.equal(aq40ResultPolicy({...r,...changed},event),null);
  assert.equal(aq40ResultPolicy(r,{...event,spell:341722}),null,'unreproduced opening beam stays generic');
 }
});
