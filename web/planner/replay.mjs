import {prepareMovement,movementBetween,runProgress} from './replay-movement.mjs';
import {reportSource,gameVersion} from './game-versions.mjs';
import {reconstructCasts,buildVisualEvents} from './replay-actions.mjs';
export {visualEventsBetween} from './replay-actions.mjs';
import {requireRaid} from './raids.mjs';
// WCL resource coordinates use hundredths of a yard. Keep WCL actor AND instance IDs.
// https://www.warcraftlogs.com/help/pins#resources-fields
export {reportSource} from './game-versions.mjs';
export function reportCode(value) {return reportSource(value).code;}

export const CLASS_COLORS = { Warrior:'#c79c6e',Paladin:'#f58cba',Hunter:'#abd473',Rogue:'#fff569',Priest:'#ffffff',Shaman:'#0070de',Mage:'#69ccf0',Warlock:'#9482c9',Druid:'#ff7d0a' };
export function normalizeReplay(raw, models = {}) {
  const { report, fight, actors, events } = raw;
  const ruleset=gameVersion(raw.gameVersion??report?.gameVersion??'vanilla').id;
  if(raw.gameVersion&&report?.gameVersion&&raw.gameVersion!==report.gameVersion)throw new Error('Replay game versions disagree.');
  if (!report?.code || !fight || !Array.isArray(actors) || !Array.isArray(events)) throw new Error('Expected a report, fight, actors, and events.');
  const raid = requireRaid(fight.gameZone,ruleset);
  if (!Number.isFinite(fight.startTime) || !(fight.endTime > fight.startTime)) throw new Error('Invalid encounter time range.');
  if (events.length > 2500000 || actors.length > 10000) throw new Error('Replay exceeds the prototype import limit.');
  const catalog = new Map(actors.map(a => [a.id, a]));
  // A same-map zonechange can be a portal into another instance room. Its
  // timestamp is evidence of discontinuity, not evidence of a destination Z.
  const positionBreaks = events.filter(e => e.type === 'zonechange' && Number.isFinite(e.timestamp))
    .map(e => e.timestamp - fight.startTime).sort((a,b) => a-b);
  const tracks = new Map();
  function track(id, instance = 1) {
    const actor = catalog.get(id); if (!actor || id <= 0) return null;
    const key = `${id}:${instance || 1}`;
    if (!tracks.has(key)) tracks.set(key, { key, id, instance: instance || 1, name: actor.name, type: actor.type, class: actor.subType, ...(ruleset==='sod'&&actor.type==='NPC'?{spawnObservedOnly:true}:{}), gameID: actor.gameID, displayID: models[actor.gameID]?.displayID ?? null, scale: models[actor.gameID]?.scale ?? 1, activity: [], samples: [], facings: [], deaths: [], positionBreaks, firstSeen:Infinity, lastSeen:-Infinity });
    return tracks.get(key);
  }
  for (const id of fight.friendlyPlayers ?? []) track(id);
  if(raw.stream)for(const chapter of fight.chapters??[fight])for(const npc of chapter.enemyNPCs??[])track(npc.id);
  for (const event of [...events].sort((a,b)=>a.timestamp-b.timestamp)) {
    if (!Number.isFinite(event.timestamp) || event.timestamp < fight.startTime || event.timestamp > fight.endTime) continue;
    const t = event.timestamp - fight.startTime;
    for (const side of ['source', 'target']) {
      const actor = track(event[`${side}ID`], event[`${side}Instance`]);
      if (!actor) continue;
      actor.firstSeen=Math.min(actor.firstSeen,t);actor.lastSeen=Math.max(actor.lastSeen,t);
      if(actor.type==='Player')actor.activity.push(t);
      // Current WCL events flatten resources onto the event: 1=source, 2=target.
      const r = event[`${side}Resources`] ?? (event.resourceActor === (side === 'source' ? 1 : 2) ? event : null);
      if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && (r.x !== 0 || r.y !== 0)) {
        // WCL replay map axes: horizontal=-WoW Y, vertical=WoW X.
        const x = r.y / 100, y = -r.x / 100;
        if (Math.abs(x) <= 20000 && Math.abs(y) <= 20000) {
          actor.samples.push([t,x,y,null]);
          // WCL rotates map facing clockwise in hundredths of radians. Convert
          // back to WoW heading, matching the movement vectors in these tracks.
          if(Number.isFinite(r.facing))actor.facings.push([t,-r.facing/100-Math.PI/2]);
        }
      }
      if(fight.chapters && r?.hitPoints>0)actor.deaths.push([t,false]);
      if (side === 'target' && event.type === 'death') actor.deaths.push([t,true]);
      if (side === 'target' && event.type === 'resurrect') actor.deaths.push([t,false]);
    }
  }
  for (const actor of tracks.values()) {
    actor.activity=[...new Set(actor.activity)].sort((a,b)=>a-b);
    actor.samples.sort((a,b) => a[0]-b[0]);
    actor.samples = actor.samples.filter((s,i,all) => i === all.length-1 || s[0] !== all[i+1][0]);
    actor.facings.sort((a,b)=>a[0]-b[0]);
    actor.facings=actor.facings.filter((s,i,all)=>i===all.length-1||s[0]!==all[i+1][0]);
    // Missing facing data should hold the last direction through stationary
    // samples, instead of snapping to atan2(0,0) on every stop.
    let heading=0;
    actor.headings=actor.samples.map((s,i,all)=>{
      const next=all[i+1];
      if(next&&next[0]-s[0]<=2000&&Math.hypot(next[1]-s[1],next[2]-s[2])>.03)heading=Math.atan2(next[2]-s[2],next[1]-s[1]);
      return heading;
    });
    actor.deaths.sort((a,b) => a[0]-b[0]);
    let wasDead=false;
    actor.deaths=actor.deaths.filter(([,dead])=>{if(dead===wasDead)return false;wasDead=dead;return true;});
    actor.runLifetime=!!fight.chapters && actor.type==='Pet';
  }
  const chapters=(fight.chapters??[]).map(f=>({...f,start:f.startTime-fight.startTime,end:f.endTime-fight.startTime}));
  const combatWindows=chapters.length?[...chapters].sort((a,b)=>a.start-b.start):[{start:0,end:fight.endTime-fight.startTime}];
  for(const actor of tracks.values()){
    actor.activityWindows=[];
    if(actor.type!=='Player')continue;
    for(const window of combatWindows){
      let lo=0,hi=actor.activity.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(actor.activity[mid]<window.start)lo=mid+1;else hi=mid;}
      if(lo<actor.activity.length&&actor.activity[lo]<=window.end){
        const last=actor.activityWindows.at(-1);
        if(last&&window.start<=last[1])last[1]=Math.max(last[1],window.end);
        else actor.activityWindows.push([window.start,window.end]);
      }
    }
  }
  const gaps=chapters.slice(1).map((next,i)=>({start:chapters[i].end,end:next.start})).filter(g=>g.end>g.start);
  for(const gap of gaps)gap.hasEvents=events.some(e=>e.timestamp>fight.startTime+gap.start&&e.timestamp<fight.startTime+gap.end);
  return { version:1, gameVersion:ruleset, map:raid.map, report, fight, duration: fight.endTime-fight.startTime, chapters, gaps, actors:[...tracks.values()], raw };
}
// Activity is independent of positional confidence. Real casts and combat observations
// keep the character model even when its location must be interpolated.
function coveredByActivity(actor,time) {
  const windows=actor.activityWindows??[];let lo=0,hi=windows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(windows[mid][0]<=time)lo=mid+1;else hi=mid;}
  if(lo&&time<=windows[lo-1][1])return true;
  const events=actor.activity??[];lo=0;hi=events.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(events[mid]<=time)lo=mid+1;else hi=mid;}
  if(lo&&time-events[lo-1]<=5000)return true;
  const casts=actor.casts??[];lo=0;hi=casts.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(casts[mid].start<=time)lo=mid+1;else hi=mid;}
  return !!(lo&&casts[lo-1].end>time&&!casts[lo-1].instant);
}
export function poseAt(actor, time, smoothGaps = false) {
  if(actor.runLifetime && (time<actor.firstSeen || time>actor.lastSeen+3000))return null;
  const s = actor.samples ?? [];
  if (actor.spawnObservedOnly && !actor.spawn && time < actor.firstSeen) return null;
  if (actor.spawn && time < actor.spawn.visibleFrom) return null;
  if (actor.spawn && (!s.length || time < s[0][0])) {
    let dead=false;
    for (const [t,value] of actor.deaths ?? []) {if(t>time)break;dead=value;}
    return {pos:[actor.spawn.position[0],actor.spawn.position[1],null],speed:0,
      facing:actor.spawn.facing,dead,stale:true,estimated:true,wisp:false,discontinuity:false,sampleAge:null,
      positionSource:actor.spawn.synthetic?'unobserved static spawn':'matched spawn estimate'};
  }
  if (!s.length || (time < s[0][0] && actor.type!=='NPC')) return null;
  const beforeFirst=time<s[0][0];
  let lo=0, hi=s.length;
  while (lo<hi) { const mid=(lo+hi)>>>1; if(s[mid][0]<=time) lo=mid+1; else hi=mid; }
  // Legacy replays without spawn assignment retain their first-position fallback.
  // Hold through missing data; only a recorded death removes an observed NPC.
  const a=s[Math.max(0,lo-1)], b=beforeFirst?null:s[lo];
  const gap=b?b[0]-a[0]:Infinity;
  const distance=b?Math.hypot(b[1]-a[1],b[2]-a[2]):0;
  const lifeBoundary=!!b&&(actor.deaths??[]).some(([t])=>t>a[0]&&t<=b[0]);
  const zoneBoundary=!!b&&(actor.positionBreaks??[]).some(t=>t>a[0]&&t<=b[0]);
  let discontinuity=!!b&&(distance/(gap/1000)>35||lifeBoundary||zoneBoundary);
  const fresh = !beforeFirst && time-a[0] <= 2000;
  let pos=a.slice(1), speed=0, facing=actor.headings?.[Math.max(0,lo-1)]??0;
  const loadedBetween=!actor.bufferedRanges||actor.bufferedRanges.some(([start,end])=>start<=a[0]&&end>=b?.[0]);
  let estimated=!!(b && loadedBetween && !discontinuity && gap>2000 && smoothGaps && actor.type==='Player' && gap<=120000 && time>a[0]);
  const wisp=estimated&&!fresh&&distance>.25&&!coveredByActivity(actor,time);
  let movement=null;
  const timing=b&&loadedBetween&&!beforeFirst&&!lifeBoundary&&!zoneBoundary
    ?movementBetween(actor,a,b,time):null;
  if(timing?.blink){
    discontinuity=true;
    pos=(timing.after?b:a).slice(1);
    estimated=timing.after&&time<b[0];
  }
  if (b && loadedBetween && !beforeFirst && !discontinuity && (gap<=2000 || estimated)) {
    const fraction=timing&&(timing.weighted||estimated)?timing.fraction:(time-a[0])/gap;
    if(estimated){
      pos=a.slice(1).map((v,i)=>v===null||b[i+1]===null?null:v+(b[i+1]-v)*fraction);
      speed=distance/(gap/1000);
    }else if(actor.type!=='Player'){
      // Shape-preserving Hermite interpolation. Neighbouring stationary samples
      // produce zero tangents; no axis can overshoot its recorded endpoints.
      const previous=s[lo-2],next=s[lo+1];
      const tangent=(left,right,axis)=>{
        if(!left||!right||right[0]-left[0]>2000||left[axis]===null||right[axis]===null)return null;
        return (right[axis]-left[axis])/(right[0]-left[0]);
      };
      const velocities=[];
      pos=a.slice(1).map((v,i)=>{
        const axis=i+1,w=b[axis];if(v===null||w===null){velocities.push(0);return null;}
        const d=(w-v)/gap;
        const harmonic=(q)=>q===null?d:q*d<=0?0:2*q*d/(q+d);
        const m0=harmonic(tangent(previous,a,axis))*gap,m1=harmonic(tangent(b,next,axis))*gap;
        const u=fraction,u2=u*u,u3=u2*u;
        velocities.push(((6*u2-6*u)*v+(3*u2-4*u+1)*m0+(-6*u2+6*u)*w+(3*u2-2*u)*m1)/gap*1000);
        return (2*u3-3*u2+1)*v+(u3-2*u2+u)*m0+(-2*u3+3*u2)*w+(u3-u2)*m1;
      });
      speed=Math.hypot(velocities[0],velocities[1]);
      if(speed>.03)facing=Math.atan2(velocities[1],velocities[0]);
    }
    if(actor.type==='Player'&&!estimated&&timing){
      const progress=runProgress(distance,timing.fraction,timing.rate,timing.travel_budget);
      pos=a.slice(1).map((v,i)=>v===null||b[i+1]===null?null:v+(b[i+1]-v)*progress.fraction);
      speed=distance*progress.rate;
      if(speed>.03)facing=Math.atan2(b[2]-a[2],b[1]-a[1]);
    }else if(timing?.weighted){
      pos=a.slice(1).map((v,i)=>v===null||b[i+1]===null?null:v+(b[i+1]-v)*fraction);
      speed=distance*timing.rate;
      if(distance>.03)facing=Math.atan2(b[2]-a[2],b[1]-a[1]);
    }
    if(estimated&&distance>.03)facing=Math.atan2(b[2]-a[2],b[1]-a[1]);
    if(actor.type==='Player'&&timing&&distance>.03&&timing.rate<=1000){
      movement={from:a.slice(1),to:b.slice(1),fraction:timing.fraction,rate:timing.rate,duration:gap/1000,recorded_facing:false,travel_budget:timing.travel_budget,run_speed:timing.run_speed,unrestricted:estimated};
    }
  }
  const facings=actor.facings??[];
  let fl=0,fh=facings.length;
  while(fl<fh){const mid=(fl+fh)>>>1;if(facings[mid][0]<=time)fl=mid+1;else fh=mid;}
  if(beforeFirst&&facings.length)facing=facings[0][1];
  if(movement)movement.recorded_facing=!!fl||beforeFirst&&facings.length>0;
  if(fl&&speed<=.03){
    const from=facings[fl-1],to=facings[fl];facing=from[1];
    if(to&&to[0]-from[0]<=2000){
      const angle=Math.atan2(Math.sin(to[1]-from[1]),Math.cos(to[1]-from[1]));
      facing+=angle*(time-from[0])/(to[0]-from[0]);
    }
  }
  let dead=false;
  for(const [t,value] of actor.deaths) { if(t>time) break; dead=value; }
  return { pos, movement:dead?null:movement, speed: dead?0:speed, facing, dead, stale:!fresh, estimated, wisp, discontinuity, sampleAge:beforeFirst?null:time-a[0], positionSource:timing?.blink&&timing.after?'ability jump estimate':beforeFirst?'first observed':estimated?'estimated':time===a[0]?'recorded':b&&!discontinuity&&gap<=2000?'interpolated':'held' };
}
export class ReplayClock {
  constructor(duration=0) { this.duration=duration; this.time=0; this.playing=false; this.rate=1; }
  seek(value) { this.time=Math.max(0,Math.min(this.duration,Number(value)||0)); }
  tick(deltaMs) { if(this.playing) { this.seek(this.time+deltaMs*this.rate); if(this.time>=this.duration) this.playing=false; } return this.time; }
  toggle() { if(this.time>=this.duration) this.seek(0); this.playing=!this.playing; }
}

