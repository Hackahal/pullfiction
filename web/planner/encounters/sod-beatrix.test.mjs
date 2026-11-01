import test from 'node:test';
import assert from 'node:assert/strict';
import {isBeatrixCannonPulse} from './sod-beatrix.mjs';
test('latest-area association is limited to observed SoD Beatrix artillery inside its chapter',()=>{
 const replay={gameVersion:'sod',fight:{encounterID:3187},raw:{fight:{startTime:1000}},duration:10000,actors:[{key:'2:1',gameID:241904}]};
 const event={spell:1232829,source:'2:1',target:null,t:100};
 assert.equal(isBeatrixCannonPulse(replay,event),true);
 for(const r of [{...replay,gameVersion:'vanilla'},{...replay,fight:{encounterID:3188}},{...replay,actors:[]}])assert.equal(isBeatrixCannonPulse(r,event),false);
 for(const e of [{...event,target:'1:1'},{...event,spell:30},{...event,source:'2:2'}])assert.equal(isBeatrixCannonPulse(replay,e),false);
 const run={...replay,fight:{chapters:[{encounterID:3187,startTime:2000,endTime:3000},{encounterID:3188,startTime:3000,endTime:4000}]}};
 for(const [t,expected] of [[100,false],[1500,true],[2500,false]])assert.equal(isBeatrixCannonPulse(run,{...event,t}),expected);
});
