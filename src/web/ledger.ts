import {openDB,type DBSchema,type IDBPDatabase} from 'idb';
import {LAB_SCHEMA, type Answer} from '../shared/protocol.js';
import {type LabEvent,type LabSession} from '../shared/lab-contract.js';
import {type WireEvent,type EventRef,type Manifest,type Receipt,type Seal,manifestText} from '../shared/contract.js';
import {sha256} from './local-store.js';
import type {ConsentReceipt} from './consent-gate.js';
interface EventRow extends WireEvent {session_id:string;scope:string;sequence:number;receipt:Receipt|null}
export interface PendingSeal {request_id:string;manifest:Manifest;seal:Seal|null}
export interface SessionMeta {version_id:string;request_id:string;credential:string;session:LabSession|null;
  heads:Record<string,{sequence:number;previous:EventRef|null}>;pending:Record<string,PendingSeal>;finalize_id:string;page_values:Record<string,Record<string,Answer>>;
  reconciliations?:Record<string,{request_id:string;manifest:Manifest;unknown:string[]}>;termination?:{request_id:string;reason:string;evidence:unknown};consent?:ConsentReceipt;environment?:{request_id:string;sample_id:string;raw:string;received:boolean}}
interface LedgerSchema extends DBSchema {events:{key:string;value:EventRow;indexes:{session:string;scope:string}};
 outbox:{key:string;value:EventRow;indexes:{session:string}};meta:{key:string;value:SessionMeta}}
