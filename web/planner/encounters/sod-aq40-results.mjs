// These recorded result groups belong to their most recent observed activation.
// Unknown spells retain the generic FIFO matching behavior.
export function aq40ResultPolicy(replay,event){
 if(!['sod','vanilla'].includes(replay.gameVersion)||replay.map!==531)return null;
 const actor=replay.actors.find(a=>a.key===event.source);
 if(actor?.type!=='NPC')return null;
 let encounter,mechanic;
 const vanilla=replay.gameVersion==='vanilla';
 if(event.spell===26084&&actor.gameID===15516){encounter=vanilla?50711:100711;mechanic='sartura-whirlwind-pulse';}
 else if(event.spell===26134&&(vanilla?[15589]:[15589,15334]).includes(actor.gameID)){encounter=vanilla?50717:100717;mechanic='cthun-eye-beam-chain';}
 else if(vanilla&&event.spell===26192&&[15263,176525].includes(actor.gameID)){encounter=50709;mechanic='skeram-arcane-explosion';}
 else if(vanilla&&event.spell===19128&&actor.gameID===15544){encounter=50710;mechanic='vem-knock-away';}
 else if(vanilla&&event.spell===25993&&actor.gameID===15299){encounter=50713;mechanic='viscidus-poison-shock';}
 else if(vanilla&&[26102,26103].includes(event.spell)&&actor.gameID===15517){encounter=50716;mechanic='ouro-sand-blast-and-sweep';}
 else return null;
 const origin=replay.raw?.fight?.startTime;
 if(!Number.isFinite(origin))return null;
 const chapters=replay.fight?.chapters?.length?replay.fight.chapters:[replay.fight];
 if(!chapters.some(c=>c?.encounterID===encounter&&
  (Number.isFinite(c.startTime)?c.startTime-origin:c.start??0)<=event.t&&
  event.t<=(Number.isFinite(c.endTime)?c.endTime-origin:c.end??replay.duration)))return null;
 return {kind:'encounter-result-association',mechanic,basis:'recorded source-instance pulse/chain result group; recorded impact times preserved'};
}
