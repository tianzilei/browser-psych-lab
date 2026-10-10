import {ContractError,object,id} from './contract.js';
import {Xoshiro128,sampleBounded,type State} from './prng.js';
import type {Trial} from './protocol.js';
export interface Sampling {allocations:Record<string,number>[]}
export interface SamplingAudit {algorithm:'stratified-without-replacement-v1';allocation:number;allocation_label:string;counts:Record<string,number>;selected:string[];seed:State}
export function parseSampling(value:unknown,trials:Trial[]):Sampling {
  const v=object(value);
  if(Object.keys(v).some(k=>k!=='allocations')||!Array.isArray(v.allocations)||!v.allocations.length||v.allocations.length>20)throw new ContractError('INVALID_TRIAL_SAMPLING');
  const pools=new Map<string,number>();
  for(const t of trials){if(!t.category)throw new ContractError('TRIAL_CATEGORY_REQUIRED');pools.set(t.category,(pools.get(t.category)??0)+1);}
  let total:number|undefined;
  const allocations=v.allocations.map(value=>{
    const a=object(value),counts:Record<string,number>={};
    if(Object.keys(a).length!==pools.size)throw new ContractError('INVALID_SAMPLING_ALLOCATION');
    for(const [key,n] of Object.entries(a)){
      id(key);if(['__proto__','constructor','prototype'].includes(key)||!pools.has(key)||typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>pools.get(key)!)throw new ContractError('INVALID_SAMPLING_ALLOCATION');counts[key]=n;
    }
    const count=Object.values(counts).reduce((n,v)=>n+v,0);
    if(count>100||(total!==undefined&&total!==count))throw new ContractError('INVALID_SAMPLING_COUNT');total=count;
    return counts;
  });
  return {allocations};
}
export function sampleTrials(trials:Trial[],sampling:Sampling,seed:State):{roots:Trial[];sampling:SamplingAudit}{
  const rng=new Xoshiro128(seed),draw=(n:number)=>sampleBounded(n,()=>rng.next(),128).index;
  const shuffle=<T>(values:T[])=>{const out=[...values];for(let i=out.length-1;i>0;i--){const j=draw(i+1);[out[i],out[j]]=[out[j]!,out[i]!];}return out;};
  const allocation=draw(sampling.allocations.length),counts=sampling.allocations[allocation]!,selected:Trial[]=[];
  for(const [category,count] of Object.entries(counts))selected.push(...shuffle(trials.filter(t=>t.category===category)).slice(0,count));
  const roots=shuffle(selected);
  return {roots,sampling:{algorithm:'stratified-without-replacement-v1',allocation,allocation_label:String.fromCharCode(65+allocation),counts,selected:roots.map(t=>t.root_id),seed:[...seed]}};
}
