import type {AssetInfo} from './protocol.js';
import type {GroupPlan} from './lab-contract.js';
export interface PhotoIdentity {group_id:string;instance_id:string;photo_id:string;photo_order:number;asset_id:string;photo_category:string|null;photo_filename:string|null;photo_path:string|null;photo_hash:string|null}
export function photoIdentity(plan:Pick<GroupPlan,'group_id'|'roots'>,index:number,assets:ReadonlyMap<string,Pick<AssetInfo,'name'|'hash'>>):PhotoIdentity|null {
  const root=plan.roots[index];if(!root?.asset_id)return null;const asset=assets.get(root.asset_id),path=asset?.name??null;
  return {group_id:plan.group_id,instance_id:`${root.root_id}:1`,photo_id:root.root_id,photo_order:index+1,asset_id:root.asset_id,photo_category:root.category??null,photo_filename:path?.split('/').at(-1)??null,photo_path:path,photo_hash:asset?.hash??null};
}
export function resolvePhoto(photos:readonly PhotoIdentity[],context:Record<string,unknown>|undefined):PhotoIdentity|undefined {
  if(!context)return;const matches=photos.filter(p=>(typeof context.instance_id==='string'?p.instance_id===context.instance_id:typeof context.asset_id==='string'?p.asset_id===context.asset_id:false)
    &&(typeof context.asset_id!=='string'||p.asset_id===context.asset_id)&&(typeof context.group_id!=='string'||p.group_id===context.group_id));
  return matches.length===1?matches[0]:undefined;
}
