// Evidence gate for the existing
// anchor interpolation branch; it neither generates a route nor changes speed.
const START=1228331,HIT=1228370,NPC=241021,ENCOUNTER=3197;
const key=e=>`${e.sourceID}:${e.sourceInstance||1}`;
export function masonChargeEvidence(replay,actor){
 if(replay.gameVersion!=='sod'||actor.gameID!==NPC)return [];
 const origin=replay.raw?.fight?.startTime;if(!Number.isFinite(origin))return [];
 const chapters=replay.fight?.chapters?.length?replay.fight.chapters:[replay.fight];
 const out=[];
 for(const c of chapters.filter(c=>c?.encounterID===ENCOUNTER)){
  const begin=Number.isFinite(c.startTime)?c.startTime-origin:c.start??0;
  const end=Number.isFinite(c.endTime)?c.endTime-origin:c.end??replay.duration;
  const events=(replay.raw.events??[]).filter(e=>e.type==='cast'&&key(e)===actor.key&&
   e.timestamp-origin>=begin&&e.timestamp-origin<=end&&(c.id===undefined||e.fight===undefined||e.fight===c.id))
   .sort((a,b)=>a.timestamp-b.timestamp);
  let chain=null;
  for(const e of events){
   const id=e.abilityGameID??e.ability?.guid,t=e.timestamp-origin;
   if(id===START){if(chain?.hits)out.push(chain);chain={start:t,end:t,last:t,hits:0,chapter:c.id,spell:START,observedHitSpell:HIT};}
   else if(id===HIT&&chain&&t-chain.last<=1000){chain.last=t;chain.end=t;chain.hits++;}
   else if(chain&&t-chain.last>1000){if(chain.hits)out.push(chain);chain=null;}
  }
  if(chain?.hits)out.push(chain);
 }
 const explicitBreaks=(replay.raw.events??[]).filter(e=>
  (key(e)===actor.key||`${e.targetID}:${e.targetInstance||1}`===actor.key)&&
  (e.type==='teleport'||e.teleport===true)).map(e=>e.timestamp-origin);
 for(const cast of actor.casts??[])if(/^(blink|teleport)$/i.test(cast.name??'')&&cast.outcome==='completed')explicitBreaks.push(cast.end);
 return out.map(({last,...w})=>({...w,breaks:explicitBreaks.filter(t=>w.start<=t&&t<=w.end),kind:'observed-charge-sequence',limit:'only measured dense sample segments; no phase-tail extrapolation'}));
}
export function measuredMasonChargeSegment(actor,a,b,evidence,index){
 if(actor.gameID!==NPC||!a||!b||!evidence.some(w=>w.start<=a[0]&&b[0]<=w.end))return false;
 const dt=b[0]-a[0];if(!(dt>0&&dt<=250))return false;
 if(![a[1],a[2],b[1],b[2]].every(Number.isFinite))return false;
 // This is only an exception to the generic 35 yd/s teleport cutoff.
 if(Math.hypot(b[1]-a[1],b[2]-a[2])*1000/dt<=35)return false;
 const boundaries=[...(actor.lifeEvents??[]).map(([t])=>t),...(actor.deaths??[]).map(([t])=>t),
  ...(actor.positionBreaks??[]),...(actor.movement?.blinks??[]).map(([t])=>t),...(actor.teleports??[])];
 if([...boundaries,...evidence.flatMap(w=>w.breaks??[])].some(t=>a[0]<t&&t<=b[0]))return false;
 const i=index??(actor.samples??[]).findIndex(s=>s===a||s[0]===a[0]&&s[1]===a[1]&&s[2]===a[2]);
 if(i<0||actor.samples[i+1]?.[0]!==b[0])return false;
 // Require another close anchor in the same observed sequence. Two isolated
 // points at high speed remain ambiguous, even inside a Blade Dance window.
 return [actor.samples[i-1],actor.samples[i+2]].some(n=>n&&
  evidence.some(w=>w.start<=n[0]&&n[0]<=w.end)&&
  Math.min(Math.abs(n[0]-a[0]),Math.abs(n[0]-b[0]))<=250);
}
export function applyMasonPresentation(replay){
 if(replay.gameVersion!=='sod')return replay;
 for(const actor of replay.actors){
  if(actor.gameID!==NPC)continue;
  const evidence=masonChargeEvidence(replay,actor);
  const segments=(actor.samples??[]).flatMap((a,i,rows)=>measuredMasonChargeSegment(actor,a,rows[i+1],evidence,i)?[[a[0],rows[i+1][0]]]:[]);
  actor.chargeSegments=segments;actor.chargeEvidence=evidence;
 }
 return replay;
}
