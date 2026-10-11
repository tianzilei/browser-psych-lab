追加复审差异：真实双标签恢复测试发现，在取得同版本本地 Web Lock 后生成新的 writer_id 会推进服务器 writer_epoch；旧原始 PAGE_REVISION 随后成为 historical pending，seal WAITING。因此仅 ParticipantAPI.open（它的两个入口都已取得同版本 Web Lock）显式请求 Ledger.open(..., resumeWriter=true)，使用本地持久身份，旧格式从 session.writer_id 兼容恢复，并同步 sessionStorage 供旧冻结 runner 使用。通用 Ledger.open 默认仍不自动恢复身份。服务器 owner/epoch/lease 拒绝策略、原始事件字节、scope chain、seals 不变。重答在新会话保留该本地身份并归档旧数据。另外现有 actions 测试因 outbox UUID 发送顺序而失败；actions API 按 received rowid 分页，现行 replay 会按 time_origin+sample.at 排序；修正测试仅比较完整点集及逐点原生字段，不宣称 API 保证采集顺序。本阶段只回复 PATCH_ACK_05。\ndiff --git a/src/web/ledger.ts b/src/web/ledger.ts
index ac9260f..02381d1 100644
--- a/src/web/ledger.ts
+++ b/src/web/ledger.ts
@@ -7,7 +7,7 @@ import type {ConsentReceipt} from './consent-gate.js';
 interface EventRow extends WireEvent {session_id:string;scope:string;sequence:number;receipt:Receipt|null;byte_length?:number}
 const encoder=new TextEncoder();
 export interface PendingSeal {request_id:string;manifest:Manifest;seal:Seal|null}
-export interface SessionMeta {version_id:string;request_id:string;credential:string;session:LabSession|null;
+export interface SessionMeta {version_id:string;request_id:string;credential:string;session:LabSession|null;writer_id?:string;
   heads:Record<string,{sequence:number;previous:EventRef|null}>;pending:Record<string,PendingSeal>;finalize_id:string;page_values:Record<string,Record<string,Answer>>;
   reanswer?:{request_id:string;credential:string};reconciliations?:Record<string,{request_id:string;manifest:Manifest;unknown:string[]}>;termination?:{request_id:string;reason:string;evidence:unknown};consent?:ConsentReceipt;environment?:{request_id:string;sample_id:string;raw:string;hash?:string;received:boolean}}
 interface LedgerSchema extends DBSchema {events:{key:string;value:EventRow;indexes:{session:string;scope:string}};
@@ -18,14 +18,20 @@ export class Ledger {
   private failure:unknown=null;
   private diagnosticCount=0;
   constructor(readonly db:IDBPDatabase<LedgerSchema>,readonly version:string,readonly writer:string,readonly clock=crypto.randomUUID()){}
-  static async open(version:string,writer:string){return new Ledger(await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}}),version,writer);}
-  async state(){let m=await this.db.get('meta',this.version);if(!m){m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};await this.db.add('meta',m,this.version);}return m;}
+  static async open(version:string,writer:string,resumeWriter=false){
+    const db=await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}});
+    // Only resume an identity after acquiring this version's native Web Lock.
+    // A new tab must not advance the epoch of still-pending original events.
+    const prior=resumeWriter?await db.get('meta',version):undefined;
+    return new Ledger(db,version,prior?.writer_id??prior?.session?.writer_id??writer);
+  }
+  async state(){let m=await this.db.get('meta',this.version);if(!m){m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,writer_id:this.writer,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};await this.db.add('meta',m,this.version);}else if(!m.writer_id){m.writer_id=this.writer;await this.db.put('meta',m,this.version);}return m;}
   private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=64){this.failure=new Error('LOCAL_QUEUE_BUDGET_EXCEEDED');return Promise.reject(this.failure);}this.queued++;const next=this.chain.then(fn).finally(()=>{this.queued--;});this.chain=next.catch(error=>{this.failure=error;});return next;}
   session(session:LabSession){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.session=session;await tx.store.put(m,this.version);await tx.done;});}
   consent(receipt:ConsentReceipt){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.consent=receipt;await tx.store.put(m,this.version);await tx.done;});}
   environment(raw?:string){return this.serialized(async()=>{const hash=raw===undefined?undefined:await sha256(raw);const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;if(raw!==undefined)m.environment??={request_id:crypto.randomUUID(),sample_id:crypto.randomUUID(),raw,hash:hash!,received:false};else if(m.environment)m.environment.received=true;await tx.store.put(m,this.version);await tx.done;});}
   reanswerRequest(){return this.serialized(async()=>{const m=await this.state();m.reanswer??={request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('')};await this.db.put('meta',m,this.version);return m.reanswer;});}
-  restart(session:LabSession,credential:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;await tx.store.put(m,`archive:${m.session!.session_id}`);await tx.store.put({version_id:this.version,request_id:crypto.randomUUID(),credential,session,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{},...(m.consent?{consent:m.consent}:{})},this.version);await tx.done;});}
+  restart(session:LabSession,credential:string){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;await tx.store.put(m,`archive:${m.session!.session_id}`);await tx.store.put({version_id:this.version,request_id:crypto.randomUUID(),credential,session,writer_id:this.writer,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{},...(m.consent?{consent:m.consent}:{})},this.version);await tx.done;});}
   append(scope:string,kind:LabEvent['kind'],payload:Record<string,unknown>,pendingPath?:string[],pageValues?:Record<string,Answer>){return this.serialized(async()=>{
     const m=await this.state(),s=m.session;if(!s)throw new Error('NO_LOCAL_SESSION');if(m.pending[scope]&&kind!=='INPUT_DIAGNOSTIC')throw new Error('SCOPE_ALREADY_PENDING');
     const head=m.heads[scope]??{sequence:0,previous:null};if(head.sequence>=5000)throw new Error('LOCAL_SCOPE_EVENT_BUDGET_EXCEEDED');const e:LabEvent={event_schema_version:LAB_SCHEMA,event_id:crypto.randomUUID(),session_id:s.session_id,version_id:s.frozen.version_id,protocol_hash:s.frozen.hash,
diff --git a/src/web/participant-api.ts b/src/web/participant-api.ts
index 2d89ca7..5de3b0d 100644
--- a/src/web/participant-api.ts
+++ b/src/web/participant-api.ts
@@ -26,7 +26,8 @@ export class ParticipantAPI {
   async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
   async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){const report=await request<{status:string;cleanup_allowed:boolean}>(this.path('reconcile'),await this.ledger.reconciliation(scope,this.session.path));if(report.status!=='RECONCILED'||report.cleanup_allowed!==false)throw new Error('RECONCILIATION_MISMATCH');}}
   async reanswer(){await this.reconcile();const data=await this.ledger.reanswerRequest();const result=await request<LabSession>(this.path('reanswer'),data);await this.ledger.restart(result,data.credential);return result;}
-  static async open(version:string,writer:string){await requireOrientation(version);const ledger=await Ledger.open(version,writer),m=await ledger.state();
+  static async open(version:string,writer:string){await requireOrientation(version);const ledger=await Ledger.open(version,writer,true),m=await ledger.state();
+    sessionStorage.setItem(`lab-writer-${version}`,ledger.writer);
     const {requireConsent}=await import('./consent-gate.js'),consent=await requireConsent(ledger);
     if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
     await requireOrientation(version);const initial=m.session?await request<LabSession>(`/api/participate/sessions/${m.session.session_id}/resume`,{credential:m.credential}):await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential,...(consent?{consent}:{})});const api=new ParticipantAPI(ledger,initial);await api.refresh();await api.syncEnvironment();return api;}

