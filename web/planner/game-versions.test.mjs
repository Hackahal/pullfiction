import test from 'node:test';
import assert from 'node:assert/strict';
import {gameVersion,reportSource} from './game-versions.mjs';
import {normalizeReplay,enrichCombat} from './replay.mjs';
import {emptyPlan,parsePlan,planStorageKey} from './plan.mjs';
test('URL domain selects ruleset; bare codes use explicit selection and arbitrary hosts fail',()=>{
 assert.deepEqual(reportSource('https://sod.warcraftlogs.com/reports/bZX7VqdwpcmyrGzN#fight=2'),{code:'bZX7VqdwpcmyrGzN',gameVersion:'sod'});
 assert.equal(reportSource('bZX7VqdwpcmyrGzN','sod').gameVersion,'sod');
 assert.equal(reportSource('https://vanilla.warcraftlogs.com/reports/bZX7VqdwpcmyrGzN','sod').gameVersion,'vanilla');
 assert.throws(()=>reportSource('https://sod.warcraftlogs.com.evil.test/reports/bZX7VqdwpcmyrGzN'));
 assert.throws(()=>gameVersion('retail'));
});
test('plan identities cannot collide across rulesets while old Era plans migrate',()=>{
 for(const version of ['vanilla','sod']){const p=emptyPlan(531,version);assert.equal(parsePlan(JSON.stringify(p)).gameVersion,version);}
 assert.notEqual(planStorageKey(531,'vanilla'),planStorageKey(531,'sod'));
 const legacy=emptyPlan();delete legacy.gameVersion;assert.equal(parsePlan(JSON.stringify(legacy)).gameVersion,'vanilla');
 const invalid=emptyPlan(531,'sod');invalid.client='vanilla-1.12.1';assert.throws(()=>parsePlan(JSON.stringify(invalid)));
});
test('new SoD spell IDs and recorded casts survive portable replay reconstruction',()=>{
 const raw={gameVersion:'sod',report:{code:'bZX7VqdwpcmyrGzN',gameVersion:'sod'},fight:{id:2,startTime:0,endTime:10000,gameZone:{name:"Temple of Ahn'Qiraj"},friendlyPlayers:[1]},actors:[{id:1,name:'Mage',type:'Player',subType:'Mage'}],abilities:[{gameID:400574,name:'Arcane Blast',icon:'spell_arcane_blast'}],events:[{timestamp:1000,type:'begincast',sourceID:1,abilityGameID:400574},{timestamp:2500,type:'cast',sourceID:1,abilityGameID:400574}]};
 const r=enrichCombat(normalizeReplay(raw));assert.equal(r.gameVersion,'sod');assert.equal(r.actors[0].casts[0].name,'Arcane Blast');assert.equal(r.actors[0].casts[0].end,2500);assert.equal(r.actors[0].casts[0].timingSource,'recorded');
 assert.throws(()=>normalizeReplay({...raw,report:{...raw.report,gameVersion:'vanilla'}}));
});

test('Scarlet Enclave is a SoD-only planning map and persists without an import',()=>{
 const p=emptyPlan(2856,'sod');assert.equal(p.mapId,2856);assert.equal(parsePlan(JSON.stringify(p)).gameVersion,'sod');assert.throws(()=>emptyPlan(2856,'vanilla'));
});
