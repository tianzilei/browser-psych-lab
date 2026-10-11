当前交互源码第 4 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_04。
indow.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);window.removeEventListener('pagehide',dispose);overlay.remove();if(main)main.inert=false;};
    window.addEventListener('pagehide',dispose,{once:true});check();
  });
  return {passed,dispose};
}

```


=== FILE src/web/viewport.ts (complete source; may continue in next chunk) ===
```
// Event-driven visible viewport sizing. No polling or animation loop.
export function lockParticipantViewport() {
  const root = document.documentElement;
  let frame = 0;
  const size = () => {
    frame = 0;
    const viewport = window.visualViewport;
    root.style.setProperty('--viewport-width', `${viewport?.width ?? innerWidth}px`);
    root.style.setProperty('--viewport-height', `${viewport?.height ?? innerHeight}px`);
    root.style.setProperty('--viewport-left', `${viewport?.offsetLeft ?? 0}px`);
    root.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };
  const resize = () => { if (!frame) frame = requestAnimationFrame(size); };
  const move = (event: TouchEvent) => {
    if (document.body.classList.contains('runner-layout')) event.preventDefault();
  };
  size();
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  document.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    document.removeEventListener('touchmove', move);
  }, { once: true });
}

```


=== FILE src/web/session-gate.ts (complete source; may continue in next chunk) ===
```
import {request,uid} from './dom.js';
import type {ParticipantAPI} from './participant-api.js';
import type {SessionAdmissionStatus} from '../shared/lab-contract.js';
import {RequestError} from './request-error.js';
export function cancelAdmission(controller:AbortController){const error=new Error('已取消进入，可稍后再进行答题。');error.name='SESSION_WAIT_CANCELED';controller.abort(error);}
export async function awaitSessionAdmission(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){
  const nonce=uid(),url=api.path('admission'),body=(action:string)=>({action,ticket_id:nonce,...api.fence()});
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),failure:unknown;
  const abort=()=>{stopped=true;clearTimeout(timer);};
  const hidden=()=>abort();
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',hidden,{once:true});
  const stop=async()=>{stopped=true;clearTimeout(timer);signal.removeEventListener('abort',abort);window.removeEventListener('pagehide',hidden);await pending;};
  try{
    let sent=performance.now(),result=await request<SessionAdmissionStatus>(url,body('join'),undefined,signal);
    if(result.status!=='ACTIVE')throw new RequestError('SESSION_CAPACITY_FULL',409);signal.throwIfAborted();let deadline=sent+result.lease_remaining_ms;
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{const sent=performance.now(),next=await request<SessionAdmissionStatus>(url,body('touch'),undefined,signal);
        if(next.status!=='ACTIVE')throw new RequestError('ADMISSION_EXPIRED',409);deadline=sent+next.lease_remaining_ms;}
      catch(error){failure=error;if(!stopped&&!signal.aborted)onLost(error);}
      finally{if(!stopped&&!signal.aborted&&!failure)renew();}
    })();},60000);};renew();
    return {stop,check:()=>{signal.throwIfAborted();if(failure)throw failure;if(performance.now()>=deadline)throw new RequestError('ADMISSION_EXPIRED',409);}};
  }catch(error){await stop();if(signal.reason instanceof Error&&signal.reason.name==='SESSION_WAIT_CANCELED')await request(url,body('leave')).catch(()=>{});throw error;}
}

