import {request} from './dom.js';
import {Ledger} from './ledger.js';
import type {LabSession} from '../shared/lab-contract.js';
import type {Receipt,Seal} from '../shared/contract.js';
import {awaitSessionAdmission} from './session-gate.js';
import {requireOrientation} from './orientation-gate.js';
import {sha256} from './local-store.js';
export class ParticipantAPI {
  admission:Awaited<ReturnType<typeof awaitSessionAdmission>>|null=null;
  constructor(readonly ledger:Ledger,public session:LabSession){}
  path(op=''){return `/api/participate/sessions/${this.session.session_id}${op?`/${op}`:''}`;}
  fence(){return {writer_id:this.ledger.writer,writer_epoch:this.session.writer_epoch};}
  async enter(signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){await this.stopAdmission();this.admission=await awaitSessionAdmission(this,signal,status,onLost);}
  async stopAdmission(){const current=this.admission;this.admission=null;await current?.stop();}
  async refresh(){this.session=await request<LabSession>(this.path());await this.ledger.session(this.session);return this.session;}
  async claim(){this.session=await request<LabSession>(this.path('claim'),{request_id:crypto.randomUUID(),writer_id:this.ledger.writer});await this.ledger.session(this.session);}
  async syncEnvironment(){const environment=(await this.ledger.state()).environment;if(environment&&!environment.received){const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:environment.request_id,sample_id:environment.sample_id,raw:environment.raw});if(result.status!=='PERSISTED'||result.hash!==await sha256(environment.raw))throw new Error('环境记录接管凭证不匹配。');await this.ledger.environment();}}
  async sync(){await this.ledger.drain();await this.syncEnvironment();for(;;){const events=await this.ledger.batch();if(!events.length)break;const result=await request<{receipts:Receipt[]}>(this.path('ingest'),{batch_id:crypto.randomUUID(),events:events.map(({event_id,hash,raw})=>({event_id,hash,raw}))});
    if(result.receipts.length!==events.length||events.some(e=>!result.receipts.some(r=>r.event_id===e.event_id&&r.hash===e.hash)))throw new Error('接管凭证不匹配。');await this.ledger.acknowledge(result.receipts);}
  }
  async seal(scope:string){await this.sync();const state=await this.ledger.state(),pending=state.pending[scope]!;
    const seal=pending.seal??await request<Seal>(this.path('seal'),{request_id:pending.request_id,...this.fence(),manifest:pending.manifest});
    if(seal.status!=='SEALED')throw new Error('数据仍有未核对位置，不能继续。');await this.ledger.seal(scope,seal);await this.refresh();return seal;
  }
  async complete(){await this.sync();await this.refresh();const m=await this.ledger.state();const result=await request<{status:string}>(this.path('finalize'),{request_id:m.finalize_id,...this.fence(),seal_ids:this.session.seals.map(s=>s.seal_id)});if(result.status!=='COMPLETED')throw new Error('会话仍有未确认的位置。');await this.refresh();}
  async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
  async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){const report=await request<{status:string;cleanup_allowed:boolean}>(this.path('reconcile'),await this.ledger.reconciliation(scope,this.session.path));if(report.status!=='RECONCILED'||report.cleanup_allowed!==false)throw new Error('RECONCILIATION_MISMATCH');}}
  async reanswer(){await this.reconcile();const data=await this.ledger.reanswerRequest();const result=await request<LabSession>(this.path('reanswer'),data);await this.ledger.restart(result,data.credential);return result;}
  static async open(version:string,writer:string){await requireOrientation(version);const ledger=await Ledger.open(version,writer),m=await ledger.state();
    const {requireConsent}=await import('./consent-gate.js'),consent=await requireConsent(ledger);
    if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
    await requireOrientation(version);const initial=m.session?await request<LabSession>(`/api/participate/sessions/${m.session.session_id}/resume`,{credential:m.credential}):await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential,...(consent?{consent}:{})});const api=new ParticipantAPI(ledger,initial);await api.refresh();await api.syncEnvironment();return api;}
}