export class Ledger {
  private chain:Promise<unknown>=Promise.resolve();
  private queued=0;
  private failure:unknown=null;
  constructor(readonly db:IDBPDatabase<LedgerSchema>,readonly version:string,readonly writer:string,readonly clock=crypto.randomUUID()){}
  static async open(version:string,writer:string){return new Ledger(await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}}),version,writer);}
  async state(){let m=await this.db.get('meta',this.version);if(!m){m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};await this.db.add('meta',m,this.version);}return m;}
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=64){this.failure=new Error('LOCAL_QUEUE_BUDGET_EXCEEDED');return Promise.reject(this.failure);}this.queued++;const next=this.chain.then(fn).finally(()=>{this.queued--;});this.chain=next.catch(error=>{this.failure=error;});return next;}
  session(session:LabSession){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.session=session;await tx.store.put(m,this.version);await tx.done;});}
  consent(receipt:ConsentReceipt){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.consent=receipt;await tx.store.put(m,this.version);await tx.done;});}
  environment(raw?:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;if(raw!==undefined)m.environment??={request_id:crypto.randomUUID(),sample_id:crypto.randomUUID(),raw,received:false};else if(m.environment)m.environment.received=true;await tx.store.put(m,this.version);await tx.done;});}
  append(scope:string,kind:LabEvent['kind'],payload:Record<string,unknown>,pendingPath?:string[],pageValues?:Record<string,Answer>){return this.serialized(async()=>{
    const m=await this.state(),s=m.session;if(!s)throw new Error('NO_LOCAL_SESSION');if(m.pending[scope]&&kind!=='INPUT_DIAGNOSTIC')throw new Error('SCOPE_ALREADY_PENDING');
    const head=m.heads[scope]??{sequence:0,previous:null};if(head.sequence>=5000)throw new Error('LOCAL_SCOPE_EVENT_BUDGET_EXCEEDED');const e:LabEvent={event_schema_version:LAB_SCHEMA,event_id:crypto.randomUUID(),session_id:s.session_id,version_id:s.frozen.version_id,protocol_hash:s.frozen.hash,
      writer_id:this.writer,writer_epoch:s.writer_epoch,scope,sequence:head.sequence,previous:head.previous,clock_epoch:this.clock,time_ms:performance.now(),kind,payload};
    const raw=JSON.stringify(e);if(new TextEncoder().encode(raw).length>128*1024)throw new Error('EVENT_BUDGET_EXCEEDED');
    const hash=await sha256(raw),row:EventRow={event_id:e.event_id,hash,raw,session_id:s.session_id,scope,sequence:e.sequence,receipt:null};
    const tx=this.db.transaction(['events','outbox','meta'],'readwrite',{durability:'strict'});
    try{const current=(await tx.objectStore('meta').get(this.version))!;const actual=current.heads[scope]??{sequence:0,previous:null};if(actual.sequence!==head.sequence)throw new Error('LOCAL_WRITER_FORK');
      await tx.objectStore('events').add(row);await tx.objectStore('outbox').add(row);current.heads[scope]={sequence:e.sequence+1,previous:{event_id:e.event_id,hash}};
      if(pageValues)current.page_values[scope]=pageValues;
      if(pendingPath){const old=await tx.objectStore('events').index('scope').getAll(scope);current.pending[scope]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path:pendingPath,events:old.filter(v=>v.session_id===s.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};}
      await tx.objectStore('meta').put(current,this.version);await tx.done;return row;
    }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
  });}
  closeScope(scope:string,path:string[]){return this.serialized(async()=>{
    const m=await this.state();if(m.pending[scope])return m.pending[scope]!;const rows=await this.db.getAllFromIndex('events','scope',scope);const pending:PendingSeal={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,path,events:rows.filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence).map(({event_id,hash})=>({event_id,hash}))},seal:null};
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const current=(await tx.store.get(this.version))!;current.pending[scope]=pending;await tx.store.put(current,this.version);await tx.done;return pending;
  });}
  async batch(){const m=await this.state();const tx=this.db.transaction('outbox');let cursor=await tx.store.index('session').openCursor(m.session!.session_id);const batch:EventRow[]=[];let size=0;
    while(cursor&&batch.length<16){const bytes=new TextEncoder().encode(cursor.value.raw).length;if(size+bytes>256*1024&&batch.length)break;batch.push(cursor.value);size+=bytes;cursor=await cursor.continue();}await tx.done;return batch;}
  acknowledge(receipts:Receipt[]){return this.serialized(async()=>{const tx=this.db.transaction(['events','outbox'],'readwrite',{durability:'strict'});try{for(const r of receipts){const e=await tx.objectStore('events').get(r.event_id);if(!e||e.hash!==r.hash||e.scope!==r.scope||r.custody!=='PERSISTED'||!r.receipt_id||!['ACCEPTED','RECEIVED_PENDING','QUARANTINED'].includes(r.disposition))throw new Error('CUSTODY_MISMATCH');e.receipt=r;await tx.objectStore('events').put(e);await tx.objectStore('outbox').delete(e.event_id);}await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}});}
  seal(scope:string,seal:Seal){return this.serialized(async()=>{const m=await this.state();const p=m.pending[scope];if(!p||seal.status!=='SEALED'||seal.algorithm!=='exact-set-and-chain-v1'||manifestText(seal.manifest)!==manifestText(p.manifest)||seal.manifest_hash!==await sha256(manifestText(p.manifest)))throw new Error('SEAL_MISMATCH');
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const latest=(await tx.store.get(this.version))!;latest.pending[scope]!.seal=seal;await tx.store.put(latest,this.version);await tx.done;});}
  async drain(){await this.chain;if(this.failure)throw this.failure;}
  termination(reason:string,evidence:unknown){return this.serialized(async()=>{const m=await this.state();m.termination??={request_id:crypto.randomUUID(),reason,evidence};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;return m.termination;});}
  reconciliation(scope:string,path:string[]){return this.serialized(async()=>{const m=await this.state(),head=m.heads[scope]!,key=`${scope}-${head.sequence}`;m.reconciliations??={};
    if(!m.reconciliations[key]){const events=(await this.db.getAllFromIndex('events','scope',scope)).filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence);m.reconciliations[key]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,events:events.map(({event_id,hash})=>({event_id,hash})),path},unknown:m.pending[scope]?.seal?[]:['unfinished-or-unknown-position']};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;}return m.reconciliations[key]!;});}
}
