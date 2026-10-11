全项目设计讨论，传输段 30，源码主题：本地账本与参加者生命周期（源包 11/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/web/local-store.ts L1–L99

```
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { CONTRACT_VERSION, LIMITS, PROTOCOL, manifestText, type EventEnvelope,
  type Manifest, type Receipt, type Seal, type SessionView, type WireEvent } from '../shared/contract.js';

interface LocalEvent extends WireEvent { session_id: string; scope: string; receipt: Receipt | null }
export interface Submission { event: WireEvent; manifest: Manifest; seal_request_id: string; finalize_request_id: string; seal: Seal | null }
export interface LocalState { access_request_id: string; credential: string; session: SessionView | null; submission: Submission | null }
interface LocalSchema extends DBSchema {
  events: { key: string; value: LocalEvent };
  outbox: { key: string; value: WireEvent };
  meta: { key: string; value: LocalState };
}
export async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export class LocalStore {
  constructor(readonly db: IDBPDatabase<LocalSchema>) {}
  static async open(name = 'browser-psych-lab-p0-v1') {
    return new LocalStore(await openDB<LocalSchema>(name, 1, { upgrade(db) {
      db.createObjectStore('events', { keyPath: 'event_id' });
      db.createObjectStore('outbox', { keyPath: 'event_id' }); db.createObjectStore('meta');
    } }));
  }
  async state(): Promise<LocalState> {
    const prior = await this.db.get('meta', 'state');
    if (prior) return prior;
    const state: LocalState = { access_request_id: crypto.randomUUID(),
      credential: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
      session: null, submission: null };
    await this.db.add('meta', state, 'state'); return state;
  }
  async session(session: SessionView) {
    const tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' });
    const state = (await tx.store.get('state'))!; state.session = session;
    await tx.store.put(state, 'state'); await tx.done;
  }
  async submit(session: SessionView, writer: string, clock: string, answer: string, injectAbort = false) {
    const e: EventEnvelope = { event_schema_version: CONTRACT_VERSION, event_id: crypto.randomUUID(),
      session_id: session.session_id, protocol_version_id: PROTOCOL.protocol_version_id,
      writer_id: writer, writer_epoch: session.writer_epoch, scope: PROTOCOL.page_id, sequence: 0,
      previous: null, kind: 'ANSWER_SNAPSHOT', clock_epoch: clock, time_ms: performance.now(),
      payload: { [PROTOCOL.question_id]: answer } };
    // Encoding and hashing happen exactly once, before the IDB transaction opens.
    const raw = JSON.stringify(e); const event = { event_id: e.event_id, hash: await sha256(raw), raw };
    const submission: Submission = { event, manifest: { manifest_id: crypto.randomUUID(), scope: PROTOCOL.page_id,
      events: [{ event_id: event.event_id, hash: event.hash }], path: [PROTOCOL.page_id] },
      seal_request_id: crypto.randomUUID(), finalize_request_id: crypto.randomUUID(), seal: null };
    const tx = this.db.transaction(['events', 'outbox', 'meta'], 'readwrite', { durability: 'strict' });
    try {
      const state = (await tx.objectStore('meta').get('state'))!;
      if (state.submission) throw new Error('PAGE_ALREADY_PENDING');
      await tx.objectStore('events').add({ ...event, session_id: session.session_id, scope: e.scope, receipt: null });
      await tx.objectStore('outbox').add(event); state.submission = submission;
      await tx.objectStore('meta').put(state, 'state');
      if (injectAbort) tx.abort();
      await tx.done; return submission;
    } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
  }
  async batch() {
    const tx = this.db.transaction('outbox');
    const batch: WireEvent[] = []; let bytes = 0;
    let cursor = await tx.store.openCursor();
    while (cursor && batch.length < LIMITS.batch_records) {
      const size = new TextEncoder().encode(cursor.value.raw).byteLength;
      if (bytes + size > LIMITS.batch_bytes) break;
      batch.push(cursor.value); bytes += size; cursor = await cursor.continue();
    }
    await tx.done; return batch;
  }
  async acknowledge(receipts: Receipt[]) {
    const tx = this.db.transaction(['events', 'outbox'], 'readwrite', { durability: 'strict' });
    try {
      for (const receipt of receipts) {
        const event = await tx.objectStore('events').get(receipt.event_id);
        if (!event || event.hash !== receipt.hash || event.scope !== receipt.scope || receipt.custody !== 'PERSISTED'
          || !['ACCEPTED', 'RECEIVED_PENDING', 'QUARANTINED'].includes(receipt.disposition)
          || !receipt.receipt_id || !Number.isInteger(receipt.disposition_version) || receipt.disposition_version < 1)
          throw new Error('RECEIPT_MISMATCH');
        event.receipt = receipt;
        await tx.objectStore('events').put(event); await tx.objectStore('outbox').delete(event.event_id);
      }
      // Raw events stay retained even when custody stops network retries.
      await tx.done;
    } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
  }
  async seal(seal: Seal) {
    const state = await this.state(); const submission = state.submission;
    if (!submission || seal.status !== 'SEALED' || seal.algorithm !== 'exact-set-and-chain-v1'
      || manifestText(submission.manifest) !== manifestText(seal.manifest)
      || seal.manifest_hash !== await sha256(manifestText(submission.manifest))) throw new Error('SEAL_MISMATCH');
    const tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' });
    const latest = (await tx.store.get('state'))!;
    if (latest.submission?.seal_request_id !== submission.seal_request_id) { tx.abort(); await tx.done.catch(() => {}); throw new Error('LOCAL_VERSION_FORK'); }
    latest.submission.seal = seal; await tx.store.put(latest, 'state'); await tx.done;
  }
}

```

