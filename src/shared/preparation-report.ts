import {ContractError,id,object} from './contract.js';
export interface PreparationReport {
  schema:'preparation-v1';attempt_id:string;phase:'runner-loading'|'group-readiness';
  outcome:'READY'|'FAILED'|'CANCELED'|'STORAGE_REJECTED';group_id:string|null;
  started_at:string;elapsed_ms:number;configured_commit_ms:number;stages:Record<string,number>;
  device:{user_agent:string;platform:string;language:string;cores:number|null;memory_gb:number|null;width:number;height:number;dpr:number;network:unknown};
  storage?:{commit_ms:number;samples:number[];path:string;audit_bytes:number};
  refresh?:{frame_ms:number};error?:string;
}
export function parsePreparationReport(value:unknown):PreparationReport {
  const r=object(value),finite=(n:unknown,max=86400000)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max;
  if(r.schema!=='preparation-v1'||!['runner-loading','group-readiness'].includes(String(r.phase))||!['READY','FAILED','CANCELED','STORAGE_REJECTED'].includes(String(r.outcome))
    ||typeof r.started_at!=='string'||!Number.isFinite(Date.parse(r.started_at))||!finite(r.elapsed_ms)||!finite(r.configured_commit_ms,1000)||Number(r.configured_commit_ms)<1)throw new ContractError('INVALID_PREPARATION_REPORT');
  id(r.attempt_id);if(r.group_id!==null)id(r.group_id);
  const stages=object(r.stages),device=object(r.device);
  if(Object.keys(stages).length>16||Object.entries(stages).some(([key,n])=>! /^[a-z_]{1,40}$/.test(key)||!finite(n))
    ||['user_agent','platform','language'].some(key=>typeof device[key]!=='string'||String(device[key]).length>1024)
    ||['width','height','dpr'].some(key=>!finite(device[key],100000)||Number(device[key])<=0)
    ||['cores','memory_gb'].some(key=>device[key]!==null&&!finite(device[key],100000))
    ||r.error!==undefined&&(typeof r.error!=='string'||r.error.length>500))throw new ContractError('INVALID_PREPARATION_REPORT');
  if(r.storage!==undefined){const s=object(r.storage);
    if(!finite(s.commit_ms)||!Array.isArray(s.samples)||s.samples.length!==10||s.samples.some(n=>!finite(n))||Math.abs(Math.max(...s.samples as number[])-Number(s.commit_ms))>.001
      ||typeof s.path!=='string'||s.path.length>100||!finite(s.audit_bytes,1024*1024))throw new ContractError('INVALID_PREPARATION_REPORT');
  }
  if(r.refresh!==undefined&&!finite(object(r.refresh).frame_ms,1000))throw new ContractError('INVALID_PREPARATION_REPORT');
  return r as unknown as PreparationReport;
}
