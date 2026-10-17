import type Database from 'better-sqlite3';
import type {Protocol} from '../shared/protocol.js';
import {parsePreparationReport} from '../shared/preparation-report.js';
export const PREPARATION_LAYOUT='device-preparation-v1';
export const preparationColumns=['snapshot_id','study_id','session_id','version_id','protocol_hash','runner_hash','session_state','record_source','record_id','attempt_id','group_id','phase','outcome','configured_commit_ms','measured_commit_ms','storage_result','sample_count','samples_json','probe_path','audit_bytes','frame_ms','elapsed_ms','stages_json','started_at','received_at','user_agent','platform','language','cores','memory_gb','viewport_width','viewport_height','dpr','network_json','error'] as const;
export function* preparationRows(db:Database.Database,session:{session_id:string;version_id:string;state:string},protocol:Protocol){
  const version=db.prepare('SELECT hash,runner_hash FROM lab_versions WHERE version_id=?').get(session.version_id) as {hash:string;runner_hash:string};
  const common={session_id:session.session_id,version_id:session.version_id,protocol_hash:version.hash,runner_hash:version.runner_hash,session_state:session.state,configured_commit_ms:protocol.budget.commit_ms};
  let device:Record<string,unknown>={},count=0;
  const covariates=db.prepare('SELECT sample_id,source,raw,received_at FROM lab_covariates WHERE session_id=? ORDER BY rowid').all(session.session_id) as {sample_id:string;source:string;raw:string;received_at:number}[];
  for(const row of covariates){const e=JSON.parse(row.raw);if(e.schema==='environment-v1')device={user_agent:e.user_agent??null,platform:e.platform??null,language:e.language??null,cores:e.hardware?.logical_processors??null,memory_gb:e.hardware?.device_memory_gb??null,viewport_width:e.viewport?.width??null,viewport_height:e.viewport?.height??null,dpr:e.viewport?.dpr??null,network_json:JSON.stringify(e.network??null)};else if(row.source==='server-observed'&&!device.user_agent)device={user_agent:e.user_agent};}
  const measurement=(s:{commit_ms?:number;samples?:number[];path?:string;audit_bytes?:number})=>({measured_commit_ms:s.commit_ms??null,storage_result:typeof s.commit_ms==='number'?(s.commit_ms<=protocol.budget.commit_ms?'PASSED':'REJECTED'):'NOT_MEASURED',sample_count:s.samples?.length??0,samples_json:s.samples?JSON.stringify(s.samples):null,probe_path:s.path??null,audit_bytes:s.audit_bytes??null});
  for(const row of covariates)if(row.source==='preparation-reported'){
    const r=parsePreparationReport(JSON.parse(row.raw));count++;
    yield {...common,...device,...measurement(r.storage??{}),record_source:'client-preparation',record_id:row.sample_id,attempt_id:r.attempt_id,group_id:r.group_id,phase:r.phase,outcome:r.outcome,frame_ms:r.refresh?.frame_ms??null,elapsed_ms:r.elapsed_ms,stages_json:JSON.stringify(r.stages),started_at:r.started_at,received_at:row.received_at,user_agent:r.device.user_agent,platform:r.device.platform,language:r.device.language,cores:r.device.cores,memory_gb:r.device.memory_gb,dpr:r.device.dpr,viewport_width:r.device.width,viewport_height:r.device.height,network_json:JSON.stringify(r.device.network),error:r.error??null};
  }
  for(const row of db.prepare('SELECT permit_id,group_id,readiness FROM lab_permits WHERE session_id=? ORDER BY rowid').iterate(session.session_id) as Iterable<{permit_id:string;group_id:string;readiness:string}>){
    const r=JSON.parse(row.readiness);count++;
    yield {...common,...device,...measurement(r),record_source:'permit-readiness',record_id:row.permit_id,group_id:row.group_id,phase:'permit',outcome:'PERMIT_ISSUED',frame_ms:r.frame_ms??null,elapsed_ms:null,stages_json:r.download?JSON.stringify({download:r.download.elapsed_ms}):null};
  }
  if(!count)yield {...common,...device,...measurement({}),record_source:'configuration-only',phase:'configuration',outcome:protocol.groups.length?'NOT_RECORDED':'NOT_APPLICABLE'};
}
