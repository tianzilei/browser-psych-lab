import {request} from './dom.js';
import {Ledger} from './ledger.js';
import type {LabSession} from '../shared/lab-contract.js';
import {manifestText,type Manifest,type Receipt,type Seal} from '../shared/contract.js';
import {awaitSessionAdmission} from './session-gate.js';
import {requireOrientation} from './orientation-gate.js';
import {sha256} from './local-store.js';
export class ParticipantAPI {
  private preparationSync:Promise<void>|undefined;
  admission:Awaited<ReturnType<typeof awaitSessionAdmission>>|null=null;
  constructor(readonly ledger:Ledger,public session:LabSession){}
  path(op=''){return `/api/participate/sessions/${this.session.session_id}${op?`/${op}`:''}`;}
  fence(){return {writer_id:this.ledger.writer,writer_epoch:this.session.writer_epoch};}
  async enter(signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){await this.stopAdmission();this.admission=await awaitSessionAdmission(this,signal,status,onLost);}
  async stopAdmission(){const current=this.admission;this.admission=null;await current?.stop();}
  async refresh(){this.session=await request<LabSession>(this.path());await this.ledger.session(this.session);return this.session;}
  async claim(){this.session=await request<LabSession>(this.path('claim'),{request_id:crypto.randomUUID(),writer_id:this.ledger.writer});await this.ledger.session(this.session);}
  async syncEnvironment(){const environment=(await this.ledger.state()).environment;if(environment&&!environment.received){const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:environment.request_id,sample_id:environment.sample_id,raw:environment.raw});if(result.status!=='PERSISTED'||result.hash!==(environment.hash??await sha256(environment.raw)))throw new Error('ENVIRONMENT_RECEIPT_MISMATCH');await this.ledger.environment();}}
  syncPreparations(){return this.preparationSync??=this.sendPreparations().finally(()=>{this.preparationSync=undefined;});}
  private async sendPreparations(){for(const sample of Object.values((await this.ledger.state()).preparations??{}))if(!sample.received){
    const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:sample.request_id,sample_id:sample.sample_id,raw:sample.raw});
    if(result.status!=='PERSISTED'||result.hash!==sample.hash)throw new Error('PREPARATION_RECEIPT_MISMATCH');await this.ledger.preparationReceived(sample.sample_id);
  }}
  async sync(scope?:string){await this.ledger.drain();await this.syncEnvironment();await this.syncPreparations().catch(()=>{});for(;;){const events=await this.ledger.batch(scope);if(!events.length)break;const result=await request<{receipts:Receipt[]}>(this.path('ingest'),{batch_id:crypto.randomUUID(),events:events.map(({event_id,hash,raw})=>({event_id,hash,raw}))});
    if(result.receipts.length!==events.length||events.some(e=>!result.receipts.some(r=>r.event_id===e.event_id&&r.hash===e.hash)))throw new Error('CUSTODY_RECEIPT_MISMATCH');await this.ledger.acknowledge(result.receipts);}
  }
  async seal(scope:string){
    const local=await this.ledger.state();
    if(!local.pending[scope]?.seal&&this.session.permit?.scope===scope&&this.session.permit.state==='ISSUED'){
      let admitted=false;try{this.admission?.check();admitted=!!this.admission;}catch{}
      // Keep the connection alive while saving; user-idle supervision has ended.
      if(!admitted)await this.enter(new AbortController().signal,()=>{},()=>{});
    }
    await this.sync(scope);const state=await this.ledger.state(),pending=state.pending[scope]!;
    const seal=pending.seal??await request<Seal>(this.path('seal'),{request_id:pending.request_id,...this.fence(),manifest:pending.manifest});
    if(seal.status!=='SEALED')throw new Error('SAVE_NOT_CONFIRMED');await this.ledger.seal(scope,seal);await this.refresh();return seal;
  }
  async complete(){await this.sync();await this.refresh();const m=await this.ledger.state();const result=await request<{status:string}>(this.path('finalize'),{request_id:m.finalize_id,...this.fence(),seal_ids:this.session.seals.map(s=>s.seal_id)});if(result.status!=='COMPLETED')throw new Error('COMPLETION_NOT_CONFIRMED');await this.refresh();}
  async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
  async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){
    const data=await this.ledger.reconciliation(scope,this.session.path);
    for(let attempt=0;;attempt++){
      const report=await request<{status:string;cleanup_allowed:boolean;manifest:Manifest;receipts:(Receipt|null)[]}>(this.path('reconcile'),data);
      if(!['WAITING','RECONCILED'].includes(report.status)||report.cleanup_allowed!==false||!report.manifest
        ||manifestText(report.manifest)!==manifestText(data.manifest)||!Array.isArray(report.receipts)||report.receipts.length!==data.manifest.events.length)throw new Error('RECONCILIATION_MISMATCH');
      const missing=data.manifest.events.filter((ref,index)=>{
        const receipt=report.receipts[index];if(receipt===null)return true;
        if(!receipt||receipt.event_id!==ref.event_id||receipt.hash!==ref.hash||receipt.scope!==scope||receipt.custody!=='PERSISTED'
          ||typeof receipt.receipt_id!=='string'||!receipt.receipt_id||!['ACCEPTED','RECEIVED_PENDING','QUARANTINED'].includes(receipt.disposition)
          ||!Number.isSafeInteger(receipt.disposition_version)||receipt.disposition_version<1)throw new Error('RECONCILIATION_MISMATCH');
        return false;
      });
      // Existing local ACKs and raw stay intact. Only missing custody needs a
      // retransmission; sync() acknowledges the resulting fresh receipts.
      if(!missing.length){if(report.status!=='RECONCILED')throw new Error('RECONCILIATION_MISMATCH');break;}
      if(attempt>=1)throw new Error('RECONCILIATION_MISMATCH');
      await this.ledger.requeue(scope,missing);await this.sync(scope);
    }
  }}
  async reanswer(){await this.reconcile();const data=await this.ledger.reanswerRequest();const result=await request<LabSession>(this.path('reanswer'),data);await this.ledger.restart(result,data.credential);return result;}
  static async open(version:string,writer:string){const ledger=await Ledger.open(version,writer,true);
    const effectiveVersion=(await ledger.db.get('meta',version))?.session?.frozen.version_id??version;
    await requireOrientation(effectiveVersion);const m=await ledger.state();
    sessionStorage.setItem(`lab-writer-${version}`,ledger.writer);
    const {requireConsent}=await import('./consent-gate.js'),consent=await requireConsent(ledger,effectiveVersion);
    if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
    await requireOrientation(effectiveVersion);const initial=m.session?await request<LabSession>(`/api/participate/sessions/${m.session.session_id}/resume`,{credential:m.credential}):await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential,...(consent?{consent}:{})});const api=new ParticipantAPI(ledger,initial);await api.refresh();await api.syncEnvironment();void api.syncPreparations().catch(()=>{});return api;}
}