### src/web/ledger.ts L1–L57

```
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
  reanswer?:{request_id:string;credential:string};reconciliations?:Record<string,{request_id:string;manifest:Manifest;unknown:string[]}>;termination?:{request_id:string;reason:string;evidence:unknown};consent?:ConsentReceipt;environment?:{request_id:string;sample_id:string;raw:string;received:boolean}}
interface LedgerSchema extends DBSchema {events:{key:string;value:EventRow;indexes:{session:string;scope:string}};
 outbox:{key:string;value:EventRow;indexes:{session:string}};meta:{key:string;value:SessionMeta}}
export class Ledger {
  private chain:Promise<unknown>=Promise.resolve();
  private queued=0;
  private failure:unknown=null;
  private diagnosticCount=0;
  constructor(readonly db:IDBPDatabase<LedgerSchema>,readonly version:string,readonly writer:string,readonly clock=crypto.randomUUID()){}
  static async open(version:string,writer:string){return new Ledger(await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}}),version,writer);}
  async state(){let m=await this.db.get('meta',this.version);if(!m){m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};await this.db.add('meta',m,this.version);}return m;}
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=64){this.failure=new Error('LOCAL_QUEUE_BUDGET_EXCEEDED');return Promise.reject(this.failure);}this.queued++;const next=this.chain.then(fn).finally(()=>{this.queued--;});this.chain=next.catch(error=>{this.failure=error;});return next;}
  session(session:LabSession){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.session=session;await tx.store.put(m,this.version);await tx.done;});}
  consent(receipt:ConsentReceipt){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.consent=receipt;await tx.store.put(m,this.version);await tx.done;});}
  environment(raw?:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;if(raw!==undefined)m.environment??={request_id:crypto.randomUUID(),sample_id:crypto.randomUUID(),raw,received:false};else if(m.environment)m.environment.received=true;await tx.store.put(m,this.version);await tx.done;});}
  reanswerRequest(){return this.serialized(async()=>{const m=await this.state();m.reanswer??={request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')};await this.db.put('meta',m,this.version);return m.reanswer;});}
  restart(session:LabSession,credential:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;await tx.store.put(m,`archive:${m.session!.session_id}`);await tx.store.put({version_id:this.version,request_id:crypto.randomUUID(),credential,session,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{},...(m.consent?{consent:m.consent}:{})},this.version);await tx.done;});}
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