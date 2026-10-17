import {openDB,type DBSchema,type IDBPDatabase} from 'idb';
import {LAB_SCHEMA, type Answer} from '../shared/protocol.js';
import {type LabEvent,type LabSession} from '../shared/lab-contract.js';
import {type WireEvent,type EventRef,type Manifest,type Receipt,type Seal,manifestText} from '../shared/contract.js';
import {sha256} from './local-store.js';
import type {ConsentReceipt} from './consent-gate.js';
import type {PreparationReport} from '../shared/preparation-report.js';
import {QuestionnaireEditLimitError,requireQuestionnaireEditCapacity,type ScopeUsage} from '../shared/questionnaire-capacity.js';
interface EventRow extends WireEvent {session_id:string;scope:string;sequence:number;receipt:Receipt|null;byte_length?:number}
const encoder=new TextEncoder();
export interface PendingSeal {request_id:string;manifest:Manifest;seal:Seal|null}
export interface SessionMeta {version_id:string;request_id:string;credential:string;session:LabSession|null;writer_id?:string;
  heads:Record<string,{sequence:number;previous:EventRef|null}>;pending:Record<string,PendingSeal>;finalize_id:string;page_values:Record<string,Record<string,Answer>>;
  survey_cursor?:{scope:string;question_id:string;history?:string[]};
  scope_usage?:Record<string,ScopeUsage>;
  preparations?:Record<string,{request_id:string;sample_id:string;raw:string;hash:string;received:boolean}>;
  reanswer?:{request_id:string;credential:string;entry_version?:string};reconciliations?:Record<string,{request_id:string;manifest:Manifest;unknown:string[]}>;termination?:{request_id:string;reason:string;evidence:unknown};consent?:ConsentReceipt;environment?:{request_id:string;sample_id:string;raw:string;hash?:string;received:boolean}}
interface LedgerSchema extends DBSchema {events:{key:string;value:EventRow;indexes:{session:string;scope:string}};
 outbox:{key:string;value:EventRow;indexes:{session:string}};meta:{key:string;value:SessionMeta}}
