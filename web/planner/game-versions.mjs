// Log rulesets are independent of the installed asset build and file schema version.
export const GAME_VERSIONS = [
  {id:'vanilla',name:'Classic Era',host:'vanilla.warcraftlogs.com',client:'vanilla-1.12.1'},
  {id:'sod',name:'Season of Discovery',host:'sod.warcraftlogs.com',client:'sod-1.15'},
];
export function gameVersion(id='vanilla') {
  const version=GAME_VERSIONS.find(v=>v.id===id);
  if(!version)throw new Error(`Unsupported game version: ${id}`);
  return version;
}
export function reportSource(value, fallback='vanilla') {
  const text=String(value).trim();
  if(/^[a-zA-Z0-9]{16}$/.test(text))return {code:text,gameVersion:gameVersion(fallback).id};
  let url;try{url=new URL(text);}catch{}
  const code=url?.pathname.match(/^\/reports\/([a-zA-Z0-9]{16})(?:\/|$)/)?.[1];
  const version=GAME_VERSIONS.find(v=>v.host===url?.hostname);
  if(url?.protocol!=='https:'||!code||(!version&&!['www.warcraftlogs.com','warcraftlogs.com'].includes(url?.hostname)))
    throw new Error('Paste a Warcraft Logs report URL or its 16-character code.');
  return {code,gameVersion:version?.id??gameVersion(fallback).id};
}
