// Cannon Fire is an observed repeating area pulse. Its result group follows the
// latest artillery cast; do not apply that association rule to unknown spells.
export function isBeatrixCannonPulse(replay,event){
 if(replay.gameVersion!=='sod'||event.spell!==1232829||event.target)return false;
 if(replay.actors.find(a=>a.key===event.source)?.gameID!==241904)return false;
 const origin=replay.raw?.fight?.startTime;
 if(!Number.isFinite(origin))return false;
 const chapters=replay.fight?.chapters?.length?replay.fight.chapters:[replay.fight];
 return chapters.some(c=>c?.encounterID===3187&&
  (Number.isFinite(c.startTime)?c.startTime-origin:c.start??0)<=event.t&&
  event.t<=(Number.isFinite(c.endTime)?c.endTime-origin:c.end??replay.duration));
}
