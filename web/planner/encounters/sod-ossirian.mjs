// Crystal weakness casts omit their target, but their recorded aura application
// identifies Ossirian. This supplies a chain endpoint, never a synthetic impact.
export function recordedOssirianTargets(replay) {
 const targets=new Map();
 if(replay.gameVersion!=='sod'||replay.map!==509)return targets;
 const actors=new Map(replay.actors.map(a=>[a.key,a]));
 const origin=replay.raw.fight.startTime,chapters=replay.fight.chapters?.length?replay.fight.chapters:[replay.fight];
 const windows=chapters.filter(c=>c.encounterID===100723).map(c=>[
  Number.isFinite(c.startTime)?c.startTime-origin:c.start??0,
  Number.isFinite(c.endTime)?c.endTime-origin:c.end??replay.duration,
 ]);
 if(!windows.length)return targets;
 const spells=new Set([25177,25178,25180,25181,25183]),active=new Map();
 const key=(e,side)=>`${e[side+'ID']}:${e[side+'Instance']||1}`;
 const finish=cast=>{
  if(!cast||cast.recipients.size!==1)return;
  const [target,applicationTimeMs]=cast.recipients.entries().next().value;
  targets.set(cast.id,{target,targetEvidence:{kind:'recorded-aura-recipient',mechanic:'ossirian-crystal-weakness',
   applicationTimeMs,basis:'unique same-source-instance and same-spell application after this cast; no impact inferred'}});
 };
 for(const {e,id,t}of replay.raw.events.map((e,id)=>({e,id,t:e.timestamp-origin})).sort((a,b)=>a.t-b.t||a.id-b.id)){
  const spell=e.abilityGameID??e.ability?.guid,source=key(e,'source');
  if(!spells.has(spell)||actors.get(source)?.gameID!==15590||actors.get(source)?.type!=='NPC')continue;
  const group=`${source}/${spell}`;
  if(e.type==='cast'){
   finish(active.get(group));active.delete(group);
   const window=windows.find(([start,end])=>start<=t&&t<=end);
   if(window)active.set(group,{id,t,end:window[1],recipients:new Map()});
  }else if(e.type==='applybuff'||e.type==='applydebuff'){
   const cast=active.get(group),target=key(e,'target');
   if(cast&&cast.t<=t&&t<=cast.t+250&&t<=cast.end&&actors.get(target)?.gameID===15339&&actors.get(target)?.type==='NPC')
    if(!cast.recipients.has(target))cast.recipients.set(target,t);
  }
 }
 for(const cast of active.values())finish(cast);
 return targets;
}
