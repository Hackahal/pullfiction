import test from 'node:test';
import assert from 'node:assert/strict';
import {replayEventOrderSteps} from './replay-event-order.mjs';
import {normalizeReplaySteps} from './replay.mjs';

function finish(events) {
  const steps=replayEventOrderSteps(events);
  let step=steps.next();
  while(!step.done)step=steps.next();
  return step.value;
}

test('stable replay ordering keeps raw IDs through uneven runs, merges and timestamp ties',()=>{
  const events=Array.from({length:21111},(_,i)=>({timestamp:(i*751)%173}));
  const expected=events.map((_,i)=>i).sort((a,b)=>events[a].timestamp-events[b].timestamp);
  assert.deepEqual([...finish(events)],expected);
});

test('ordered and malformed replay timelines defer to existing processing',()=>{
  assert.equal(finish([{timestamp:1},{timestamp:1},{timestamp:2}]),undefined);
  assert.equal(finish([{timestamp:2},{timestamp:NaN},{timestamp:1}]),undefined);
});

test('cooperative normalization rejects oversized input before examining event timestamps',()=>{
  const raw={
    report:{code:'test'},
    fight:{startTime:0,endTime:1000,gameZone:{name:'Molten Core'}},
    actors:[],
    events:new Array(2_500_001),
  };
  assert.throws(()=>normalizeReplaySteps(raw,{},undefined,{}).next(),/import limit/);
});
