全项目设计讨论，传输段 9，源码主题：随机化、动态补测及重放（源包 3/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/shared/trial-design.ts L1–L89

```
import {ContractError, object} from './contract.js';
import {Xoshiro128, sampleBounded, type State} from './prng.js';
import type {Group, Trial, TimingDefaults, TimingSpec, Ordering} from './protocol.js';

const phases = ['stimulus_ms','isi_ms','feedback_ms'] as const;
export function parseTiming(value:unknown):TimingSpec {
  if(typeof value==='string'){
    const match=/^\s*(\d+(?:\.\d+)?)\s*(?:\+-|±)\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if(!match)throw new ContractError('INVALID_JITTER');
    value={base:Number(match[1])*1000,jitter:Number(match[2])*1000};
  }
  const v=typeof value==='number'?{base:value,jitter:0}:object(value);
  if(Object.keys(v).some(k=>!['base','jitter'].includes(k))||typeof v.base!=='number'||typeof v.jitter!=='number'
    || !Number.isFinite(v.base)||!Number.isFinite(v.jitter)||v.jitter<0||v.base-v.jitter<0||v.base+v.jitter>60000)
    throw new ContractError('INVALID_JITTER');
  return {base:v.base,jitter:v.jitter};
}
export function parseTimingDefaults(value:unknown):TimingDefaults {
  const v=object(value),out:TimingDefaults={};
  if(Object.keys(v).some(k=>!phases.includes(k as typeof phases[number])))throw new ContractError('UNKNOWN_TIMING_FIELD');
  for(const phase of phases)if(v[phase]!==undefined)out[phase]=parseTiming(v[phase]);
  return out;
}
export function parseOrdering(value:unknown):Ordering {
  const v=object(value);
  if(Object.keys(v).some(k=>!['mode','max_run'].includes(k))||!['fixed','shuffle','category','balanced'].includes(String(v.mode))
    ||(v.max_run!==undefined&&(v.mode!=='balanced'||!Number.isInteger(v.max_run)||Number(v.max_run)<1||Number(v.max_run)>100)))
    throw new ContractError('INVALID_TRIAL_ORDERING');
  return {mode:v.mode as Ordering['mode'],...(v.max_run!==undefined?{max_run:Number(v.max_run)}:{})};
}
function random(seed:State,domain:number){
  const state=seed.map((n,i)=>(n^Math.imul(domain+i+1,0x9e3779b9))>>>0) as State;
  if(state.every(n=>n===0))state[0]=1;
  const rng=new Xoshiro128(state);return (size:number)=>sampleBounded(size,()=>rng.next(),128).index;
}
function shuffle<T>(items:T[],draw:(n:number)=>number):T[]{
  const out=[...items];for(let i=out.length-1;i>0;i--){const j=draw(i+1);[out[i],out[j]]=[out[j]!,out[i]!];}return out;
}
// Symmetric, evenly spaced slots: exact requested mean, including odd/small N.
export function balancedDurations(spec:TimingSpec,count:number,seed:State,domain=0):number[]{
  const values=Array.from({length:count},(_,i)=>spec.base+(count>1?(2*i/(count-1)-1)*spec.jitter:0));
  return shuffle(values,random(seed,domain));
}
export function orderTrials(trials:Trial[],ordering:Ordering|undefined,seed:State):Trial[]{
  if(!ordering||ordering.mode==='fixed')return [...trials];
  const draw=random(seed,10);
  if(ordering.mode==='shuffle')return shuffle(trials,draw);
  const buckets=new Map<string,Trial[]>();
  for(const t of trials){if(!t.category)throw new ContractError('TRIAL_CATEGORY_REQUIRED');const list=buckets.get(t.category)??[];list.push(t);buckets.set(t.category,list);}
  for(const [key,list] of buckets)buckets.set(key,shuffle(list,draw));
  if(ordering.mode==='category')return shuffle([...buckets.keys()],draw).flatMap(key=>buckets.get(key)!);
  const cap=ordering.max_run??1,out:Trial[]=[];let last='',run=0;
  while(out.length<trials.length){
    const keys=[...buckets.keys()].filter(k=>buckets.get(k)!.length&&!(k===last&&run===cap));
    // Choose only prefixes from which every remaining category fits into gaps.
    const viable=keys.filter(key=>{
      const nextRun=key===last?run+1:1,total=trials.length-out.length-1;
      return [...buckets].every(([k,b])=>{
        const n=b.length-(k===key?1:0),others=total-n;
        return n<=cap*others+(k===key?cap-nextRun:cap);
      });
    });
    if(!viable.length)throw new ContractError('UNSATISFIABLE_CATEGORY_BALANCE');
    const key=viable[draw(viable.length)]!;out.push(buckets.get(key)!.pop()!);run=key===last?run+1:1;last=key;
  }
  return out;
}
export interface DesignAudit {algorithm:'trial-design-v1'; requested:Trial[]; balanced_pools:Record<string,string[]>; quantization:'ceil-frame'; repeats:'reuse-root-excluded-from-balance'}
export function realizeTrials(group:Group,roots:Trial[],seed:State,frame:number):{roots:Trial[];design?:DesignAudit}{
  const requested=roots.map(t=>({...t})),pools:Record<string,string[]>={};
  for(const [index,phase] of phases.entries()){
    const field=phase==='stimulus_ms'?'image_ms':phase,spec=group.timing_defaults?.[phase];
    const pool=requested.filter(t=>t.timing?.[phase]===undefined);
    if(spec){
      const values=balancedDurations(spec,pool.length,seed,index);pools[phase]=pool.map(t=>t.root_id);
      pool.forEach((t,i)=>{t[field]=values[i]!;});
    }
    for(let i=0;i<requested.length;i++){
      const t=requested[i]!,override=t.timing?.[phase];
      if(override)t[field]=override.base+(override.jitter?random(seed,100+index*100+i)(1000001)/1000000*2*override.jitter-override.jitter:0);
    }
  }
  const ordered=orderTrials(requested,group.ordering,seed);
  const realized=ordered.map(t=>{const {timing:_,timing_general:__,...rest}=t;return {...rest,image_ms:Math.ceil(t.image_ms/frame)*frame,isi_ms:Math.ceil(t.isi_ms/frame)*frame,
    ...(t.feedback_ms!==undefined?{feedback_ms:Math.ceil(t.feedback_ms/frame)*frame}:{})};});
  const enhanced=!!(group.timing_defaults||group.ordering||roots.some(t=>t.timing||t.text!==undefined||t.feedback_ms!==undefined));
  return {roots:realized,...(enhanced?{design:{algorithm:'trial-design-v1',requested:ordered,balanced_pools:pools,quantization:'ceil-frame',repeats:'reuse-root-excluded-from-balance'} as DesignAudit}:{})};
}

```

### src/shared/trial-sampling.ts L1–L32

```
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

```