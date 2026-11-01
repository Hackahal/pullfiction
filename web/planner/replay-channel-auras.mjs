// A finite targeted channel can end on its own source/victim aura removal.
// Unattributed or overlapping removals must not stop another caster's channel.
export function targetedChannelAuras(events,metadata,duration){
 const buckets=new Map(),windows=new Map(),lastCast=new Map();
 const key=(e,side)=>`${e[side+'ID']}:${e[side+'Instance']||1}`;
 const spell=e=>e.abilityGameID??e.ability?.guid??0;
 const tuple=(source,target,id)=>`${source}/${target}/${id}`;
 const close=(bucket,source,t,recorded)=>{
  const window=bucket.get(source);if(!window)return;
  window.end=t;window.recordedEnd=recorded;bucket.delete(source);
 };
 for(const {event:e,id,t}of events){
  const s=spell(e),source=e.sourceID>0?key(e,'source'):null,target=e.targetID>0?key(e,'target'):null;
  if(e.type==='combatantinfo'){
   for(const [k,bucket]of buckets)if(k.startsWith(`${key(e,'source')}/`))
    for(const owner of [...bucket.keys()])close(bucket,owner,t,false);
   continue;
  }
  if(!metadata[s]?.channel||!target)continue;
  if(e.type==='cast'&&source){lastCast.set(tuple(source,target,s),id);continue;}
  const bucketKey=`${target}/${s}`,bucket=buckets.get(bucketKey)??new Map();
  if(/^remove(buff|debuff)$/.test(e.type)){
   if(source&&bucket.has(source))close(bucket,source,t,true);
   else if(!source&&bucket.size===1)close(bucket,bucket.keys().next().value,t,true);
  }else if(/^(apply|refresh)(buff|debuff)(stack)?$/.test(e.type)){
   const owner=source??(e.type.startsWith('refresh')||e.type.endsWith('stack')?
    (bucket.size===1?bucket.keys().next().value:null):null);
   if(!bucket.has(owner)){
    const window={start:t,end:duration,recordedEnd:false,activationId:owner?lastCast.get(tuple(owner,target,s)):null};
    bucket.set(owner,window);
    if(owner){const k=tuple(owner,target,s),list=windows.get(k)??[];list.push(window);windows.set(k,list);}
   }
  }
  buckets.set(bucketKey,bucket);
 }
 return (source,target,spell,activationId,start,hintedEnd)=>(windows.get(tuple(source,target,spell))??[]).find(w=>
  w.recordedEnd&&start<w.end&&w.end<=hintedEnd&&
  (w.start<=start||(w.activationId===activationId&&w.start<hintedEnd)));
}
