// AQ40's Despair sources have Birth/Shatter casts but no spawn/despawn records.
// These windows affect presentation only. They do not create deaths or a chase
// path, and an observed Shatter does not specify visual transition duration.
const NPC=235668,BIRTH=26586,SHATTER=1214871;
const MECHANIC='sod-aq40-despair-illusions';
const sourceKey=e=>`${e.sourceID}:${e.sourceInstance||1}`;
const spell=e=>e.abilityGameID??e.ability?.guid;
const intersect=(left,right)=>left.flatMap(([a,b])=>right.map(([c,d])=>
  [Math.max(a,c),Math.min(b,d)]).filter(([s,e])=>s<e));
const merge=rows=>rows.sort((a,b)=>a[0]-b[0]).reduce((out,row)=>{
 const last=out.at(-1);if(last&&row[0]<=last[1])last[1]=Math.max(last[1],row[1]);else out.push([...row]);return out;
},[]);

export function applyAq40IllusionPresentation(replay){
 if(replay.gameVersion!=='sod'||Number(replay.map)!==531)return replay;
 const origin=replay.raw?.fight?.startTime,duration=replay.duration;
 if(!Number.isFinite(origin)||!Number.isFinite(duration)||duration<=0)return replay;
 const events=(replay.raw.events??[]).map((event,order)=>({event,order,t:event.timestamp-origin}))
  .filter(({t})=>Number.isFinite(t)&&0<=t&&t<=duration)
  .sort((a,b)=>a.t-b.t||a.order-b.order);
 const byKey=new Map((replay.actors??[]).map(a=>[a.key,a]));
 const intervals=new Map(),open=new Map();
 const append=(key,row)=>{const rows=intervals.get(key)??[];rows.push(row);intervals.set(key,rows);};
 for(const {event:e,t}of events){
  const key=sourceKey(e),actor=byKey.get(key),id=spell(e);
  if(actor?.gameID!==NPC||e.type!=='cast')continue;
  if(id===BIRTH){
   const previous=open.get(key);
   if(previous===t)continue; // duplicated event in the same update
   if(previous!==undefined)append(key,{start:previous,end:t,endEvidence:'next recorded Birth; prior terminal unknown'});
   open.set(key,t);
  }else if(id===SHATTER&&open.has(key)){
   append(key,{start:open.get(key),end:t,endEvidence:'recorded Shatter cast'});open.delete(key);
  }
 }
 for(const [key,start]of open)append(key,{start,end:duration,endEvidence:'replay bound; terminal unknown'});
 const actors=(replay.actors??[]).map(actor=>{
  if(actor.gameID!==NPC)return actor;
  const own=actor.presentationEvidence?.mechanic===MECHANIC;
  const previous=own?actor.presentationEvidence.previousPresentation:{
   ...(actor.presentationWindows===undefined?{}:{windows:actor.presentationWindows}),
   ...(actor.presentationEvidence===undefined?{}:{evidence:actor.presentationEvidence}),
  };
  const clean=own?Object.fromEntries(Object.entries(actor).filter(([k])=>k!=='presentationWindows'&&k!=='presentationEvidence')):actor;
  const restored=own?{...clean,...(previous?.windows===undefined?{}:{presentationWindows:previous.windows}),
   ...(previous?.evidence===undefined?{}:{presentationEvidence:previous.evidence})}:clean;
  const rows=intervals.get(actor.key);
  if(!rows)return restored; // firstSeen and a lone Shatter do not prove Birth.
  const boundaries=[...(actor.lifeEvents??[]).map(([t,present],order)=>({t,present,order})),
   ...(actor.deaths??[]).map(([t,dead],order)=>({t,dead,order:order+(actor.lifeEvents?.length??0)}))]
   .filter(({t})=>Number.isFinite(t)&&t>=0&&t<=duration).sort((a,b)=>a.t-b.t||a.order-b.order);
  const spans=[];let present=actor.initiallyPresent!==false,alive=true,cursor=0;
  for(const boundary of boundaries){
   if(present&&alive&&cursor<boundary.t)spans.push([cursor,boundary.t]);
   if('present'in boundary)present=boundary.present;
   if('dead'in boundary)alive=!boundary.dead;
   cursor=boundary.t;
  }
  if(present&&alive&&cursor<duration)spans.push([cursor,duration]);
  let windows=merge(intersect(rows.map(r=>[r.start,r.end]),spans));
  if(previous?.windows)windows=merge(intersect(windows,previous.windows));
  return {...restored,presentationWindows:windows,presentationEvidence:{
   kind:'encounter-lifecycle-inference',mechanic:MECHANIC,
   basis:'recorded Birth and optional Shatter casts on this source instance',
   npcId:NPC,birthSpell:BIRTH,terminalSpell:SHATTER,intervals:rows,
   units:'milliseconds relative to replay start',endExclusive:true,
   previousPresentation:previous??{},
   limitations:'CPU host visibility only; no inferred death, chase path, or Shatter visual transition duration',
  }};
 });
 return {...replay,actors};
}