export class Ledger {
  private chain:Promise<unknown>=Promise.resolve();
  private queued=0;
  private failure:unknown=null;
  private diagnosticCount=0;
  private diagnosticScope=0;
  private diagnosticBytes=0;
  constructor(readonly db:IDBPDatabase<LedgerSchema>,readonly version:string,readonly writer:string,readonly clock=crypto.randomUUID()){}
  static async open(version:string,writer:string,resumeWriter=false){
    const db=await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}});
    // Only resume an identity after acquiring this version's native Web Lock.
    // A new tab must not advance the epoch of still-pending original events.
    const prior=resumeWriter?await db.get('meta',version):undefined;
    return new Ledger(db,version,prior?.writer_id??prior?.session?.writer_id??writer);
  }
  async state(){
    let m=await this.db.get('meta',this.version);
    if(!m){
      m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,writer_id:this.writer,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};
      await this.db.add('meta',m,this.version);
    }else if(!m.writer_id){
      const tx=this.db.transaction('meta','readwrite',{durability:'strict'});
      m=(await tx.store.get(this.version))!;m.writer_id??=this.writer;
      await tx.store.put(m,this.version);await tx.done;
    }
    return m;
  }
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=64){this.failure=new Error('LOCAL_QUEUE_BUDGET_EXCEEDED');return Promise.reject(this.failure);}this.queued++;const next=this.chain.then(fn).finally(()=>{this.queued--;});this.chain=next.catch(error=>{if(!(error instanceof QuestionnaireEditLimitError))this.failure=error;});return next;}
  private async usage(m:SessionMeta,scope:string):Promise<ScopeUsage>{
    const events=m.heads[scope]?.sequence??0,known=m.scope_usage?.[scope];
    if(known?.events===events)return known;
    if(!events)return {events:0,bytes:0};
    const rows=(await this.db.getAllFromIndex('events','scope',scope)).filter(row=>row.session_id===m.session!.session_id);
    return {events,bytes:rows.reduce((n,row)=>n+(row.byte_length??encoder.encode(row.raw).length),0)};
  }
  scopeUsage(scope:string){return this.serialized(async()=>this.usage(await this.state(),scope));}
  session(session:LabSession){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.session=session;await tx.store.put(m,this.version);await tx.done;});}
  consent(receipt:ConsentReceipt){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.consent=receipt;await tx.store.put(m,this.version);await tx.done;});}
  surveyCursor(scope:string,question_id:string,history:string[]=[]){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.survey_cursor={scope,question_id,history};await tx.store.put(m,this.version);await tx.done;});}
  environment(raw?:string){return this.serialized(async()=>{const hash=raw===undefined?undefined:await sha256(raw);const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;if(raw!==undefined)m.environment??={request_id:crypto.randomUUID(),sample_id:crypto.randomUUID(),raw,hash:hash!,received:false};else if(m.environment)m.environment.received=true;await tx.store.put(m,this.version);await tx.done;});}
  preparation(report:PreparationReport){return this.serialized(async()=>{
    const raw=JSON.stringify(report),hash=await sha256(raw),tx=this.db.transaction('meta','readwrite',{durability:'strict'}),m=(await tx.store.get(this.version))!;
    // Preparation telemetry is bounded independently from answer durability.
    // Reaching this limit retains the existing reports and stops new sampling.
    m.preparations??={};if(Object.keys(m.preparations).length>=100){await tx.done;return false;}
    m.preparations[report.attempt_id]={request_id:crypto.randomUUID(),sample_id:report.attempt_id,raw,hash,received:false};await tx.store.put(m,this.version);await tx.done;return true;
  });}
  preparationReceived(sample:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'}),m=(await tx.store.get(this.version))!;
    if(m.preparations?.[sample])m.preparations[sample]!.received=true;await tx.store.put(m,this.version);await tx.done;});}
  reanswerRequest(){return this.serialized(async()=>{const m=await this.state();m.reanswer??={request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),entry_version:this.version};await this.db.put('meta',m,this.version);return m.reanswer;});}
  // Keep the entry/lock key stable; session.frozen.version_id owns the protocol.
  restart(session:LabSession,credential:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;await tx.store.put(m,`archive:${m.session!.session_id}`);await tx.store.put({version_id:this.version,request_id:crypto.randomUUID(),credential,session,writer_id:this.writer,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{},...(m.consent?{consent:m.consent}:{})},this.version);await tx.done;});}
  append(scope:string,kind:LabEvent['kind'],payload:Record<string,unknown>,pendingPath?:string[],pageValues?:Record<string,Answer>){
    return this.serialized(()=>this.appendEvent(scope,kind,payload,pendingPath,pageValues));
  }
  private async appendEvent(scope:string,kind:LabEvent['kind'],payload:Record<string,unknown>,pendingPath?:string[],pageValues?:Record<string,Answer>,diagnostic=false){
    const m=await this.state(),s=m.session;if(!s)throw new Error('NO_LOCAL_SESSION');if(m.pending[scope]&&kind!=='INPUT_DIAGNOSTIC')throw new Error('SCOPE_ALREADY_PENDING');
    let head=m.heads[scope]??{sequence:0,previous:null};const e:LabEvent={event_schema_version:LAB_SCHEMA,event_id:crypto.randomUUID(),session_id:s.session_id,version_id:s.frozen.version_id,protocol_hash:s.frozen.hash,
      writer_id:this.writer,writer_epoch:s.writer_epoch,scope,sequence:head.sequence,previous:head.previous,clock_epoch:this.clock,time_ms:performance.now(),kind,payload};
    let raw=JSON.stringify(e),bytes=encoder.encode(raw),nextDiagnosticScope:number|undefined;
    if(bytes.length>128*1024)throw new Error('EVENT_BUDGET_EXCEEDED');
    // Count the complete UTF-8 envelope, including escaped payload and chain
    // metadata. Rotation and append share the same serialized write barrier.
    if(diagnostic&&this.diagnosticCount>0&&(this.diagnosticCount>=256||this.diagnosticBytes+bytes.length>8*1024*1024)){
      nextDiagnosticScope=this.diagnosticScope+1;scope=`d-ui-${this.clock}-${nextDiagnosticScope}`;
      head=m.heads[scope]??{sequence:0,previous:null};e.scope=scope;e.sequence=head.sequence;e.previous=head.previous;
      raw=JSON.stringify(e);bytes=encoder.encode(raw);
      if(bytes.length>128*1024)throw new Error('EVENT_BUDGET_EXCEEDED');
    }
    if(head.sequence>=5000)throw new Error('LOCAL_SCOPE_EVENT_BUDGET_EXCEEDED');
    const questionnaire=s.frozen.protocol.questionnaire_layout==='adaptive'&&(kind==='PAGE_REVISION'||kind==='PAGE_SNAPSHOT');
    const usage=questionnaire?await this.usage(m,scope):undefined;
    if(kind==='PAGE_REVISION'&&usage)requireQuestionnaireEditCapacity(usage,bytes.length);
    const hash=await sha256(bytes),row:EventRow={event_id:e.event_id,hash,raw,session_id:s.session_id,scope,sequence:e.sequence,receipt:null,byte_length:bytes.length};
    const tx=this.db.transaction(['events','outbox','meta'],'readwrite',{durability:'strict'});
    try{const current=(await tx.objectStore('meta').get(this.version))!;const actual=current.heads[scope]??{sequence:0,previous:null};if(actual.sequence!==head.sequence)throw new Error('LOCAL_WRITER_FORK');
      await tx.objectStore('events').add(row);await tx.objectStore('outbox').add(row);current.heads[scope]={sequence:e.sequence+1,previous:{event_id:e.event_id,hash}};
      if(usage){current.scope_usage??={};current.scope_usage[scope]={events:usage.events+1,bytes:usage.bytes+bytes.length};}
      if(pageValues)current.page_values[scope]=pageValues;
      if(pendingPath){const old=await tx.objectStore('events').index('scope').getAll(scope);current.pending[scope]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path:pendingPath,events:old.filter(v=>v.session_id===s.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};}
      await tx.objectStore('meta').put(current,this.version);await tx.done;
      if(nextDiagnosticScope!==undefined){this.diagnosticScope=nextDiagnosticScope;this.diagnosticCount=0;this.diagnosticBytes=0;}
      return row;
    }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  }
  closeScope(scope:string,path:string[]){return this.serialized(async()=>{
    const m=await this.state();if(m.pending[scope])return m.pending[scope]!;const rows=await this.db.getAllFromIndex('events','scope',scope);const pending:PendingSeal={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path,events:rows.filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const current=(await tx.store.get(this.version))!;current.pending[scope]=pending;await tx.store.put(current,this.version);await tx.done;return pending;
  });}
  async batch(scope?:string){const m=await this.state();const tx=this.db.transaction('outbox');let cursor=await tx.store.index('session').openCursor(m.session!.session_id);const batch:EventRow[]=[];let size=0;
    while(cursor&&batch.length<16){const row=cursor.value;
      // Never upload a future questionnaire scope before its predecessor seals.
      if(scope!==undefined&&row.scope!==scope&&!row.scope.startsWith('d-ui-')){cursor=await cursor.continue();continue;}
      const bytes=row.byte_length??encoder.encode(row.raw).length;if(size+bytes>256*1024&&batch.length)break;batch.push(row);size+=bytes;cursor=await cursor.continue();}await tx.done;return batch;}
  acknowledge(receipts:Receipt[]){return this.serialized(async()=>{const tx=this.db.transaction(['events','outbox'],'readwrite',{durability:'strict'});try{for(const r of receipts){const e=await tx.objectStore('events').get(r.event_id);if(!e||e.hash!==r.hash||e.scope!==r.scope||r.custody!=='PERSISTED'||!r.receipt_id||!['ACCEPTED','RECEIVED_PENDING','QUARANTINED'].includes(r.disposition))throw new Error('CUSTODY_MISMATCH');e.receipt=r;await tx.objectStore('events').put(e);await tx.objectStore('outbox').delete(e.event_id);}await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}});}
  requeue(scope:string,refs:EventRef[]){return this.serialized(async()=>{
    const m=await this.state(),tx=this.db.transaction(['events','outbox'],'readwrite',{durability:'strict'});
    try{for(const ref of refs){const row=await tx.objectStore('events').get(ref.event_id);
      if(!row||row.session_id!==m.session!.session_id||row.scope!==scope||row.hash!==ref.hash)throw new Error('LOCAL_EVIDENCE_MISSING');
      await tx.objectStore('outbox').put(row);
    }await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  });}
  seal(scope:string,seal:Seal){return this.serialized(async()=>{const m=await this.state();const p=m.pending[scope];if(!p||seal.status!=='SEALED'||seal.algorithm!=='exact-set-and-chain-v1'||manifestText(seal.manifest)!==manifestText(p.manifest)||seal.manifest_hash!==await sha256(manifestText(p.manifest)))throw new Error('SEAL_MISMATCH');
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const latest=(await tx.store.get(this.version))!;latest.pending[scope]!.seal=seal;await tx.store.put(latest,this.version);await tx.done;});}
  async drain(){await this.chain;if(this.failure)throw this.failure;}
  interaction(batch:import('../shared/interaction.js').InteractionBatch){return this.serialized(async()=>{
    const row=await this.appendEvent(`d-ui-${this.clock}-${this.diagnosticScope}`,'INPUT_DIAGNOSTIC',{interaction:batch},undefined,undefined,true);
    this.diagnosticCount++;this.diagnosticBytes+=row.byte_length!;return row;
  });}
  termination(reason:string,evidence:unknown){return this.serialized(async()=>{const m=await this.state();m.termination??={request_id:crypto.randomUUID(),reason,evidence};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;return m.termination;});}
  reconciliation(scope:string,path:string[]){return this.serialized(async()=>{const m=await this.state(),head=m.heads[scope]!,key=`${scope}-${head.sequence}`;m.reconciliations??={};
    if(!m.reconciliations[key]){const events=(await this.db.getAllFromIndex('events','scope',scope)).filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence);m.reconciliations[key]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,events:events.map(({event_id,hash})=>({event_id,hash})),path},unknown:m.pending[scope]?.seal?[]:['unfinished-or-unknown-position']};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;}return m.reconciliations[key]!;});}
}
