import type Database from 'better-sqlite3';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { digest, type Command } from './collection-store.js';
import { Xoshiro128, sampleBounded } from '../shared/prng.js';
import { LAB_SQL } from './lab-schema.js';
import {SessionAdmission,SESSION_LEASE_MS} from './session-admission.js';
import { ContractError, eventRef, hash, id, object, integer, parseManifest, manifestText, type Receipt, type Seal } from '../shared/contract.js';
import { parseProtocol, sampleProtocol, stableJSON, evaluate, pageSnapshot, RUNNER_VERSION,
  type Protocol, type FrozenProtocol, type AssetInfo, type Answer } from '../shared/protocol.js';
import { parseLabEvent, type LabEvent, type LabSession, type GroupPlan, type TrialSelection } from '../shared/lab-contract.js';
import {sampleTrials} from '../shared/trial-sampling.js';
import {realizeTrials} from '../shared/trial-design.js';
import {validInteractionBatch} from '../shared/interaction.js';
import {compileQuestionnaire,parseQuestionnaireText,packageName} from '../shared/questionnaire-json.js';
interface SessionRow { session_id: string; study_id: string; version_id: string; credential_hash: string; admission_id: string;
 state: LabSession['state']; writer_id: string | null; writer_epoch: number; lease_until: number; page_index: number; group_index: number;
 answers: string; path: string; allocation_id: string | null; completion: string | null }
interface StoredEvent { event_id: string; hash: string; scope: string; sequence: number; writer_epoch: number; kind: string;
 envelope: string; disposition: Receipt['disposition']; version: number; reason: string }
