// Council's combat log omits Flame despawns. This presentation annotation links
// each observed Flame activation to its observed Basin window, without changing
// recorded events, positions, or aura state. Exact orbital movement is unknown.
const ENCOUNTER = 3188, BASIN = 242660, FLAME = 244819;
const BASIN_AURA = 1231133, FLAME_AURA = 1236152;
const KIND = 'encounter-lifecycle-inference';
// In the retained fight, the death-triggered Flames precede the Basin aura by
// 1 ms. Permit only this small event-ordering skew, not a guessed cast schedule.
const ACTIVATION_SKEW_MS = 2;
const key = (e, side) => `${e[`${side}ID`]}:${e[`${side}Instance`] || 1}`;
const spell = e => e.abilityGameID ?? e.ability?.guid;

const intersect = (left,right) => left.flatMap(([a,b]) => right.map(([c,d]) =>
  [Math.max(a,c),Math.min(b,d)]).filter(([s,e]) => s<e));
const merge = intervals => intervals.sort((a,b)=>a[0]-b[0]).reduce((out,interval)=>{
  const last=out.at(-1);
  if(last && interval[0]<=last[1]) last[1]=Math.max(last[1],interval[1]);
  else out.push([...interval]);
  return out;
},[]);

export function applyCouncilPresentation(replay) {
  if (replay.gameVersion !== 'sod') return replay;
  const actors=replay.actors??[],byKey=new Map(actors.map(a=>[a.key,a]));
  const duration=replay.duration,start=replay.raw?.fight?.startTime;
  if(!Number.isFinite(start)||!Number.isFinite(duration)||duration<=0)return replay;
  const chapters=replay.fight?.chapters?.length?replay.fight.chapters:[replay.fight];
  const scopes=chapters.filter(c=>c?.encounterID===ENCOUNTER).map(c=>({
    id:c.id,start:Math.max(0,Number.isFinite(c.startTime)?c.startTime-start:c.start??0),
    end:Math.min(duration,Number.isFinite(c.endTime)?c.endTime-start:c.end??duration),
  })).filter(c=>c.start<c.end).sort((a,b)=>a.start-b.start);
  if(!scopes.length)return replay;
  const events=(replay.raw.events??[]).map((event,order)=>({event,order,t:event.timestamp-start}))
    .filter(e=>Number.isFinite(e.t)&&e.t>=0&&e.t<=duration)
    .sort((a,b)=>a.t-b.t||a.order-b.order);
  const linked=new Map();
  for(const scope of scopes){
    const rows=events.filter(({event:e,t})=>t>=scope.start&&t<=scope.end&&
      (scope.id===undefined||e.fight===undefined||e.fight===scope.id));
    const windows=[],open=new Map(),activations=[];
    let end=scope.end;
    for(const {event:e,t}of rows){
      if(e.type==='encounterend'&&(e.encounterID===undefined||e.encounterID===ENCOUNTER))end=Math.min(end,t);
      const source=byKey.get(key(e,'source')),target=byKey.get(key(e,'target'));
      if(target?.gameID===BASIN&&spell(e)===BASIN_AURA){
        if(e.type==='applybuff'&&source?.key===target.key&&!open.has(target.key))
          open.set(target.key,{start:t,basin:target.key});
        if(e.type==='removebuff'&&open.has(target.key)){
          windows.push({...open.get(target.key),end:t,removed:true});open.delete(target.key);
        }
      }
      const flame=e.type==='applybuff'&&source?.key===target?.key?target:e.type==='cast'?source:null;
      if(flame?.gameID===FLAME&&spell(e)===FLAME_AURA)activations.push({actor:flame.key,t});
    }
    for(const window of open.values())windows.push({...window,end});
    windows.forEach(w=>w.end=Math.min(w.end,end));
    windows.sort((a,b)=>a.start-b.start);
    for(const activation of activations){
      const window=windows.find(w=>w.start<=activation.t&&activation.t<w.end)
        ??windows.find(w=>activation.t<w.start&&w.start-activation.t<=ACTIVATION_SKEW_MS&&w.start<w.end);
      if(!window)continue;
      const list=linked.get(activation.actor)??[];
      // Duplicate self applications and casts cannot create duplicate intervals.
      if(!list.some(x=>x.scope===scope&&x.window===window))list.push({scope,window,activation:activation.t});
      linked.set(activation.actor,list);
    }
  }
  // Only Council chapters are constrained. Other encounters and gaps retain
  // their previous presentation, including reused actor-instance identities.
  const outside=[];let cursor=0;
  for(const [a,b]of merge(scopes.map(s=>[s.start,s.end]))){if(cursor<a)outside.push([cursor,a]);cursor=b;}
  if(cursor<duration)outside.push([cursor,duration]);
  const updated=actors.map(actor=>{
    if(actor.gameID!==FLAME)return actor;
    const own=actor.presentationEvidence?.mechanic==='sod-reborn-council-volcanic-unrest';
    const previous=own?actor.presentationEvidence.previousPresentation:{
      ...(actor.presentationWindows===undefined?{}:{windows:actor.presentationWindows}),
      ...(actor.presentationEvidence===undefined?{}:{evidence:actor.presentationEvidence}),
    };
    const clean=own?Object.fromEntries(Object.entries(actor).filter(([k])=>
      k!=='presentationWindows'&&k!=='presentationEvidence')):actor;
    const restored=own?{...clean,...(previous?.windows===undefined?{}:{presentationWindows:previous.windows}),
      ...(previous?.evidence===undefined?{}:{presentationEvidence:previous.evidence})}:clean;
    const intervals=linked.get(actor.key);
    if(!intervals?.length)return restored;
    const spans=[];let present=actor.initiallyPresent!==false,at=0;
    for(const {event:e,t}of events){
      if(key(e,'target')!==actor.key||!['summon','create','destroy','death','resurrect'].includes(e.type))continue;
      if(present&&t>at)spans.push([at,t]);
      present=['summon','create','resurrect'].includes(e.type);at=t;
    }
    if(present&&at<duration)spans.push([at,duration]);
    const inferred=intersect(intervals.map(i=>[i.activation,i.window.end]),spans);
    const allowed=merge([...outside,...inferred]);
    const presentationWindows=previous?.windows?intersect(allowed,previous.windows):allowed;
    const details=intervals.map(({scope,window,activation})=>({
      chapterId:scope.id,chapterWindow:[scope.start,scope.end],basinActor:window.basin,
      activationMs:activation,basinWindow:[window.start,window.end],
      orderingSkewMs:Math.max(0,window.start-activation),
      endEvidence:window.removed?'recorded Basin aura removal':'encounter bound; aura removal unobserved',
    }));
    return {...restored,presentationWindows,presentationEvidence:{
      kind:KIND,mechanic:'sod-reborn-council-volcanic-unrest',
      basis:'observed Flame activations linked to observed Molten Basin aura intervals',
      basinSpell:BASIN_AURA,flameSpell:FLAME_AURA,intervals:details,
      // Keep the original single-window details readable for existing consumers.
      ...(details.length===1?details[0]:{}),previousPresentation:previous??{},
      endExclusive:true,units:'milliseconds relative to replay start',
      limitations:'Council chapters only; Flame ends inferred; no orbit, height, or source events synthesized',
    }};
  });
  return {...replay,actors:updated};
}
