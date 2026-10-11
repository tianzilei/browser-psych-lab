全项目设计讨论，传输段 13，源码主题：研究和参加者事务（源包 5/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/lab-store.ts L1–L392

```
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