class Rejection { constructor(readonly error: ContractError) {} }
export class LabStore {
  readonly admission:SessionAdmission;
  constructor(readonly db: Database.Database, readonly runnerHash = digest('TEST_ONLY'), private now = Date.now,sessionConcurrency=2) {
    db.exec(LAB_SQL);
    if (this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='schema'")?.value !== '1') throw new Error('UNSUPPORTED_LAB_SCHEMA');
    // Upgrade role-based installations atomically; credential expiry uses milliseconds.
    if(this.all<{name:string}>('PRAGMA table_info(lab_admin_tokens)').some(column=>column.name==='role'))db.transaction(()=>{
      db.exec('CREATE TABLE lab_admin_tokens_new(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT');
      this.run('INSERT INTO lab_admin_tokens_new SELECT token_hash,csrf,expires_at FROM lab_admin_tokens WHERE expires_at>=?',now());
      db.exec('DROP TABLE lab_admin_tokens; ALTER TABLE lab_admin_tokens_new RENAME TO lab_admin_tokens');
    }).immediate();
    this.admission=new SessionAdmission(db,sessionConcurrency,now);
  }
  get<T>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }
  private audit(actor: string, operation: string, subject: string, detail: unknown) {
    this.run('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)', randomUUID(), actor, operation, subject, JSON.stringify(detail), this.now());
  }
  private diagnostic(sid: string, scope: string | null, code: string, detail: unknown) {
    this.run('INSERT INTO lab_diagnostics VALUES (?,?,?,?,?,?)',randomUUID(),sid,scope,code,JSON.stringify(detail),this.now());
  }
  private admin(c: Command) {
    const token = this.get<{csrf:string;expires_at:number}>('SELECT csrf,expires_at FROM lab_admin_tokens WHERE token_hash=?', c.credential_hash ?? '');
    if (!token || token.expires_at < this.now()) throw new ContractError('LOGIN_REQUIRED',401);
    if (c.data.csrf !== token.csrf && !['admin.me','study.list','study.get','asset.list','session.list','session.detail','session.actions','job.list','job.get','environment.list'].includes(c.operation.slice(4)))
      throw new ContractError('CSRF_REJECTED',403);
    return { actor: c.credential_hash!, ...token };
  }
  private session(c: Command) {
    const s = this.get<SessionRow>('SELECT * FROM lab_sessions WHERE session_id=?',id(c.session_id));
    if (!s || !c.credential_hash || !/^[a-f0-9]{64}$/.test(c.credential_hash)
      || !timingSafeEqual(Buffer.from(s.credential_hash),Buffer.from(c.credential_hash))) throw new ContractError('UNAUTHORIZED',401);
    return s;
  }
  private active(s: SessionRow, d: Record<string,unknown>) {
    if (['COMPLETED','TERMINATED'].includes(s.state)) throw new ContractError('SESSION_TERMINAL',409);
    if (s.writer_id !== id(d.writer_id) || s.writer_epoch !== integer(d.writer_epoch,1)) throw new ContractError('WRITER_FENCED',409);
  }
  private request(subject: string, op: string, d: Record<string,unknown>, fn: ()=>unknown): unknown {
    const rid = id(d.request_id); const logical={...d};delete logical.proof_job_id;if(op==='participant.create')delete logical.server_covariates;const h = digest(stableJSON(logical));
    const old = this.get<{hash:string;response:string|null}>('SELECT * FROM lab_requests WHERE subject=? AND operation=? AND request_id=?',subject,op,rid);
    if (old) {
      if (old.hash !== h) { this.audit(subject,'IDEMPOTENCY_CONFLICT',rid,{op,existing:old.hash,incoming:h}); return new Rejection(new ContractError('IDEMPOTENCY_CONFLICT',409)); }
      if (old.response) return JSON.parse(old.response);
    } else this.run('INSERT INTO lab_requests VALUES (?,?,?,?,NULL)',subject,op,rid,h);
    const result = fn();
    if (object(result).status !== 'WAITING') this.run('UPDATE lab_requests SET response=? WHERE subject=? AND operation=? AND request_id=?',JSON.stringify(result),subject,op,rid);
    return result;
  }
  private barrier() {
    if (this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='resource_barrier'")!.value) throw new ContractError('RESOURCE_LIFECYCLE_BLOCKED',503);
  }
  frozen(vid: string): FrozenProtocol {
    const v = this.get<{version_id:string;study_id:string;hash:string;protocol:string;runner_hash:string;runner_version:string}>('SELECT * FROM lab_versions WHERE version_id=?',id(vid));
    if (!v) throw new ContractError('VERSION_NOT_FOUND',404);
    const assets = this.all<AssetInfo>('SELECT a.asset_id,a.hash,a.bytes,a.width,a.height,a.format,a.state,a.name FROM lab_assets a JOIN lab_asset_refs r ON r.asset_id=a.asset_id WHERE r.kind=\'VERSION\' AND r.owner=?',vid);
    return {version_id:v.version_id,study_id:v.study_id,hash:v.hash,protocol:JSON.parse(v.protocol) as Protocol,runner_version:v.runner_version,runner_hash:v.runner_hash,assets};
  }
  view(sid: string): LabSession {
    const s = this.get<SessionRow>('SELECT * FROM lab_sessions WHERE session_id=?',sid)!;
    const p = this.get<{permit_id:string;scope:string;group_id:string;plan:string;state:string}>('SELECT * FROM lab_permits WHERE session_id=? ORDER BY rowid DESC LIMIT 1',sid);
    const allocation = this.get<LabSession['allocation']>('SELECT allocation_id,variant_id,reservation_id FROM lab_slots WHERE session_id=? AND allocation_id IS NOT NULL',sid) ?? null;
    return {session_id:sid,study_id:s.study_id,admission_id:s.admission_id,state:s.state,writer_id:s.writer_id,writer_epoch:s.writer_epoch,lease_until:s.lease_until,
      frozen:this.frozen(s.version_id),answers:JSON.parse(s.answers) as Record<string,Answer>,path:JSON.parse(s.path) as string[],page_index:s.page_index,group_index:s.group_index,
      allocation,permit:p?{permit_id:p.permit_id,scope:p.scope,group_id:p.group_id,plan:JSON.parse(p.plan) as GroupPlan,state:p.state}:null,
      task_activity:(()=>{const row=this.get<{last_seen:number}>('SELECT last_seen FROM lab_task_activity WHERE session_id=?',sid);return row?{last_seen:row.last_seen,idle_timeout_ms:120000,connection_timeout_ms:300000}:null;})(),
      seals:this.all<{response:string}>('SELECT response FROM lab_seals WHERE session_id=? ORDER BY rowid',sid).map(r=>JSON.parse(r.response) as Seal),
      completion:s.completion?JSON.parse(s.completion):null,diagnostics:this.all('SELECT code,scope FROM lab_diagnostics WHERE session_id=?',sid),admission:this.admission.view(sid),reanswer:this.get('SELECT old_session_id,new_session_id,created_at FROM lab_reanswer_links WHERE new_session_id=? OR old_session_id=?',sid,sid)??null};
  }
  private custody(sid: string, ref: {event_id:string;hash:string}): Receipt|null {
    const raw = this.get<{receipt_id:string;scope:string}>('SELECT receipt_id,scope FROM lab_raw WHERE session_id=? AND event_id=? AND hash=?',sid,ref.event_id,ref.hash);
    if (!raw) return null;
    const d = this.get<{disposition:Receipt['disposition'];version:number;reason:string}>('SELECT * FROM lab_dispositions WHERE receipt_id=? ORDER BY version DESC LIMIT 1',raw.receipt_id)!;
    return {...ref,...raw,custody:'PERSISTED',disposition:d.disposition,disposition_version:d.version,reason:d.reason};
  }
  private semantic(s: SessionRow, e: LabEvent): [Receipt['disposition'],string] {
    if (s.state === 'TERMINATED' || e.writer_epoch !== s.writer_epoch || e.writer_id !== s.writer_id) return ['RECEIVED_PENDING','HISTORICAL_RECONCILIATION_REQUIRED'];
    if (e.kind!=='INPUT_DIAGNOSTIC'&&(s.state === 'COMPLETED' || this.get('SELECT 1 FROM lab_seals WHERE session_id=? AND scope=?',s.session_id,e.scope))) return ['QUARANTINED','LATE_AFTER_SEAL'];
    const p = this.frozen(s.version_id).protocol;
    if (e.kind === 'PAGE_SNAPSHOT' || e.kind === 'PAGE_REVISION') {
      const page = p.pages[s.page_index];
      if (!page || e.scope !== page.id) return ['QUARANTINED','WRONG_PAGE_POSITION'];
      try {
        if(e.kind==='PAGE_SNAPSHOT')pageSnapshot(page,JSON.parse(s.answers) as Record<string,Answer>,object(e.payload.answers) as Record<string,Answer>);
        else{const q=page.questions.find(q=>q.id===e.payload.question_id);if(!q)throw new Error('UNKNOWN_QUESTION');const revision={...q,required:false};delete revision.condition;pageSnapshot({...page,questions:[revision]}, {}, {[q.id]:e.payload.answer as Answer});}
      }
      catch { return ['QUARANTINED','INVALID_PAGE_ANSWERS']; }
    } else if(e.kind==='INPUT_DIAGNOSTIC'&&e.scope.startsWith('d-ui-')){
      if(!validInteractionBatch(e.payload.interaction))return ['QUARANTINED','INVALID_INTERACTION_BATCH'];
    } else {
      const permit = this.get<{writer_epoch:number;state:string}>('SELECT * FROM lab_permits WHERE session_id=? AND scope=?',s.session_id,e.kind==='INPUT_DIAGNOSTIC'?e.scope.slice(2):e.scope);
      if (!permit || permit.writer_epoch !== e.writer_epoch || (e.kind!=='INPUT_DIAGNOSTIC'&&permit.state !== 'ISSUED')) return ['QUARANTINED','OUTSIDE_PERMIT'];
      if (e.kind === 'GROUP_RECORD' && (!e.payload.record || typeof e.payload.record !== 'object')) return ['QUARANTINED','INVALID_GROUP_RECORD'];
    }
    if ((e.sequence === 0) !== (e.previous === null)) return ['QUARANTINED','INVALID_CHAIN_START'];
    if (e.previous) {
      const old = this.get<StoredEvent>('SELECT * FROM lab_events WHERE session_id=? AND event_id=?',s.session_id,e.previous.event_id);
      if (!old) return ['RECEIVED_PENDING','MISSING_PREDECESSOR'];
      const previous = parseLabEvent(old.envelope);
      if (old.hash !== e.previous.hash || old.scope !== e.scope || old.sequence !== e.sequence-1 || old.writer_epoch !== e.writer_epoch
        || (previous.clock_epoch !== e.clock_epoch && !['PAGE_REVISION','PAGE_SNAPSHOT'].includes(e.kind))
        || (previous.clock_epoch===e.clock_epoch&&previous.time_ms > e.time_ms)) return ['QUARANTINED','INVALID_PREDECESSOR_OR_CLOCK'];
      if (old.disposition !== 'ACCEPTED') return ['RECEIVED_PENDING','PREDECESSOR_NOT_ACCEPTED'];
    }
    if (this.get('SELECT 1 FROM lab_events WHERE session_id=? AND scope=? AND sequence=? AND event_id<>?',s.session_id,e.scope,e.sequence,e.event_id)) return ['QUARANTINED','DUPLICATE_POSITION'];
    return ['ACCEPTED','VALID'];
  }
  private ingest(s: SessionRow,d: Record<string,unknown>) {
    if (!Array.isArray(d.events) || !d.events.length || d.events.length > 32) throw new ContractError('INVALID_BATCH');
    let bytes = 0;
    const items = d.events.map(v=>{
      const w = object(v); const ref = eventRef(w); if (typeof w.raw !== 'string') throw new ContractError('INVALID_RAW');
      const raw = Buffer.from(w.raw,'utf8'); bytes += raw.byteLength;
      if(raw.toString('utf8')!==w.raw)throw new ContractError('INVALID_RAW_UTF8');
      if (raw.byteLength > 128*1024 || bytes > 512*1024 || digest(raw)!==ref.hash) throw new ContractError('HASH_OR_SIZE_MISMATCH');
      const e = parseLabEvent(w.raw); const version = this.frozen(s.version_id);
      if (e.session_id!==s.session_id || e.event_id!==ref.event_id || e.version_id!==s.version_id || e.protocol_hash!==version.hash)
        throw new ContractError('UNAUTHORIZED_EVENT',403);
      const writer=this.get<{writer_id:string}>('SELECT writer_id FROM lab_writers WHERE session_id=? AND epoch=?',s.session_id,e.writer_epoch);
      if (!writer || writer.writer_id!==e.writer_id || (!version.protocol.pages.some(p=>p.id===e.scope)
        && !(e.kind==='INPUT_DIAGNOSTIC'&&e.scope.startsWith('d-ui-')) && !this.get('SELECT 1 FROM lab_permits WHERE session_id=? AND scope=? AND writer_epoch=?',s.session_id,e.kind==='INPUT_DIAGNOSTIC'&&e.scope.startsWith('d-')?e.scope.slice(2):e.scope,e.writer_epoch))) throw new ContractError('UNAUTHORIZED_SCOPE',403);
      return {ref,raw,e,text:w.raw};
    });
    for (const {ref,raw,e,text} of items) {
      if (this.custody(s.session_id,ref)) continue;
      const count = this.get<{n:number;b:number}>('SELECT count(*) AS n,coalesce(sum(length(raw)),0) AS b FROM lab_raw WHERE session_id=? AND scope=?',s.session_id,e.scope)!;
      if (count.n >= 5000 || count.b + raw.length > 32*1024*1024) throw new ContractError('SCOPE_BUDGET_EXCEEDED',413);
      const old = this.get<StoredEvent>('SELECT * FROM lab_events WHERE session_id=? AND event_id=?',s.session_id,e.event_id);
      const receipt = randomUUID(); this.run('INSERT INTO lab_raw VALUES (?,?,?,?,?,?,?)',s.session_id,e.event_id,ref.hash,e.scope,receipt,raw,this.now());
      const [state,reason] = old ? ['QUARANTINED','EVENT_ID_HASH_CONFLICT'] as const : this.semantic(s,e);
      this.run('INSERT INTO lab_dispositions VALUES (?,?,?,?)',receipt,1,state,reason);
      if (!old) this.run('INSERT INTO lab_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',s.session_id,e.event_id,ref.hash,e.scope,e.sequence,e.writer_epoch,e.kind,text,state,1,reason);
      if (old || state==='QUARANTINED') this.diagnostic(s.session_id,old?.scope??e.scope,reason,ref);
    }
    for (const scope of new Set(items.map(i=>i.e.scope))) {
      const pending=this.all<StoredEvent>("SELECT * FROM lab_events WHERE session_id=? AND scope=? AND disposition='RECEIVED_PENDING' ORDER BY sequence LIMIT 5000",s.session_id,scope);
      for (const e of pending) {
        const [state,reason]=this.semantic(s,parseLabEvent(e.envelope));
        if (state===e.disposition && reason===e.reason) continue;
        const r=this.custody(s.session_id,e)!; this.run('INSERT INTO lab_dispositions VALUES (?,?,?,?)',r.receipt_id,e.version+1,state,reason);
        this.run('UPDATE lab_events SET disposition=?,version=?,reason=? WHERE session_id=? AND event_id=?',state,e.version+1,reason,s.session_id,e.event_id);
      }
    } return {receipts:items.map(i=>this.custody(s.session_id,i.ref))};
  }
  execute(c: Command): unknown {
    const started=performance.now(); const result=this.db.transaction(()=>{
      const value=this.dispatch(c); if(performance.now()-started>1000) throw new ContractError('TRANSACTION_BUDGET_EXCEEDED',503); return value;
    }).immediate(); if(result instanceof Rejection) throw result.error; return result;
  }
  expireTaskActivity(){
    return this.db.transaction(()=>{const expired=this.all<{session_id:string}>("SELECT a.session_id FROM lab_task_activity a JOIN lab_sessions s USING(session_id) WHERE a.last_seen<=? AND s.state='ACTIVE' AND a.writer_epoch=s.writer_epoch",this.now()-300000);
      for(const {session_id:sid} of expired){this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);this.run("UPDATE lab_permits SET state='CLOSED_UNKNOWN' WHERE session_id=? AND state='ISSUED'",sid);this.admission.ended(sid);this.diagnostic(sid,null,'CONNECTION_TIMEOUT',{timeout_ms:300000});}
      this.run("DELETE FROM lab_task_activity WHERE session_id IN (SELECT session_id FROM lab_sessions WHERE state IN ('COMPLETED','TERMINATED'))");return expired.length;
    }).immediate();
  }
  private dispatch(c: Command): unknown {
    const op=c.operation.slice(4); const d=object(c.data);
    if(op==='admin.issue') {
      this.run('DELETE FROM lab_admin_tokens WHERE expires_at<?',this.now());
      this.run('INSERT INTO lab_admin_tokens VALUES (?,?,?)',hash(d.token_hash),id(d.csrf),this.now()+8*3600000);
      this.audit(String(d.token_hash),'LOGIN','admin',{}); return {authenticated:true,csrf:d.csrf};
    }
    if(op==='version.public') return this.frozen(id(d.version_id));
    if(op==='questionnaires.public') {
      const rows=this.all<{version_id:string;title:string}>('SELECT v.version_id,s.title FROM lab_versions v JOIN lab_studies s ON s.study_id=v.study_id WHERE s.admission=\'OPEN\' AND v.rowid=(SELECT v2.rowid FROM lab_versions v2 WHERE v2.study_id=v.study_id ORDER BY v2.rowid DESC LIMIT 1) ORDER BY v.rowid DESC');
      return {questionnaires:rows.map(row=>({version_id:row.version_id,title:row.title}))};
    }
    if(op==='version.metadata'){const f=this.frozen(id(d.version_id));return {title:f.protocol.title,background:f.protocol.layout.background,orientation:f.protocol.layout.orientation??null};}
    if(op==='version.consent'){const {consent}=this.frozen(id(d.version_id)).protocol;return consent?{document:consent,document_hash:digest(stableJSON(consent))}:null;}
    if(op==='participant.create') return this.request(`admission-${id(d.version_id)}`,op,d,()=>{
      const frozen=this.frozen(id(d.version_id));
      const consentHash=frozen.protocol.consent?digest(stableJSON(frozen.protocol.consent)):null;
      if(consentHash){const c=d.consent===undefined?{}:object(d.consent);if(c.accepted!==true||c.document_hash!==consentHash||Object.keys(c).some(k=>!['accepted','document_hash'].includes(k)))throw new ContractError('CONSENT_REQUIRED',403);}
      else if(d.consent!==undefined)throw new ContractError('UNEXPECTED_CONSENT');
      if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',frozen.study_id)!.admission!=='OPEN') throw new ContractError('ADMISSION_PAUSED',409);
      if(frozen.protocol.mode==='COLLECTION' && this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value!=='OPEN') throw new ContractError('COLLECTION_GATE_CLOSED',409);
      if(frozen.protocol.mode==='COLLECTION'&&this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_environment'")?.value!==frozen.protocol.budget.environment_id)throw new ContractError('COLLECTION_ENVIRONMENT_MISMATCH',409);
      const sid=randomUUID(); this.run("INSERT INTO lab_sessions(session_id,study_id,version_id,admission_id,credential_hash,state,created_at) VALUES (?,?,?,?,?,'CREATED',?)",sid,frozen.study_id,frozen.version_id,randomUUID(),hash(d.credential_hash),this.now());
      if(consentHash)this.run('INSERT INTO lab_consents VALUES (?,?,?)',sid,consentHash,this.now());
      if(d.server_covariates){const raw=stableJSON(object(d.server_covariates));this.run('INSERT INTO lab_covariates VALUES (?,?,?,?,?,?)',sid,'server-open',digest(raw),raw,'server-observed',this.now());}
      return this.view(sid);
    });
    if(op.startsWith('participant.')) return this.participant(op,c,d);
    if(op.startsWith('internal.')) return this.internal(op,d);
    const admin=this.admin(c);
    const actor=admin.actor;
    switch(op) {
      case 'admin.me': return {authenticated:true,csrf:admin.csrf};
      case 'admin.logout': this.run('DELETE FROM lab_admin_tokens WHERE token_hash=?',actor); return {status:'LOGGED_OUT'};
      case 'study.list': return {studies:this.all('SELECT s.study_id,s.title,s.revision,s.admission,s.created_at,(SELECT version_id FROM lab_versions v WHERE v.study_id=s.study_id ORDER BY rowid DESC LIMIT 1) AS version_id FROM lab_studies s WHERE NOT EXISTS(SELECT 1 FROM lab_archived_studies a WHERE a.study_id=s.study_id) ORDER BY rowid DESC LIMIT 100')};
      case 'study.create': return this.request(actor,op,d,()=>{const sid=randomUUID();const p=sampleProtocol(); this.run("INSERT INTO lab_studies VALUES (?,?,?,1,'PAUSED',?)",sid,p.title,stableJSON(p),this.now());this.audit(actor,op,sid,{});return {study_id:sid,revision:1,draft:p};});
      case 'study.get': {
        const s=this.get<{study_id:string;title:string;draft:string;revision:number;admission:string}>('SELECT * FROM lab_studies WHERE study_id=?',id(d.study_id));
        if(!s) throw new ContractError('STUDY_NOT_FOUND',404);return {...s,draft:JSON.parse(s.draft),source:this.get<{source:string}>('SELECT source FROM lab_questionnaire_sources WHERE study_id=?',s.study_id)?.source??null,versions:this.all('SELECT version_id,hash,runner_hash,created_at FROM lab_versions WHERE study_id=? ORDER BY rowid DESC',s.study_id)};
      }
      case 'study.import':return this.request(actor,op,d,()=>{
        this.barrier();const sid=id(d.study_id),s=this.get<{revision:number}>('SELECT revision FROM lab_studies WHERE study_id=?',sid);
        if(!s||s.revision!==d.revision||this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',sid))throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        if(typeof d.source!=='string')throw new ContractError('JSON_REQUIRED');
        const p=compileQuestionnaire(parseQuestionnaireText(d.source),ref=>{
          const a=this.get<{asset_id:string}>("SELECT p.asset_id FROM lab_package_images p JOIN lab_assets a USING(asset_id) WHERE p.study_id=? AND p.name=? AND p.path=? AND a.state='READY'",sid,ref.package,ref.path);
          if(!a)throw new ContractError('IMAGE_PACKAGE_REFERENCE_MISSING',409,ref);return a.asset_id;
        });
        this.validateAssets(sid,p);
        if(p.mode==='COLLECTION'&&(p.budget.environment_id==='TEST_ONLY'||!this.get('SELECT 1 FROM lab_environments WHERE environment_id=?',p.budget.environment_id)))throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        this.run('UPDATE lab_studies SET title=?,draft=?,revision=revision+1 WHERE study_id=?',p.title,stableJSON(p),sid);
        this.run('INSERT INTO lab_questionnaire_sources VALUES (?,?) ON CONFLICT(study_id) DO UPDATE SET source=excluded.source',sid,d.source);
        this.run("DELETE FROM lab_asset_refs WHERE kind='DRAFT' AND owner=?",sid);
        const assets=new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))),vid=randomUUID(),h=digest(stableJSON(p));
        this.run('INSERT INTO lab_versions VALUES (?,?,?,?,?,?,?)',vid,sid,h,stableJSON(p),this.runnerHash,RUNNER_VERSION,this.now());
        for(const asset of assets){this.run("INSERT INTO lab_asset_refs VALUES (?,'DRAFT',?)",asset,sid);this.run("INSERT INTO lab_asset_refs VALUES (?,'VERSION',?)",asset,vid);}
        this.audit(actor,op,sid,{version_id:vid,hash:h,revision:s.revision+1});return {revision:s.revision+1,frozen:this.frozen(vid)};
      });
      case 'study.delete':return this.request(actor,op,d,()=>{const sid=id(d.study_id);if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);this.run('INSERT OR IGNORE INTO lab_archived_studies VALUES (?,?)',sid,this.now());this.run("UPDATE lab_studies SET admission='PAUSED' WHERE study_id=?",sid);this.audit(actor,op,sid,{data_retained:true});return {status:'DELETED',data_retained:true};});
      case 'package.begin':return this.request(actor,op,d,()=>{this.barrier();const sid=id(d.study_id),name=packageName(d.name);
        if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid)||this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);
        if(this.get('SELECT 1 FROM lab_packages WHERE study_id=? AND name=?',sid,name))throw new ContractError('PACKAGE_NAME_EXISTS',409);
        return this.beginJob(id(d.job_id),'PACKAGE',sid,{study_id:sid,name,package_id:id(d.job_id)},actor);
      });
      case 'study.save': return this.request(actor,op,d,()=>{
        this.barrier();const sid=id(d.study_id); const p=parseProtocol(d.protocol); const revision=integer(d.revision,1);
        this.validateAssets(sid,p);const update=this.run('UPDATE lab_studies SET title=?,draft=?,revision=revision+1 WHERE study_id=? AND revision=?',p.title,stableJSON(p),sid,revision);
        if(!update.changes) throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        this.run("DELETE FROM lab_asset_refs WHERE kind='DRAFT' AND owner=?",sid);
        for(const asset of new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[])))) this.run("INSERT INTO lab_asset_refs VALUES (?,'DRAFT',?)",asset,sid);
        this.audit(actor,op,sid,{revision:revision+1});return {study_id:sid,revision:revision+1,draft:p};
      });
      case 'study.publish': return this.request(actor,op,d,()=>{
        this.barrier();const s=this.get<{draft:string;revision:number}>('SELECT * FROM lab_studies WHERE study_id=?',id(d.study_id));
        if(!s || s.revision!==d.revision) throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        const p=parseProtocol(JSON.parse(s.draft));this.validateAssets(id(d.study_id),p);
        for(const page of p.pages)for(const q of page.questions)if(q.type==='text'&&q.input_purpose!=='personal')throw new ContractError('PERSONAL_INPUT_ONLY',409,{question:q.id});
        for(const page of p.pages)for(const q of page.questions)if(q.type==='scale'&&(!q.min_label?.trim()||!q.max_label?.trim()))throw new ContractError('SCALE_ENDPOINTS_REQUIRED',409,{question:q.id});
        if(p.mode==='COLLECTION' && (p.budget.environment_id==='TEST_ONLY'||!this.get('SELECT 1 FROM lab_environments WHERE environment_id=?',p.budget.environment_id))) throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        const vid=randomUUID();const h=digest(stableJSON(p)); this.run('INSERT INTO lab_versions VALUES (?,?,?,?,?,?,?)',vid,d.study_id,h,stableJSON(p),this.runnerHash,RUNNER_VERSION,this.now());
        for(const asset of new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))))this.run("INSERT INTO lab_asset_refs VALUES (?,'VERSION',?)",asset,vid);
        this.audit(actor,op,vid,{hash:h});return this.frozen(vid);
      });
      case 'study.admission': return this.request(actor,op,d,()=>{
        if(typeof d.paused!=='boolean') throw new ContractError('INVALID_ADMISSION_STATE');
        if(this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',id(d.study_id)))throw new ContractError('STUDY_DELETED',409);
        this.run('UPDATE lab_studies SET admission=? WHERE study_id=?',d.paused?'PAUSED':'OPEN',id(d.study_id));this.audit(actor,op,String(d.study_id),{paused:d.paused});return {status:d.paused?'PAUSED':'OPEN'};
      });
      case 'asset.list': return {assets:this.all('SELECT asset_id,name,state,hash,bytes,width,height,format FROM lab_assets WHERE study_id=? ORDER BY rowid DESC LIMIT 200',id(d.study_id))};
      case 'asset.begin': return this.request(actor,op,d,()=>{
        this.barrier(); const sid=id(d.study_id);if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);
        if(typeof d.name!=='string'||d.name.length>200)throw new ContractError('INVALID_ASSET_NAME');
        const asset=randomUUID();this.run("INSERT INTO lab_assets(asset_id,study_id,name,state,upload_id,created_at) VALUES (?,?,?,'UPLOADING',?,?)",asset,sid,d.name,d.request_id,this.now());
        if(d.job_id)this.beginJob(id(d.job_id),'UPLOAD',sid,{asset_id:asset},actor);
        this.audit(actor,op,asset,{study_id:sid});return {asset_id:asset,state:'UPLOADING'};
      });
      case 'asset.delete': return this.request(actor,op,d,()=>{
        this.barrier();const asset=id(d.asset_id);
        if(this.get('SELECT 1 FROM lab_asset_refs WHERE asset_id=?',asset)||this.get('SELECT 1 FROM lab_pins WHERE asset_id=?',asset)) throw new ContractError('ASSET_REFERENCED',409);
        const a=this.get<{state:string}>('SELECT state FROM lab_assets WHERE asset_id=?',asset);if(!a)throw new ContractError('ASSET_NOT_FOUND',404);
        if(!['READY','FAILED','DELETING'].includes(a.state))throw new ContractError('ASSET_STATE_CONFLICT',409);
        this.run("UPDATE lab_assets SET state='DELETING' WHERE asset_id=?",asset);this.audit(actor,op,asset,{});return {asset_id:asset,status:'DELETING'};
      });
      case 'session.list':this.admission.stats();return {sessions:this.all('SELECT s.session_id,s.version_id,s.state,s.writer_epoch,q.status AS admission_status,s.page_index,s.group_index,s.created_at,(SELECT count(*) FROM lab_diagnostics d WHERE d.session_id=s.session_id) AS diagnostics,(SELECT max(received_at) FROM lab_raw r WHERE r.session_id=s.session_id) AS last_received FROM lab_sessions s LEFT JOIN lab_session_queue q USING(session_id) WHERE s.study_id=? ORDER BY s.rowid DESC LIMIT ? OFFSET ?',id(d.study_id),Math.min(100,Number(d.limit)||50),integer(d.offset??0))};
      case 'session.detail': {
        const sid=id(d.session_id);if(!this.get('SELECT 1 FROM lab_sessions WHERE session_id=?',sid))throw new ContractError('SESSION_NOT_FOUND',404);
        return {...this.view(sid),marks:this.all('SELECT * FROM lab_marks WHERE session_id=? ORDER BY created_at',sid),
          receipts:this.all('SELECT e.event_id,e.hash,e.scope,e.sequence,e.disposition,e.version,e.reason,r.receipt_id,r.received_at FROM lab_events e JOIN lab_raw r USING(session_id,event_id,hash) WHERE e.session_id=? ORDER BY e.scope,e.sequence LIMIT 5000',sid),
          diagnostic_evidence:this.all('SELECT code,scope,detail,created_at FROM lab_diagnostics WHERE session_id=? ORDER BY rowid',sid),covariates:this.all('SELECT * FROM lab_covariates WHERE session_id=? ORDER BY received_at',sid)};
      }
      case 'session.actions': {
        const sid=id(d.session_id),after=integer(Number(d.after??0));if(!this.get('SELECT 1 FROM lab_sessions WHERE session_id=?',sid))throw new ContractError('SESSION_NOT_FOUND',404);
        const rows=this.all<{cursor:number;envelope:string}>("SELECT rowid AS cursor,envelope FROM lab_events WHERE session_id=? AND kind='INPUT_DIAGNOSTIC' AND scope LIKE 'd-ui-%' AND rowid>? ORDER BY rowid LIMIT 20",sid,after);
        return {batches:rows.map(row=>({cursor:row.cursor,...object(parseLabEvent(row.envelope).payload.interaction)})),next:rows.at(-1)?.cursor??after,more:rows.length===20};
      }
      case 'session.mark': return this.request(actor,op,d,()=>{
        const mark=id(d.mark_id),revision=integer(d.revision,1); const prior=this.get<{n:number}>('SELECT coalesce(max(revision),0) AS n FROM lab_marks WHERE mark_id=?',mark)!.n;
        if(revision!==prior+1||typeof d.note!=='string'||d.note.length>2000||!['NOTE','REVIEW','EXCLUDE'].includes(String(d.type))||!['OPEN','CHECKED'].includes(String(d.status)))throw new ContractError('INVALID_MARK_REVISION');
        this.run('INSERT INTO lab_marks VALUES (?,?,?,?,?,?,?,?)',mark,revision,id(d.session_id),d.type,d.note,d.status,actor,this.now());return {mark_id:mark,revision};
      });
      case 'environment.list': return {environments:this.all('SELECT * FROM lab_environments ORDER BY created_at DESC')};
      case 'environment.put': return this.request(actor,op,d,()=>{
        const record=object(d.record);for(const k of ['hardware','filesystem','device_matrix','capacity_report','independent_restore_report','backup_target','rpo','rto','operator','verified_at'])
          if(typeof record[k]!=='string'||!(record[k] as string).trim())throw new ContractError('INCOMPLETE_ENVIRONMENT_RECORD');
        const env=id(d.environment_id);this.run('INSERT INTO lab_environments VALUES (?,?,?)',env,stableJSON(record),this.now());this.audit(actor,op,env,record);return {environment_id:env};
      });
      case 'gate.open': return this.request(actor,op,d,()=>{
        const env=this.get<{record:string}>('SELECT record FROM lab_environments WHERE environment_id=?',id(d.environment_id));
        if(!env||d.environment_id==='TEST_ONLY')throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        const record=object(JSON.parse(env.record));const backup=this.get<{result:string}>("SELECT result FROM lab_jobs WHERE kind='BACKUP' AND state='READY' AND job_id=?",id(record.backup_job_id));
        if(!backup||object(JSON.parse(backup.result)).independent!==true||record.restore_manifest_hash!==object(JSON.parse(backup.result)).manifest_hash||record.restore_verified!==true)throw new ContractError('INDEPENDENT_RESTORE_REQUIRED',409);
        this.run("INSERT INTO lab_meta VALUES ('collection_environment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(d.environment_id));this.run("UPDATE lab_meta SET value='OPEN' WHERE key='collection_gate'");this.audit(actor,op,String(d.environment_id),{});return {status:'OPEN'};
      });
      case 'gate.close':return this.request(actor,op,d,()=>{this.run("UPDATE lab_meta SET value='CLOSED' WHERE key='collection_gate'");this.audit(actor,op,'collection',{});return {status:'CLOSED'};});
      case 'job.list': return {jobs:this.all('SELECT * FROM lab_jobs ORDER BY created_at DESC LIMIT 100')};
      case 'job.get': return this.get('SELECT * FROM lab_jobs WHERE job_id=?',id(d.job_id))??{};
      case 'job.begin': return this.request(actor,op,d,()=>{if(d.kind==='REBUILD'){const study=id(d.study_id);if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',study)?.admission!=='PAUSED'||this.get("SELECT 1 FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND p.state='ISSUED'",study))throw new ContractError('REBUILD_REQUIRES_PAUSED_AND_IDLE',409);}return this.beginJob(id(d.job_id),String(d.kind),d.study_id? id(d.study_id):null,object(d.config??{}),actor);});
      case 'job.recover': return this.request(actor,op,d,()=>{
        const job=this.get<{state:string}>('SELECT state FROM lab_jobs WHERE job_id=?',id(d.job_id));
        if(!job||job.state!=='RECOVERY_REQUIRED'||typeof d.report!=='string'||!d.report.trim())throw new ContractError('RECOVERY_REPORT_REQUIRED');
        // Recovery only fails the old job; pins/barriers are released after the file audit route succeeds.
        this.audit(actor,'RECOVERY_REVIEW',String(d.job_id),{report:d.report});return {job_id:d.job_id,status:'RECOVERY_REVIEW',report:d.report};
      });
      default:throw new ContractError('UNKNOWN_LAB_OPERATION',404);
    }
  }
  private validateAssets(sid: string,p: Protocol) {
    for(const group of p.groups){let decoded=0;const hashes=new Set<string>(),sizes:number[]=[];
      for(const a of new Set(group.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))){const asset=this.get<{state:string;width:number;height:number;hash:string}>('SELECT state,width,height,hash FROM lab_assets WHERE asset_id=? AND study_id=?',a,sid);
        if(!asset||asset.state!=='READY')throw new ContractError('ASSET_NOT_READY',409,{asset_id:a});if(!hashes.has(asset.hash)){hashes.add(asset.hash);const bytes=asset.width*asset.height*4;decoded+=bytes;sizes.push(bytes);}
      }if(group.sampling)decoded=sizes.sort((a,b)=>b-a).slice(0,Object.values(group.sampling.allocations[0]!).reduce((n,v)=>n+v,0)).reduce((n,v)=>n+v,0);
      if(decoded>p.budget.max_decoded_bytes)throw new ContractError('RESOURCE_MEMORY_BUDGET_EXCEEDED');
    }
  }

  private skipPages(s: SessionRow,p: Protocol) {
    let index=s.page_index;const answers=JSON.parse(s.answers) as Record<string,Answer>;
    while(p.pages[index]&&!evaluate(p.pages[index]!.condition,answers)) {
      for(const q of p.pages[index]!.questions)answers[q.id]=null;index++;
    }
    this.run('UPDATE lab_sessions SET page_index=?,answers=? WHERE session_id=?',index,stableJSON(answers),s.session_id);
  }
  private reserve(s: SessionRow,p: Protocol) {
    if(s.allocation_id)return this.get<{reservation_id:string;variant_id:string;allocation_id:string}>('SELECT reservation_id,variant_id,allocation_id FROM lab_slots WHERE session_id=? AND allocation_id IS NOT NULL',s.session_id)!;
    let slot=this.get<{slot_id:string;reservation_id:string;variant_id:string;reserved_until:number}>('SELECT * FROM lab_slots WHERE session_id=? AND allocation_id IS NULL AND reserved_until>?',s.session_id,this.now());
    if(!slot) {
      this.run('UPDATE lab_slots SET session_id=NULL,reservation_id=NULL,reserved_until=NULL WHERE allocation_id IS NULL AND reserved_until<?',this.now());
      slot=this.get('SELECT * FROM lab_slots WHERE version_id=? AND session_id IS NULL ORDER BY rowid LIMIT 1',s.version_id);
      if(!slot) {
        const entries=p.variants.flatMap(v=>Array.from({length:v.weight},()=>v.id));const seed=randomBytes(16).toString('hex');const buf=Buffer.from(seed,'hex');const state=[0,4,8,12].map(i=>buf.readUInt32LE(i)) as [number,number,number,number];if(state.every(x=>x===0))state[0]=1;const rng=new Xoshiro128(state);
        // Preserve the actual shuffled block and private seed; credentials/PRNG use different random streams.
        for(let i=entries.length-1;i>0;i--){const j=sampleBounded(i+1,()=>rng.next(),p.budget.draw_budget).index;[entries[i],entries[j]]=[entries[j]!,entries[i]!];}
        const block=randomUUID();entries.forEach((variant,i)=>this.run('INSERT INTO lab_slots(slot_id,version_id,block_id,ordinal,variant_id,seed) VALUES (?,?,?,?,?,?)',randomUUID(),s.version_id,block,i,variant,seed));
        slot=this.get('SELECT * FROM lab_slots WHERE version_id=? AND session_id IS NULL ORDER BY rowid LIMIT 1',s.version_id)!;
      }
      const reservation=randomUUID();this.run('UPDATE lab_slots SET session_id=?,reservation_id=?,reserved_until=? WHERE slot_id=?',s.session_id,reservation,this.now()+300000,slot.slot_id);
      slot={...slot,reservation_id:reservation,reserved_until:this.now()+300000};
    }else{
      // Preparation can exceed five minutes on a shared low-bandwidth link.
      // A fresh, fenced request renews only a still-live reservation; expired
      // slots are reassigned through the normal path and never resurrected.
      slot.reserved_until=this.now()+300000;
      this.run('UPDATE lab_slots SET reserved_until=? WHERE slot_id=?',slot.reserved_until,slot.slot_id);
    }return {reservation_id:slot.reservation_id,variant_id:slot.variant_id,reserved_until:slot.reserved_until};
  }
  private selection(s:SessionRow,group:Protocol['groups'][number]):TrialSelection|undefined {
    if(!group.sampling)return undefined;
    const old=this.get<{selection:string}>('SELECT selection FROM lab_group_selections WHERE session_id=? AND group_id=?',s.session_id,group.id);
    if(old)return JSON.parse(old.selection) as TrialSelection;
    const bytes=randomBytes(16),seed=[0,4,8,12].map(i=>bytes.readUInt32LE(i)) as GroupPlan['seed'];if(seed.every(n=>n===0))seed[0]=1;
    const selection:TrialSelection={group_id:group.id,seed,...sampleTrials(group.trials,group.sampling,seed)};
    this.run('INSERT INTO lab_group_selections VALUES (?,?,?)',s.session_id,group.id,stableJSON(selection));return selection;
  }
  private participant(op: string,c: Command,d: Record<string,unknown>): unknown {
    const s=this.session(c),sid=s.session_id;
    if(op==='participant.reanswer') return this.request(sid,op,d,()=>{
      if(s.state!=='TERMINATED')throw new ContractError('SESSION_NOT_TERMINATED',409);
      const existing=this.get<{new_session_id:string}>('SELECT new_session_id FROM lab_reanswer_links WHERE old_session_id=?',sid);if(existing){const next=this.get<{credential_hash:string}>('SELECT credential_hash FROM lab_sessions WHERE session_id=?',existing.new_session_id)!;if(next.credential_hash!==d.credential_hash)throw new ContractError('REANSWER_ALREADY_CREATED',409);return this.view(existing.new_session_id);}
      const latest=this.get<{version_id:string}>('SELECT version_id FROM lab_versions WHERE study_id=? ORDER BY rowid DESC LIMIT 1',s.study_id)!.version_id;const oldFrozen=this.frozen(s.version_id),candidate=this.frozen(latest);const sameConsent=stableJSON(oldFrozen.protocol.consent??null)===stableJSON(candidate.protocol.consent??null);const frozen=sameConsent?candidate:oldFrozen;if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',s.study_id)!.admission!=='OPEN')throw new ContractError('ADMISSION_PAUSED',409);
      if(frozen.protocol.mode==='COLLECTION'&&(this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value!=='OPEN'||this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_environment'")?.value!==frozen.protocol.budget.environment_id))throw new ContractError('COLLECTION_GATE_CLOSED',409);
      const next=randomUUID();this.run("INSERT INTO lab_sessions(session_id,study_id,version_id,admission_id,credential_hash,state,created_at) VALUES (?,?,?,?,?,'CREATED',?)",next,s.study_id,frozen.version_id,randomUUID(),hash(String(d.credential_hash)),this.now());
      this.run('INSERT INTO lab_reanswer_links VALUES (?,?,?)',sid,next,this.now());this.run('INSERT INTO lab_consents SELECT ?,document_hash,accepted_at FROM lab_consents WHERE session_id=?',next,sid);this.run('INSERT INTO lab_marks VALUES (?,1,?,?,?,?,?,?)',randomUUID(),next,'REANSWER',`重新作答，关联原答卷 ${sid}`,'OPEN','PARTICIPANT',this.now());this.audit(sid,'participant.reanswer',next,{replaces:sid,original_retained:true});return this.view(next);
    });
    if(op==='participant.covariates')return this.request(sid,op,d,()=>{
      if(typeof d.raw!=='string'||Buffer.byteLength(d.raw)>32*1024)throw new ContractError('INVALID_COVARIATES');
      const parsed=object(JSON.parse(d.raw));if(parsed.schema!=='environment-v1')throw new ContractError('INVALID_COVARIATES');
      const sample=id(d.sample_id),h=digest(d.raw),old=this.get<{hash:string}>('SELECT hash FROM lab_covariates WHERE session_id=? AND sample_id=?',sid,sample);
      if(old&&old.hash!==h)throw new ContractError('COVARIATES_CONFLICT',409);
      if(!old){if(this.get<{n:number}>('SELECT count(*) AS n FROM lab_covariates WHERE session_id=?',sid)!.n>=50)throw new ContractError('COVARIATES_BUDGET_EXCEEDED');this.run('INSERT INTO lab_covariates VALUES (?,?,?,?,?,?)',sid,sample,h,d.raw,'client-reported',this.now());}
      return {sample_id:sample,hash:h,status:'PERSISTED'};
    });
    if(op==='participant.view')return this.view(sid);
    if(op==='participant.preparation.release')return {session_id:sid};
    if(op==='participant.ingest')return this.ingest(s,d);
    if(op==='participant.receipts'){
      if(!Array.isArray(d.events)||d.events.length>32)throw new ContractError('INVALID_RECEIPT_QUERY');return {receipts:d.events.map(eventRef).map(r=>this.custody(sid,r))};
    }
    if(op==='participant.admission'){
      const action=String(d.action),nonce=id(d.ticket_id);
      if(action==='join')return this.admission.join(sid,nonce);
      if(action==='leave')return this.admission.leave(sid,nonce);
      if(action!=='touch')throw new ContractError('INVALID_ADMISSION_ACTION');
      const result=this.admission.touch(sid,nonce);
      if(result.status==='ACTIVE'&&s.writer_id===d.writer_id&&s.writer_epoch===d.writer_epoch&&s.lease_until<this.now()+SESSION_LEASE_MS-60000)
        this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+SESSION_LEASE_MS,sid);
      return result;
    }
    if(op==='participant.activity'){
      if(['COMPLETED','TERMINATED'].includes(s.state))return {status:s.state};this.active(s,d);
      if(!this.get('SELECT 1 FROM lab_task_activity WHERE session_id=? AND writer_epoch=?',sid,s.writer_epoch))throw new ContractError('TASK_ACTIVITY_UNAVAILABLE',409);
      this.run('UPDATE lab_task_activity SET last_seen=? WHERE session_id=?',this.now(),sid);this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+300000,sid);this.admission.join(sid);return {status:'ACTIVE'};
    }
    if(!['COMPLETED','TERMINATED'].includes(s.state)&&['participant.claim','participant.reserve','participant.permit','participant.seal','participant.finalize','participant.preparation','participant.asset','participant.admission.check'].includes(op)){
      const result=this.admission.join(sid);if(result.status!=='ACTIVE')return new Rejection(new ContractError('SESSION_WAITING',409,result));
    }
    if(op==='participant.admission.check')return this.admission.view(sid);
    if(op==='participant.preparation'){
      this.active(s,d);const p=this.frozen(s.version_id).protocol;
      if(s.page_index<p.pages.length||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('PREPARATION_UNAVAILABLE',409);
      const slot=this.get<{variant_id:string}>('SELECT variant_id FROM lab_slots WHERE session_id=? AND (allocation_id IS NOT NULL OR reserved_until>?)',sid,this.now());
      if(!slot)throw new ContractError('RESERVATION_EXPIRED',409);
      const group=p.groups.find(g=>g.id===p.variants.find(v=>v.id===slot.variant_id)!.group_order[s.group_index]);
      if(!group)throw new ContractError('NO_NEXT_GROUP',409);
      const selection=this.selection(s,group);
      return {key:`${sid}:${s.writer_epoch}:${s.group_index}:${slot.variant_id}`,asset_ids:[...new Set((selection?.roots??group.trials).flatMap(t=>t.asset_id?[t.asset_id]:[]))]};
    }
    if(op==='participant.asset') {
      const asset=id(d.asset_id);if(!this.get("SELECT 1 FROM lab_asset_refs WHERE asset_id=? AND kind='VERSION' AND owner=?",asset,s.version_id))throw new ContractError('ASSET_FORBIDDEN',403);
      const info=this.get('SELECT asset_id,hash,bytes,width,height,format,state FROM lab_assets WHERE asset_id=?',asset);
      return {...info as object,runner_hash:this.get<{runner_hash:string}>('SELECT runner_hash FROM lab_versions WHERE version_id=?',s.version_id)!.runner_hash};
    }
    return this.request(sid,op,d,()=>{
      const p=this.frozen(s.version_id).protocol;
      if(op==='participant.terminate') {
        if(s.state==='COMPLETED')throw new ContractError('SESSION_TERMINAL',409);
        const reason=id(d.reason);this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);
        this.run("UPDATE lab_permits SET state=? WHERE session_id=? AND state='ISSUED'",reason==='UNKNOWN_RUN'?'CLOSED_UNKNOWN':'CLOSED_TERMINATED',sid);
        this.admission.ended(sid);this.diagnostic(sid,null,reason,d.evidence??{});return this.view(sid);
      }
      if(op==='participant.reconcile') {
        if(s.state!=='TERMINATED')throw new ContractError('SESSION_NOT_TERMINATED');const manifest=parseManifest(d.manifest,5000);
        return {status:'RECONCILED',reconciliation_id:randomUUID(),manifest,receipts:manifest.events.map(r=>this.custody(sid,r)),unknown:d.unknown??[],cleanup_allowed:false};
      }
      if(op==='participant.claim') {
        if(['COMPLETED','TERMINATED'].includes(s.state))throw new ContractError('SESSION_TERMINAL',409);
        const writer=id(d.writer_id);if(s.writer_id!==writer&&(s.lease_until>this.now()||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid)))throw new ContractError('RUN_LOCKED',409);
        const epoch=s.writer_id===writer?s.writer_epoch:s.writer_epoch+1;
        this.run("UPDATE lab_sessions SET writer_id=?,writer_epoch=?,lease_until=?,state='ACTIVE' WHERE session_id=?",writer,epoch,this.now()+SESSION_LEASE_MS,sid);
        this.run('INSERT OR IGNORE INTO lab_writers VALUES (?,?,?)',sid,epoch,writer);this.skipPages(s,p);return this.view(sid);
      }
      this.active(s,d);
      if(op==='participant.release') {
        if(this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('RUN_LOCKED',409);
        this.run('UPDATE lab_sessions SET lease_until=0 WHERE session_id=?',sid);return {status:'RELEASED'};
      }
      if(op==='participant.reserve') {
        if(s.page_index<p.pages.length)throw new ContractError('PAGES_NOT_SEALED',409);
        if(this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('RUN_LOCKED',409);
        this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+300000,sid);
        const reservation=this.reserve(s,p),variant=p.variants.find(v=>v.id===reservation.variant_id)!,group=p.groups.find(g=>g.id===variant.group_order[s.group_index]);
        const selection=group?this.selection(s,group):undefined;
        return {...reservation,...(selection?{selection}:{})};
      }
      if(op==='participant.permit') {
        if(this.frozen(s.version_id).runner_version!==RUNNER_VERSION)throw new ContractError('RUNNER_VERSION_UNAVAILABLE',409);
        if(s.page_index<p.pages.length||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('PREVIOUS_STAGE_UNSEALED',409);
        const slot=this.get<{variant_id:string;reservation_id:string;reserved_until:number;allocation_id:string|null;slot_id:string}>('SELECT * FROM lab_slots WHERE session_id=? AND reservation_id=?',sid,id(d.reservation_id));
        if(!slot||(!slot.allocation_id&&slot.reserved_until<this.now()))throw new ContractError('RESERVATION_EXPIRED',409);
        const readiness=object(d.readiness),frame=Number(readiness.frame_ms);
        if(!Number.isFinite(frame)||1000/frame<p.budget.refresh_min_hz||1000/frame>p.budget.refresh_max_hz
          ||readiness.protocol_hash!==this.frozen(s.version_id).hash||typeof readiness.commit_ms!=='number'||!Number.isFinite(readiness.commit_ms)||readiness.commit_ms<0||readiness.commit_ms>p.budget.commit_ms
          ||!['portrait','landscape'].includes(String(readiness.layout)))throw new ContractError('ENVIRONMENT_NOT_READY',409);
        const geometry=object(readiness.geometry),viewport=object(geometry.viewport),canvas=object(geometry.canvas);
        const positive=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>0;
        const coordinate=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
        const inside=(b:Record<string,unknown>)=>coordinate(b.x)&&coordinate(b.y)&&positive(b.width)&&positive(b.height)&&Number(b.x)+Number(b.width)<=Number(viewport.width)+1&&Number(b.y)+Number(b.height)<=Number(viewport.height)+1;
        if(!positive(viewport.width)||!positive(viewport.height)||!positive(viewport.dpr)||!inside(canvas)||Number(canvas.width)<(readiness.layout==='portrait'?p.layout.portrait_min_width:p.layout.landscape_min_width)||Math.abs(Number(canvas.width)/Number(canvas.height)-p.layout.aspect)>.01||!Array.isArray(geometry.buttons))throw new ContractError('INVALID_GEOMETRY');
        const variant=p.variants.find(v=>v.id===slot.variant_id)!;const group=p.groups.find(g=>g.id===variant.group_order[s.group_index]);if(!group)throw new ContractError('NO_NEXT_GROUP');
        if(geometry.buttons.length!==group.choices.length||geometry.buttons.some((v,i)=>{const b=object(v);return b.choice!==group.choices[i]||!inside(b)||Number(b.height)<44;}))throw new ContractError('INVALID_GEOMETRY');
        const selection=this.selection(s,group);
        const roots=selection?.roots??variant.trial_order[group.id]!.map(root=>group.trials.find(t=>t.root_id===root)!);
        const assetHashes=object(readiness.assets);for(const t of roots){if(!t.asset_id)continue;const a=this.get<{hash:string;state:string}>('SELECT hash,state FROM lab_assets WHERE asset_id=?',t.asset_id)!;if(a.state!=='READY'||assetHashes[t.asset_id]!==a.hash)throw new ContractError('RESOURCE_NOT_READY',409);}
        const seed=randomBytes(16);const dv=new DataView(seed.buffer,seed.byteOffset,seed.byteLength);const state=selection?.seed??[0,4,8,12].map(i=>dv.getUint32(i,true)) as GroupPlan['seed'];if(state.every(v=>v===0))state[0]=1;
        const design=group.rating?{roots:roots.map(t=>({...t,isi_ms:Math.ceil(t.isi_ms/frame)*frame}))}:realizeTrials(group,roots,state,frame);
        const scope=`g-${randomUUID()}`;const start=Math.max(1000,p.budget.commit_ms+p.budget.activate_ms+p.budget.margin_ms+1);const plan:GroupPlan={group_id:group.id,scope,seed:state,...design,...(group.response_keys?{response_keys:group.response_keys}:{}),...(group.feedback?{feedback:group.feedback}:{}),choices:group.choices,repeats:group.repeats,start,frame_ms:frame,layout:String(readiness.layout),budget:p.budget,geometry:geometry as unknown as NonNullable<GroupPlan['geometry']>};
        if(group.rating)plan.rating=group.rating;if(selection)plan.sampling=selection.sampling;
        if(plan.roots.reduce((n,t)=>n+(t.image_ms+t.isi_ms+(t.feedback_ms??0))*(plan.repeats+1),0)>p.budget.max_group_ms)throw new ContractError('QUANTIZED_GROUP_BUDGET_EXCEEDED',409);
        const allocation=slot.allocation_id??randomUUID();if(!slot.allocation_id){this.run('UPDATE lab_slots SET allocation_id=? WHERE slot_id=?',allocation,slot.slot_id);this.run('UPDATE lab_sessions SET allocation_id=? WHERE session_id=?',allocation,sid);}
        const permit=randomUUID();this.run("INSERT INTO lab_permits VALUES (?,?,?,?,?,?,?,?, 'ISSUED')",permit,sid,scope,group.id,s.writer_epoch,stableJSON(plan),digest(stableJSON(plan)),stableJSON(readiness));if(readiness.activity_policy==='idle120-offline300-v1')this.run('INSERT INTO lab_task_activity VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET writer_epoch=excluded.writer_epoch,last_seen=excluded.last_seen',sid,s.writer_epoch,this.now());return this.view(sid).permit;
      }
      if(op==='participant.seal')return this.seal(s,d,p);
      if(op==='participant.finalize') {
        const view=this.view(sid);if(s.page_index<p.pages.length||s.group_index<p.groups.length||view.permit?.state==='ISSUED'||view.diagnostics.length)return {status:'WAITING',reason:'PATH_OR_INTEGRITY_NOT_CONFIRMED'};
        if(!Array.isArray(d.seal_ids)||stableJSON([...d.seal_ids].sort())!==stableJSON(view.seals.map(s=>s.seal_id).sort()))throw new ContractError('COMPLETION_MANIFEST_MISMATCH');
        const completion={completion_id:randomUUID(),session_id:sid,seal_ids:d.seal_ids,path:view.path,status:'COMPLETED'};
        this.run("UPDATE lab_sessions SET state='COMPLETED',completion=? WHERE session_id=?",JSON.stringify(completion),sid);this.admission.ended(sid);return completion;
      }
      throw new ContractError('UNKNOWN_PARTICIPANT_OPERATION',404);
    });
  }
  private seal(s:SessionRow,d:Record<string,unknown>,p:Protocol) {
    const manifest=parseManifest(d.manifest,5000);const h=digest(manifestText(manifest));
    const old=this.get<{manifest_hash:string;response:string}>('SELECT * FROM lab_seals WHERE session_id=? AND scope=?',s.session_id,manifest.scope);
    if(old){if(old.manifest_hash!==h)throw new ContractError('SEAL_CONFLICT',409);return JSON.parse(old.response);}
    const refs=this.all<{event_id:string;hash:string;disposition:string;writer_epoch:number;kind:string}>('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence',s.session_id,manifest.scope);
    const received=new Set(refs.map(r=>`${r.event_id}:${r.hash}`)),declared=new Set(manifest.events.map(r=>`${r.event_id}:${r.hash}`));
    const missing=manifest.events.filter(r=>!received.has(`${r.event_id}:${r.hash}`));
    const extra=refs.filter(r=>!declared.has(`${r.event_id}:${r.hash}`));
    if(missing.length||extra.length||refs.some(e=>e.disposition!=='ACCEPTED'||e.writer_epoch!==s.writer_epoch)||this.get('SELECT 1 FROM lab_diagnostics WHERE session_id=? AND scope=?',s.session_id,manifest.scope))return {status:'WAITING',missing,extra,reason:'INTEGRITY_UNCONFIRMED'};
    const page=p.pages[s.page_index]; const path=JSON.parse(s.path) as string[];
    if(page?.id===manifest.scope) {
      if(!refs.length||refs.at(-1)!.kind!=='PAGE_SNAPSHOT'||refs.slice(0,-1).some(e=>e.kind!=='PAGE_REVISION')||stableJSON(manifest.path)!==stableJSON([...path,page.id]))throw new ContractError('PAGE_MANIFEST_MISMATCH');
      const e=this.get<{envelope:string}>('SELECT envelope FROM lab_events WHERE session_id=? AND event_id=?',s.session_id,refs.at(-1)!.event_id)!;
      const supplied=object(parseLabEvent(e.envelope).payload.answers) as Record<string,Answer>;const answers=JSON.parse(s.answers) as Record<string,Answer>;
      const snap=pageSnapshot(page,answers,supplied);for(const [k,v]of Object.entries(snap))answers[k]=v.answer;
      path.push(page.id);this.run('UPDATE lab_sessions SET page_index=page_index+1,answers=?,path=? WHERE session_id=?',stableJSON(answers),stableJSON(path),s.session_id);
      this.skipPages({...s,page_index:s.page_index+1,answers:stableJSON(answers)},p);
    } else {
      const permit=this.get<{permit_id:string;group_id:string;state:string}>('SELECT * FROM lab_permits WHERE session_id=? AND scope=?',s.session_id,manifest.scope);
      if(!permit||permit.state!=='ISSUED')throw new ContractError('OUTSIDE_PERMIT',409);
      const proof=this.get<{kind:string;state:string;result:string}>('SELECT * FROM lab_jobs WHERE job_id=?',id(d.proof_job_id));
      if(!proof||proof.kind!=='REPLAY'||proof.state!=='READY')throw new ContractError('REPLAY_REQUIRED',409);
      const result=object(JSON.parse(proof.result));const source=digest(stableJSON(refs));
      if(result.session_id!==s.session_id||result.scope!==manifest.scope||result.source_hash!==source||result.valid!==true)throw new ContractError('REPLAY_PROOF_STALE_OR_INVALID',409);
      path.push(permit.group_id);if(stableJSON(manifest.path)!==stableJSON(path))throw new ContractError('GROUP_PATH_MISMATCH');
      this.run("UPDATE lab_permits SET state='CLOSED_NORMAL' WHERE permit_id=?",permit.permit_id);this.run('UPDATE lab_sessions SET group_index=group_index+1,path=? WHERE session_id=?',stableJSON(path),s.session_id);
    }
    const seal:Seal={seal_id:randomUUID(),manifest,manifest_hash:h,algorithm:'exact-set-and-chain-v1',status:'SEALED'};
    this.run('INSERT INTO lab_seals VALUES (?,?,?,?,?)',s.session_id,manifest.scope,seal.seal_id,h,JSON.stringify(seal));return seal;
  }
  beginJob(job:string,kind:string,study:string|null,config:Record<string,unknown>,actor='SYSTEM') {
    if(!['UPLOAD','PACKAGE','DELETE','EXPORT','BACKUP','REPLAY','REBUILD'].includes(kind))throw new ContractError('INVALID_JOB_KIND');
    if(this.get("SELECT 1 FROM lab_jobs WHERE state IN ('RUNNING','RECOVERY_REQUIRED')"))throw new ContractError('MAINTENANCE_BUSY',503);
    this.run("INSERT INTO lab_jobs VALUES (?,?,?,'RUNNING','REGISTERED',?,NULL,NULL,?,?)",job,kind,study,stableJSON(config),this.now(),this.now());
    if(kind==='BACKUP'){this.barrier();this.run("UPDATE lab_meta SET value=? WHERE key='resource_barrier'",job);}
    this.audit(actor,'JOB_BEGIN',job,{kind,study});return {job_id:job,status:'RUNNING'};
  }
  private internal(op:string,d:Record<string,unknown>):unknown {
    switch(op){
      case 'internal.package.ready':{
        this.barrier();const sid=id(d.study_id),name=packageName(d.name);if(!Array.isArray(d.images)||!d.images.length||d.images.length>100)throw new ContractError('INVALID_PACKAGE');
        this.run('INSERT INTO lab_packages VALUES (?,?,?,?)',sid,name,hash(d.hash),id(d.job_id));
        for(const v of d.images){const a=object(v),asset=id(a.asset_id);this.run("INSERT INTO lab_assets VALUES (?,?,?,'READY',?,?,?,?,?,?,?)",asset,sid,`${name}/${a.path}`,hash(a.hash),integer(a.bytes,1),integer(a.width,1),integer(a.height,1),String(a.format),asset,this.now());this.run('INSERT INTO lab_package_images VALUES (?,?,?,?)',sid,name,a.path,asset);this.run("INSERT INTO lab_asset_refs VALUES (?,'PACKAGE',?)",asset,id(d.job_id));}
        return {status:'READY'};
      }
      case 'internal.job.begin':return this.beginJob(id(d.job_id),String(d.kind),d.study_id?id(d.study_id):null,object(d.config??{}));
      case 'internal.job.phase':this.run('UPDATE lab_jobs SET phase=?,updated_at=? WHERE job_id=? AND state=\'RUNNING\'',id(d.phase),this.now(),id(d.job_id));return {status:'ok'};
      case 'internal.job.finish':{
        const job=id(d.job_id);if(!['READY','FAILED','RECOVERY_REQUIRED'].includes(String(d.state)))throw new ContractError('INVALID_JOB_STATE');
        if(!this.get("SELECT 1 FROM lab_jobs WHERE job_id=? AND state IN ('RUNNING','RECOVERY_REQUIRED')",job))throw new ContractError('JOB_TERMINAL',409);
        this.run('UPDATE lab_jobs SET state=?,phase=?,result=?,error=?,updated_at=? WHERE job_id=?',d.state,String(d.state),d.result?stableJSON(d.result):null,d.error?String(d.error).slice(0,300):null,this.now(),job);
        if(d.state==='READY'||(d.state==='FAILED'&&d.release_verified===true)){
          this.run('DELETE FROM lab_pins WHERE job_id=?',job);this.run("UPDATE lab_meta SET value='' WHERE key='resource_barrier' AND value=?",job);
        }return {job_id:job,state:d.state};
      }
      case 'internal.job.interrupted':this.run("UPDATE lab_jobs SET state='RECOVERY_REQUIRED',phase='INTERRUPTED' WHERE state='RUNNING'");return {status:'ok'};
      case 'internal.backup.pin':{
        const job=id(d.job_id);if(this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='resource_barrier'")!.value!==job)throw new ContractError('BACKUP_BARRIER_NOT_HELD');
        if(!Array.isArray(d.assets)||d.assets.length>10000)throw new ContractError('INVALID_BACKUP_MANIFEST');
        for(const x of d.assets){const a=object(x);const current=this.get<{state:string;hash:string}>('SELECT state,hash FROM lab_assets WHERE asset_id=?',id(a.asset_id));
          if(!current||current.state!=='READY'||current.hash!==hash(a.hash))throw new ContractError('BACKUP_ASSET_UNAVAILABLE');this.run('INSERT INTO lab_pins VALUES (?,?)',a.asset_id,job);}
        this.run("UPDATE lab_meta SET value='' WHERE key='resource_barrier' AND value=?",job);return {status:'PINNED'};
      }
      case 'internal.asset.ready':{
        this.barrier();const info=object(d.info);const asset=id(d.asset_id);this.run("UPDATE lab_assets SET state='READY',hash=?,bytes=?,width=?,height=?,format=? WHERE asset_id=? AND state='UPLOADING'",hash(info.hash),integer(info.bytes,1),integer(info.width,1),integer(info.height,1),String(info.format),asset);return {asset_id:asset,status:'READY'};
      }
      case 'internal.asset.failed':this.run("UPDATE lab_assets SET state='FAILED' WHERE asset_id=? AND state='UPLOADING'",id(d.asset_id));return {status:'FAILED'};
      case 'internal.asset.purged':this.run("UPDATE lab_assets SET state='PURGED' WHERE asset_id=? AND state='DELETING'",id(d.asset_id));return {status:'PURGED'};
      case 'internal.projection.publish':{const generation=id(d.job_id);if(!Array.isArray(d.projections))throw new ContractError('INVALID_PROJECTIONS');for(const item of d.projections){const p=object(item);this.run('INSERT INTO lab_projections VALUES (?,?,?,?,?,?)',generation,id(p.session_id),id(p.scope),hash(p.source_hash),'run-replay-v1',stableJSON(p.result));}this.run("INSERT INTO lab_meta VALUES ('active_projection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",generation);this.audit('SYSTEM','PROJECTION_PUBLISHED',generation,{count:d.projections.length});return {generation};}
      case 'internal.job.get':return this.get('SELECT * FROM lab_jobs WHERE job_id=?',id(d.job_id));
      case 'internal.operations':return {admission:this.admission.stats(),gate:this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value,barrier:this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='resource_barrier'")!.value,
        sessions:this.all('SELECT state,count(*) AS count FROM lab_sessions GROUP BY state'),dispositions:this.all('SELECT disposition,count(*) AS count FROM lab_events GROUP BY disposition'),open_permits:this.get("SELECT count(*) AS count FROM lab_permits WHERE state='ISSUED'"),jobs:this.all("SELECT job_id,kind,state,phase,error FROM lab_jobs WHERE state IN ('RUNNING','RECOVERY_REQUIRED')"),last_backup:this.get("SELECT job_id,updated_at,result FROM lab_jobs WHERE kind='BACKUP' AND state='READY' ORDER BY updated_at DESC LIMIT 1")??null};
      case 'internal.asset.info':return this.get('SELECT * FROM lab_assets WHERE asset_id=?',id(d.asset_id));
      default:throw new ContractError('UNKNOWN_INTERNAL_OPERATION');
    }
  }
}