```


=== FILE src/web/participant-api.ts (complete source; may continue in next chunk) ===
```
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
  async syncEnvironment(){const environment=(await this.ledger.state()).environment;if(environment&&!environment.received){const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:environment.request_id,sample_id:environment.sample_id,raw:environment.raw});if(result.status!=='PERSISTED'||result.hash!==(environment.hash??await sha256(environment.raw)))throw new Error('ENVIRONMENT_RECEIPT_MISMATCH');await this.ledger.environment();}}
  async sync(){await this.ledger.drain();await this.syncEnvironment();for(;;){const events=await this.ledger.batch();if(!events.length)break;const result=await request<{receipts:Receipt[]}>(this.path('ingest'),{batch_id:crypto.randomUUID(),events:events.map(({event_id,hash,raw})=>({event_id,hash,raw}))});
    if(result.receipts.length!==events.length||events.some(e=>!result.receipts.some(r=>r.event_id===e.event_id&&r.hash===e.hash)))throw new Error('CUSTODY_RECEIPT_MISMATCH');await this.ledger.acknowledge(result.receipts);}
  }
  async seal(scope:string){await this.sync();const state=await this.ledger.state(),pending=state.pending[scope]!;
    const seal=pending.seal??await request<Seal>(this.path('seal'),{request_id:pending.request_id,...this.fence(),manifest:pending.manifest});
    if(seal.status!=='SEALED')throw new Error('SAVE_NOT_CONFIRMED');await this.ledger.seal(scope,seal);await this.refresh();return seal;
  }
  async complete(){await this.sync();await this.refresh();const m=await this.ledger.state();const result=await request<{status:string}>(this.path('finalize'),{request_id:m.finalize_id,...this.fence(),seal_ids:this.session.seals.map(s=>s.seal_id)});if(result.status!=='COMPLETED')throw new Error('COMPLETION_NOT_CONFIRMED');await this.refresh();}
  async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
  async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){const report=await request<{status:string;cleanup_allowed:boolean}>(this.path('reconcile'),await this.ledger.reconciliation(scope,this.session.path));if(report.status!=='RECONCILED'||report.cleanup_allowed!==false)throw new Error('RECONCILIATION_MISMATCH');}}
  async reanswer(){await this.reconcile();const data=await this.ledger.reanswerRequest();const result=await request<LabSession>(this.path('reanswer'),data);await this.ledger.restart(result,data.credential);return result;}
  static async open(version:string,writer:string){await requireOrientation(version);const ledger=await Ledger.open(version,writer),m=await ledger.state();
    const {requireConsent}=await import('./consent-gate.js'),consent=await requireConsent(ledger);
    if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
    await requireOrientation(version);const initial=m.session?await request<LabSession>(`/api/participate/sessions/${m.session.session_id}/resume`,{credential:m.credential}):await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential,...(consent?{consent}:{})});const api=new ParticipantAPI(ledger,initial);await api.refresh();await api.syncEnvironment();return api;}
}

```


=== FILE src/web/ledger.ts (complete source; may continue in next chunk) ===
```
import {openDB,type DBSchema,type IDBPDatabase} from 'idb';
import {LAB_SCHEMA, type Answer} from '../shared/protocol.js';
import {type LabEvent,type LabSession} from '../shared/lab-contract.js';
import {type WireEvent,type EventRef,type Manifest,type Receipt,type Seal,manifestText} from '../shared/contract.js';
import {sha256} from './local-store.js';
import type {ConsentReceipt} from './consent-gate.js';
interface EventRow extends WireEvent {session_id:string;scope:string;sequence:number;receipt:Receipt|null;byte_length?:number}
const encoder=new TextEncoder();
export interface PendingSeal {request_id:string;manifest:Manifest;seal:Seal|null}
export interface SessionMeta {version_id:string;request_id:string;credential:string;session:LabSession|null;
  heads:Record<string,{sequence:number;previous:EventRef|null}>;pending:Record<string,PendingSeal>;finalize_id:string;page_values:Record<string,Record<string,Answer>>;
  reanswer?:{request_id:string;credential:string};reconciliations?:Record<string,{request_id:string;manifest:Manifest;unknown:string[]}>;termination?:{request_id:string;reason:string;evidence:unknown};consent?:ConsentReceipt;environment?:{request_id:string;sample_id:string;raw:string;hash?:string;received:boolean}}
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
  environment(raw?:string){return this.serialized(async()=>{const hash=raw===undefined?undefined:await sha256(raw);const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;if(raw!==undefined)m.environment??={request_id:crypto.randomUUID(),sample_id:crypto.randomUUID(),raw,hash:hash!,received:false};else if(m.environment)m.environment.received=true;await tx.store.put(m,this.version);await tx.done;});}
  reanswerRequest(){return this.serialized(async()=>{const m=await this.state();m.reanswer??={request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')};await this.db.put('meta',m,this.version);return m.reanswer;});}
  restart(session:LabSession,credential:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;await tx.store.put(m,`archive:${m.session!.session_id}`);await tx.store.put({version_id:this.version,request_id:crypto.randomUUID(),credential,session,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{},...(m.consent?{consent:m.consent}:{})},this.version);await tx.done;});}
  append(scope:string,kind:LabEvent['kind'],payload:Record<string,unknown>,pendingPath?:string[],pageValues?:Record<string,Answer>){return this.serialized(async()=>{
    const m=await this.state(),s=m.session;if(!s)throw new Error('NO_LOCAL_SESSION');if(m.pending[scope]&&kind!=='INPUT_DIAGNOSTIC')throw new Error('SCOPE_ALREADY_PENDING');
    const head=m.heads[scope]??{sequence:0,previous:null};if(head.sequence>=5000)throw new Error('LOCAL_SCOPE_EVENT_BUDGET_EXCEEDED');const e:LabEvent={event_schema_version:LAB_SCHEMA,event_id:crypto.ra