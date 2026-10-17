import type {PreparationReport} from '../shared/preparation-report.js';
import type {ParticipantAPI} from './participant-api.js';
import {networkState} from './browser-state.js';
export function preparationAttempt(api:ParticipantAPI,phase:PreparationReport['phase'],group_id:string|null=null,start=performance.now()){
  const started_at=new Date(Date.now()-(performance.now()-start)).toISOString(),attempt_id=crypto.randomUUID();
  const stages:Record<string,number>={};let prior=start,finished=false;
  const n=navigator as Navigator&{deviceMemory?:number};
  const device={user_agent:n.userAgent,platform:n.platform,language:n.language,cores:n.hardwareConcurrency??null,memory_gb:n.deviceMemory??null,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,network:networkState()};
  return {group:(id:string)=>{group_id=id;},stage:(name:string)=>{const now=performance.now();stages[name]=now-prior;prior=now;},
    finish:async(outcome:PreparationReport['outcome'],extra:Pick<Partial<PreparationReport>,'storage'|'refresh'|'error'>={})=>{
      if(finished)return;finished=true;
      const report:PreparationReport={schema:'preparation-v1',attempt_id,phase,group_id,started_at,elapsed_ms:performance.now()-start,configured_commit_ms:api.session.frozen.protocol.budget.commit_ms,stages,device,outcome,...extra};
      await api.ledger.preparation(report);
      // Upload retries happen before a run or at final sync; timing never waits for telemetry ACKs.
      void api.syncPreparations().catch(()=>{});
    }};
}
