// Additional source-verified pulse families. A missing cast target by itself
// never opts an unknown projectile into latest-result grouping.
export function raidResultPolicy(replay,event){
 if(!['sod','vanilla'].includes(replay.gameVersion)||![19712,1226282,27989].includes(event.spell))return null;
 const actor=replay.actors.find(a=>a.key===event.source);
 if(actor?.type!=='NPC')return null;
 let encounter,mechanic;
 if(replay.gameVersion==='vanilla'){
  if(replay.map!==409||event.spell!==19712||actor.gameID!==12264)return null;
  encounter=50667;mechanic='shazzrah-arcane-explosion-pulse';
 }else if(replay.map===409&&event.spell===19712&&[228434,184361].includes(actor.gameID)){
  encounter=100667;mechanic='shazzrah-arcane-explosion-pulse';
 }else if(replay.map===533&&event.spell===1226282&&actor.gameID===16060){
  encounter=201109;mechanic='gothik-shadow-bolt-volley';
 }else if(replay.map===533&&event.spell===27989&&actor.gameID===16127){
  encounter=201109;mechanic='gothik-spectral-trainee-explosion';
 }else return null;
 const origin=replay.raw?.fight?.startTime;
 if(!Number.isFinite(origin))return null;
 const chapters=replay.fight?.chapters?.length?replay.fight.chapters:[replay.fight];
 if(!chapters.some(c=>c?.encounterID===encounter&&
  (Number.isFinite(c.startTime)?c.startTime-origin:c.start??0)<=event.t&&
  event.t<=(Number.isFinite(c.endTime)?c.endTime-origin:c.end??replay.duration)))return null;
 return {kind:'encounter-result-association',mechanic,basis:'observed repeated source-instance result group; recorded impact timestamps preserved'};
}