export const RACES={1:'Human',2:'Orc',3:'Dwarf',4:'Night Elf',5:'Undead',6:'Tauren',7:'Gnome',8:'Troll'};
const RACIAL_RACES={20589:7,20594:3,20600:1,20580:4,20572:2,20549:6,7744:5,20577:5,20554:8,26296:8,26297:8};
export function latestAt(samples,t) {
  let lo=0,hi=samples.length;while(lo<hi){const mid=(lo+hi)>>>1;if(samples[mid][0]<=t)lo=mid+1;else hi=mid;}
  return lo?samples[lo-1][1]:null;
}
export function enrichCombat(replay, itemModels={}, spellMetadata={}) {
  const {raw}=replay;
  const all=replay.actors, index=new Map(all.map(a=>[a.key,a]));
  const abilities=new Map((raw.abilities??[]).map(a=>[a.gameID,a]));
  const details=Object.values(raw.playerDetails?.data?.playerDetails??{}).flat();
  const info=new Map(raw.events.filter(e=>e.type==='combatantinfo').map(e=>[e.sourceID,e]));
  for(const a of all){
    combatIndexes.delete(a);
    const d=details.find(p=>p.id===a.id), ci=info.get(a.id);
    a.owner=raw.actors.find(x=>x.id===a.id)?.petOwner??null;
    a.ownerName=raw.actors.find(x=>x.id===a.owner)?.name??null;
    a.gear=(d?.combatantInfo?.gear??ci?.gear?.map((g,slot)=>({...g,slot}))??[]).filter(g=>g.id&&g.slot<19).map(g=>({...g,model:itemModels[g.id]??null}));
    a.faction=ci?.faction??null;
    a.race=null;a.raceSource='Unknown';a.sex=null;
    if(a.class==='Druid'&&a.faction!=null){a.race=a.faction===1?4:6;a.raceSource='Vanilla class / faction';}
    a.health=[];a.power=[];a.resourceChanges=[];a.casts=[];a.auras=[];a.initialAuras=(replay.chapters.length?[]:ci?.auras??[]).map(x=>x.ability??x.abilityGameID).filter(Number.isInteger);
    a.icon=raw.actors.find(x=>x.id===a.id)?.icon??null;
    if(a.type==='Pet'&&!a.displayID&&a.gameID>100000){a.displayID=447;a.petModelSource='Representative wolf; original model not recorded';}
  }
  const combat=[];
  for(const [i,e] of raw.events.map((e,i)=>[i,e]).sort((a,b)=>a[1].timestamp-b[1].timestamp)){
    const t=e.timestamp-raw.fight.startTime;if(t<0||t>replay.duration)continue;
    const source=index.get(`${e.sourceID}:${e.sourceInstance||1}`), target=index.get(`${e.targetID}:${e.targetInstance||1}`);
    const loggedSpell=e.abilityGameID??e.ability?.guid??0;
    // WCL uses -4 for some melee events; the client uses spell 1 for melee.
    const spell=loggedSpell===-4?1:Math.max(0,loggedSpell);
    const ability=abilities.get(loggedSpell)??{name:`Spell ${spell}`,icon:null};
    if(source&&e.type==='cast'&&RACIAL_RACES[spell]){source.race=RACIAL_RACES[spell];source.raceSource=`Recorded ${ability.name}`;}
    for(const [side,a] of [['source',source],['target',target]]){
      if(!a)continue;
      const r=e[`${side}Resources`]??(e.resourceActor===(side==='source'?1:2)?e:null);
      if(r&&Number.isFinite(r.hitPoints)&&r.maxHitPoints>0)a.health.push([t,{current:r.hitPoints,max:r.maxHitPoints,percent:Math.max(0,Math.min(1,r.hitPoints/r.maxHitPoints))}]);
      const p=r?.classResources?.find(p=>p.max>0&&Number.isFinite(p.amount)&&p.type>=0&&p.type<=3);if(p)a.power.push([t,{current:Math.max(0,Math.min(p.max,p.amount)),max:p.max,type:p.type}]);
    }
    if(e.type==='resourcechange'&&target&&Number.isInteger(e.resourceChangeType)&&Number.isFinite(e.resourceChange)){
      const type=e.resourceChangeType,max=Number.isFinite(e.maxResourceAmount)&&e.maxResourceAmount>0?e.maxResourceAmount:null;
      target.resourceChanges.push([t,{type,gain:e.resourceChange,waste:Number.isFinite(e.waste)?e.waste:0,max,spell,name:ability.name,icon:ability.icon}]);
      // A gain/cap is useful evidence, but it does not identify the remaining pool.
      // An exact snapshot on this same event wins over a cap-only sample.
      if(type>=0&&type<=3&&max)target.power.push([t,{current:null,max,type}]);
    }
    if(source&&e.type==='combatantinfo')source.auras.push([t,{reset:(e.auras??[]).map(a=>a.ability??a.abilityGameID).filter(Number.isInteger)}]);
    if(source&&target&&e.type==='summon'&&!target.samples.length)combat.push({id:i,t,kind:'summon-cue',source:source.key,target:target.key,spell,name:ability.name,illustrative:true});
    if(source&&e.type==='begincast')combat.push({id:i,t,kind:'start',source:source.key,target:target?.key??null,spell,name:ability.name});
    if(source&&e.type==='cast')combat.push({id:i,t,kind:'go',source:source.key,target:target?.key??null,spell,name:ability.name,melee:!!e.melee||spell===1});
    if(target&&e.type==='interrupt')combat.push({id:i,t,kind:'interrupt',source:source?.key??null,target:target.key,spell,name:ability.name});
    if(target&&/^(apply|remove|refresh)(buff|debuff)/.test(e.type))target.auras.push([t,{spell,name:ability.name,icon:ability.icon,remove:e.type.startsWith('remove')&&!e.type.endsWith('stack'),debuff:e.type.includes('debuff'),stack:e.stack??1}]);
    if(target&&(e.type==='damage'||e.type==='heal'))combat.push({id:i,t,kind:e.type,source:source?.key??null,target:target.key,spell,name:ability.name,amount:e.amount??0,melee:!!e.melee||spell===1,tick:!!e.tick});
  }
  for(const a of all){a.health.sort((a,b)=>a[0]-b[0]);a.power.sort((a,b)=>a[0]-b[0]||Number(a[1].current!==null)-Number(b[1].current!==null));a.resourceChanges.sort((a,b)=>a[0]-b[0]);a.casts.sort((a,b)=>a.start-b.start);a.auras.sort((a,b)=>a[0]-b[0]);}
  replay.combat=combat.sort((a,b)=>a.t-b.t||a.id-b.id);replay.abilities=abilities;
  reconstructCasts(replay,spellMetadata);
  for(const actor of all)prepareMovement(actor);
  replay.visualEvents=buildVisualEvents(replay);
  return replay;
}
const combatIndexes = new WeakMap();
const EMPTY_COMBAT = [];
const AURA_CHECKPOINT = 128;
function afterSample(samples,t) {
  let lo=0,hi=samples.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(samples[mid][0]<=t)lo=mid+1;else hi=mid;}
  return lo;
}
function combatIndex(actor) {
  const casts=actor.casts??EMPTY_COMBAT,auras=actor.auras??EMPTY_COMBAT,
    initial=actor.initialAuras??EMPTY_COMBAT,resources=actor.resourceChanges??EMPTY_COMBAT;
  let index=combatIndexes.get(actor);
  if(index&&index.casts===casts&&index.castLength===casts.length&&
    index.auras===auras&&index.auraLength===auras.length&&
    index.initial===initial&&index.initialLength===initial.length&&
    index.resources===resources&&index.resourceLength===resources.length)return index;
  let size=1;
  while(size<casts.length)size*=2;
  const ends=new Float64Array(size*2).fill(-Infinity);
  let sortedCasts=true,sortedResources=true,sortedAuras=true;
  for(let i=0;i<casts.length;i++){
    const cast=casts[i];
    if(!Number.isFinite(cast.start)||!Number.isFinite(cast.end)||(i&&casts[i-1].start>cast.start))sortedCasts=false;
    if(!cast.instant)ends[size+i]=cast.end;
  }
  for(let i=size-1;i;i--)ends[i]=Math.max(ends[i*2],ends[i*2+1]);
  for(let i=0;i<resources.length;i++)if(!Number.isFinite(resources[i][0])||(i&&resources[i-1][0]>resources[i][0]))sortedResources=false;
  for(let i=0;i<auras.length;i++)if(!Number.isFinite(auras[i][0])||(i&&auras[i-1][0]>auras[i][0]))sortedAuras=false;
  const state=new Map(initial.map(spell=>[spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false}]));
  index={casts,castLength:casts.length,auras,auraLength:auras.length,
    initial,initialLength:initial.length,resources,resourceLength:resources.length,
    ends,size,sortedCasts,sortedResources,sortedAuras,state,cursor:0,values:[...state.values()],
    checkpoints:new Map([[0,[...state]]])};
  combatIndexes.set(actor,index);
  return index;
}
function activeCast(index,t) {
  const {casts,ends,size}=index;
  if(!index.sortedCasts||Number.isNaN(t))return casts.find(c=>!c.instant&&c.start<=t&&c.end>t)??null;
  let lo=0,hi=casts.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(casts[mid].start<=t)lo=mid+1;else hi=mid;}
  // A maximum-end tree finds the first overlapping cast in original array order,
  // including equal starts. Taking the latest start would change overlap results.
  function first(node,start,end) {
    if(start>=lo||ends[node]<=t)return -1;
    if(end-start===1)return start;
    const mid=(start+end)>>>1,left=first(node*2,start,mid);
    return left<0?first(node*2+1,mid,end):left;
  }
  const found=first(1,0,size);
  return found<0?null:casts[found];
}
function auraState(index,t) {
  const events=index.auras;
  if(!index.sortedAuras){
    const state=new Map(index.initial.map(spell=>[spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false}]));
    for(const [at,a]of events){
      if(at>t)break;
      if(a.reset){state.clear();for(const spell of a.reset)state.set(spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false});}
      else if(a.remove)state.delete(a.spell);else state.set(a.spell,a);
    }
    return [...state.values()];
  }
  let lo=0,hi=events.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(events[mid][0]>t)hi=mid;else lo=mid+1;}
  const target=lo;
  if(target===index.cursor)return index.values;
  if(target<index.cursor){
    const checkpoint=Math.floor(target/AURA_CHECKPOINT)*AURA_CHECKPOINT;
    index.state=new Map(index.checkpoints.get(checkpoint));
    index.cursor=checkpoint;
  }
  for(;index.cursor<target;){
    const a=events[index.cursor++][1],state=index.state;
    if(a.reset){state.clear();for(const spell of a.reset)state.set(spell,{spell,name:`Spell ${spell}`,stack:1,debuff:false});}
    else if(a.remove)state.delete(a.spell);
    else state.set(a.spell,a);
    if(index.cursor%AURA_CHECKPOINT===0&&!index.checkpoints.has(index.cursor))
      index.checkpoints.set(index.cursor,[...state]);
  }
  index.values=[...index.state.values()];
  return index.values;
}
export function combatStateAt(actor,t){
  const index=combatIndex(actor),cast=activeCast(index,t),auras=auraState(index,t);
  let health=latestAt(actor.health??[],t);
  let power=latestAt(actor.power??[],t);
  const loadedWindow=actor.bufferedRanges?.find(([start,end])=>start<=t&&end>=t);
  if(actor.bufferedRanges){
    if(!loadedWindow||!health||!(actor.health[afterSample(actor.health,t)-1]?.[0]>=loadedWindow[0]))health=null;
    if(!loadedWindow||!power||!(actor.power[afterSample(actor.power,t)-1]?.[0]>=loadedWindow[0]))power=null;
  }
  if(!health&&actor.type==='NPC'){
    const max=actor.health?.[0]?.[1]?.max??100;
    health={current:max,max,percent:1,initial:true};
  }
  return {health,power,resources:resourcesAt(actor,t),cast:cast?{...cast,progress:Math.min(1,(t-cast.start)/Math.max(1,cast.end-cast.start))}:null,auras:auras.slice()};
}
export function eventsBetween(replay,from,to){
  if(to<from)return [];
  const events=replay.combat;
  function after(t){let lo=0,hi=events.length;while(lo<hi){const mid=(lo+hi)>>>1;if(events[mid].t<=t)lo=mid+1;else hi=mid;}return lo;}
  return events.slice(after(from),after(to));
}
export function chapterAt(replay,t){
  return replay.chapters?.find(f=>f.start<=t&&(f.end>t||(t===replay.duration&&f.end===t)))??null;
}

export function resourcesAt(actor,t){
 const index=combatIndex(actor),events=index.resources;
 const changes=index.sortedResources&&!Number.isNaN(t)
   ?events.slice(afterSample(events,t-5000),afterSample(events,t))
   :events.filter(([at])=>at<=t&&at>t-5000),totals=new Map();
 for(const [,e]of changes){const sum=totals.get(e.type)??{type:e.type,gain:0,waste:0};sum.gain+=e.gain;sum.waste+=e.waste;totals.set(e.type,sum);}
 return {changes:changes.slice(-5).reverse().map(([at,e])=>({...e,at})),totals:[...totals.values()]};
}
