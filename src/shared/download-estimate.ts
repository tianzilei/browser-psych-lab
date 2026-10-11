import type {FrozenProtocol} from './protocol.js';
export function downloadEstimate(frozen:FrozenProtocol,groupIndex:number){
  const groups=frozen.protocol.groups,group=groups[groupIndex];if(!group)return 0;
  const infos=[...new Map(group.trials.flatMap(t=>{const a=frozen.assets.find(a=>a.asset_id===t.asset_id);return a?[[a.hash,a] as const]:[];})).values()];
  if(!infos.length)return 0;
  const count=group.sampling?Object.values(group.sampling.allocations[0]!).reduce((n,v)=>n+v,0):infos.length;
  return infos.reduce((n,a)=>n+a.bytes,0)*Math.min(count,infos.length)/infos.length;
}
export function downloadSize(bytes:number){return bytes>=1000000?`${(bytes/1000000).toFixed(1)} MB`:`${Math.max(1,Math.ceil(bytes/1000))} KB`;}
