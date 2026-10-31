import {gameVersion} from './game-versions.mjs';
import {raidByMap} from './raids.mjs';
export const STORAGE_KEY='betterwcl.plan.v1.map409';
export const planStorageKey=(map=409,version='vanilla')=>gameVersion(version).id!=='vanilla'?`pullfiction.plan.v1.${version}.map${map}`:map===409?STORAGE_KEY:`pullfiction.plan.v1.map${map}`;
export const MARK_TYPES=['marker','route','arrow','circle','cone','polygon','drawing','label'];
export const STEP_TYPES=['pull','boss','phase','route','note'];
export const PLAN_COLORS=['#edc66d','#65c6b4','#ed7971','#78ace0','#b597e2','#eeeeee'];
export function planId(){return globalThis.crypto?.randomUUID?.()??`p${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;}
export function newStep(name='Pull 1',kind='pull'){return {id:planId(),name,kind,start:null,end:null,notes:'',annotations:[]};}
export function newAnnotation(type,point,style={}){return {id:planId(),name:'',type,points:[[...point]],color:PLAN_COLORS[0],icon:'8',size:5,width:3,label:'',notes:'',hidden:false,locked:false,comments:[],...style};}
export function emptyPlan(map=409,version='vanilla'){const raid=raidByMap(map,version);if(!raid)throw Error('Unsupported raid map.');return validatePlan({version:2,client:gameVersion(version).client,gameVersion:version,mapId:map,name:`${raid.name} · first route`,steps:[newStep()]});}
const text=(v,n,label)=>{if(typeof v!=='string'||v.length>n)throw Error(`${label} must be at most ${n} characters.`);return v;};
const point=p=>{if(!Array.isArray(p)||p.length!==3||p.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>20000))throw Error('Every point must contain three finite WoW coordinates within the map bounds.');return [...p];};
export function validatePlan(input){
 if(!input||typeof input!=='object'||![1,2].includes(input.version)||!Number.isInteger(input.mapId)||!raidByMap(input.mapId,input.gameVersion??'vanilla')||input.client!==gameVersion(input.gameVersion??'vanilla').client)throw Error('Expected a raid plan (version 1 or 2, supported map).');
 const name=text(input.name,100,'Plan name');
 let source=input.steps;
 if(input.version===1){
  for(const [k,max]of [['markers',500],['route',2000]])if(!Array.isArray(input[k])||input[k].length>max)throw Error(`Too many or missing ${k}. Maximum ${max}.`);
  const annotations=input.markers.map((p,i)=>newAnnotation('marker',point(p),{id:`legacy-marker-${i}`,label:`${i+1}`}));
  if(input.route.length)annotations.push({...newAnnotation('route',point(input.route[0]),{id:'legacy-route',color:PLAN_COLORS[1]}),points:input.route.map(point)});
  source=[{...newStep('Original plan','route'),id:'legacy-step',annotations}];
 }
 if(!Array.isArray(source)||!source.length||source.length>2048)throw Error('A plan needs between 1 and 2048 steps.');
 const editCounts={},editNames=new Set(source.flatMap(s=>(s.annotations??[]).map(a=>a.name).filter(Boolean)));
 const ids=new Set();let count=0,points=0,commentCount=0,characters=0;
 const identity=id=>{if(typeof id!=='string'||!id.length||id.length>80||ids.has(id))throw Error('Plan identifiers must be unique.');ids.add(id);return id;};
 const layerSource=input.layers??[{id:'default-layer',name:'Plan',hidden:false}];
 if(!Array.isArray(layerSource)||!layerSource.length||layerSource.length>1024)throw Error('A plan needs between 1 and 1024 layers.');
 const layers=layerSource.map(l=>({id:identity(l.id),name:text(l.name,100,'Layer name'),hidden:!!l.hidden}));
 const layerIDs=new Set(layers.map(l=>l.id));
 const steps=source.map(s=>{
  const layerId=s.layerId??layers[0].id;
  if(!layerIDs.has(layerId))throw Error('Page references an unknown layer.');

  if(!STEP_TYPES.includes(s.kind))throw Error('Unknown step type.');
  if(!Array.isArray(s.annotations))throw Error('Step annotations are missing.');
  const start=s.start??null,end=s.end??null;
  if((start!==null&&(!Number.isFinite(start)||start<0))||(end!==null&&(!Number.isFinite(end)||end<0))||(start!==null&&end!==null&&end<=start))throw Error('Step end must be after its start.');
  let snapshot;
  if(s.snapshot!==undefined){
   const v=s.snapshot;
   if(!v||!Number.isFinite(v.time)||v.time<0||!Array.isArray(v.actors)||v.actors.length>4096)throw Error('Invalid plan snapshot.');
   const keys=new Set();
   snapshot={report:text(v.report,80,'Snapshot report'),time:v.time,actors:v.actors.map(a=>{
    const key=text(a.key,80,'Snapshot actor');
    const appearance={};
    // WCL gameID can identify a player or pet, not just a creature entry. Preserve its native u32 range.
    for(const [key,max] of [['displayID',10000000],['gameID',0xffffffff],['race',1000],['sex',2]])if(a[key]!==undefined&&a[key]!==null){if(!Number.isInteger(a[key])||a[key]<0||a[key]>max)throw Error('Invalid actor appearance.');appearance[key]=a[key];}
    if(a.scale!==undefined){if(!Number.isFinite(a.scale)||a.scale<.05||a.scale>20)throw Error('Invalid actor scale.');appearance.scale=a.scale;}
    if(a.recordedFacing!==undefined){if(!Number.isFinite(a.recordedFacing))throw Error('Invalid recorded facing.');appearance.recordedFacing=a.recordedFacing;}

    if(keys.has(key)||!Number.isFinite(a.facing))throw Error('Invalid snapshot actor.');keys.add(key);
    return {...appearance,key,name:text(a.name,120,'Actor name'),class:text(a.class,40,'Actor class'),type:text(a.type,40,'Actor type'),position:point(a.position),...(a.recorded?{recorded:point(a.recorded)}:{}),facing:a.facing};
   })};
  }
  return {...(snapshot?{snapshot}:{}),layerId,id:identity(s.id),name:text(s.name,100,'Step name'),kind:s.kind,start,end,notes:text(s.notes??'',4000,'Step notes'),annotations:s.annotations.map(a=>{
   if(++count>1000||!MARK_TYPES.includes(a.type)||!Array.isArray(a.points)||!a.points.length||(points+=a.points.length)>20000)throw Error('Invalid annotation type or point count.');
   if(!/^#[a-f0-9]{6}$/i.test(a.color)||!Number.isFinite(a.size)||a.size<.5||a.size>100||!Number.isFinite(a.width)||a.width<1||a.width>8)throw Error('Invalid annotation color or size.');
   if(typeof a.icon!=='string'||!(/^[1-8]$/.test(a.icon)||/^(ability|spell|inv|trade)_[a-z0-9_]+$/i.test(a.icon)))throw Error('Unknown marker icon.');
   if(!Array.isArray(a.comments??[]))throw Error('Invalid comments.');
   const comments=(a.comments??[]).map(c=>{if(++commentCount>2000)throw Error('Too many comments.');characters+=(c.text?.length??0);return {id:identity(c.id),text:text(c.text,2000,'Comment'),createdAt:text(c.createdAt,40,'Comment time')};});
   const title=a.type.charAt(0).toUpperCase()+a.type.slice(1);let name=a.name;
   if(!name){do{name=`${title} ${editCounts[a.type]=(editCounts[a.type]??0)+1}`;}while(editNames.has(name));}
   editNames.add(name);
   return {...(a.actor?{actor:text(a.actor,100,'Actor'),actorReport:text(a.actorReport??'',80,'Actor report')} : {}),name:text(name,120,'Edit name'),id:identity(a.id),type:a.type,points:a.points.map(point),color:a.color,icon:a.icon,size:a.size,width:a.width,label:text(a.label??'',120,'Label'),notes:text(a.notes??'',4000,'Notes'),hidden:!!a.hidden,locked:!!a.locked,comments};
  })};
 });
 if(characters>200000)throw Error('Plan comments are too large.');
 // Read-only compatibility summaries preserve old exports/consumers. Steps own edits.
 const all=steps.flatMap(s=>s.annotations);
 return {version:2,gameVersion:gameVersion(input.gameVersion??'vanilla').id,client:input.client,mapId:input.mapId,name,layers,steps,markers:all.filter(a=>a.type==='marker').map(a=>[...a.points[0]]),route:all.filter(a=>a.type==='route').flatMap(a=>a.points.map(p=>[...p]))};
}
export function parsePlan(text){if(typeof text!=='string'||text.length>2000000)throw Error('Plan file is too large.');return validatePlan(JSON.parse(text));}
export function routeLength(route){return route.slice(1).reduce((sum,p,i)=>sum+Math.hypot(...p.map((v,j)=>v-route[i][j])),0);}
export function addPoint(plan,tool,p){const next=validatePlan(plan),step=next.steps[0];if(tool==='marker')step.annotations.push(newAnnotation('marker',point(p)));else if(tool==='route'){let route=step.annotations.find(a=>a.type==='route');if(route)route.points.push(point(p));else step.annotations.push(newAnnotation('route',point(p),{color:PLAN_COLORS[1]}));}return validatePlan(next);}
