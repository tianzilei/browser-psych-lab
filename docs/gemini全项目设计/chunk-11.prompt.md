全项目设计讨论，传输段 11，源码主题：数据库、RPC、认证及准入（源包 4/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

 state TEXT NOT NULL CHECK(state IN ('UPLOADING','READY','FAILED','DELETING','PURGED')),hash TEXT,bytes INTEGER,width INTEGER,height INTEGER,format TEXT,
 upload_id TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_asset_refs(asset_id TEXT NOT NULL REFERENCES lab_assets,kind TEXT NOT NULL,owner TEXT NOT NULL,
 PRIMARY KEY(asset_id,kind,owner)) STRICT;
CREATE TABLE IF NOT EXISTS lab_pins(asset_id TEXT NOT NULL REFERENCES lab_assets,job_id TEXT NOT NULL,PRIMARY KEY(asset_id,job_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_requests(subject TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT,
 PRIMARY KEY(subject,operation,request_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_sessions(session_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,
 version_id TEXT NOT NULL REFERENCES lab_versions,admission_id TEXT UNIQUE NOT NULL,credential_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CREATED','ACTIVE','FINALIZING','COMPLETED','TERMINATED')),writer_id TEXT,writer_epoch INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,page_index INTEGER NOT NULL DEFAULT 0,group_index INTEGER NOT NULL DEFAULT 0,
 answers TEXT NOT NULL DEFAULT '{}',path TEXT NOT NULL DEFAULT '[]',allocation_id TEXT,completion TEXT,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_reanswer_links(old_session_id TEXT PRIMARY KEY REFERENCES lab_sessions,new_session_id TEXT UNIQUE NOT NULL REFERENCES lab_sessions,created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS lab_reanswer_links_update BEFORE UPDATE ON lab_reanswer_links BEGIN SELECT RAISE(ABORT,'immutable reanswer link'); END;
CREATE TRIGGER IF NOT EXISTS lab_reanswer_links_delete BEFORE DELETE ON lab_reanswer_links BEGIN SELECT RAISE(ABORT,'immutable reanswer link'); END;
CREATE TABLE IF NOT EXISTS lab_writers(session_id TEXT NOT NULL REFERENCES lab_sessions,epoch INTEGER NOT NULL,writer_id TEXT NOT NULL,
 PRIMARY KEY(session_id,epoch)) STRICT;
CREATE TABLE IF NOT EXISTS lab_session_queue(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT UNIQUE NOT NULL REFERENCES lab_sessions,
 ticket_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('QUEUED','ACTIVE','EXPIRED','LEFT','ENDED')),lease_until INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS lab_session_queue_status ON lab_session_queue(status,ordinal);
CREATE TABLE IF NOT EXISTS lab_slots(slot_id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES lab_versions,
 block_id TEXT NOT NULL,ordinal INTEGER NOT NULL,variant_id TEXT NOT NULL,seed TEXT NOT NULL,session_id TEXT,reservation_id TEXT,
 reserved_until INTEGER,allocation_id TEXT UNIQUE,UNIQUE(version_id,block_id,ordinal)) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_allocation ON lab_slots(session_id) WHERE allocation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS lab_permits(permit_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,
 group_id TEXT NOT NULL,writer_epoch INTEGER NOT NULL,plan TEXT NOT NULL,plan_hash TEXT NOT NULL,readiness TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ISSUED','CLOSED_NORMAL','CLOSED_TERMINATED','CLOSED_UNKNOWN')),UNIQUE(session_id,scope)) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_permit ON lab_permits(session_id) WHERE state='ISSUED';
CREATE TABLE IF NOT EXISTS lab_raw(session_id TEXT NOT NULL REFERENCES lab_sessions,event_id TEXT NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,
 receipt_id TEXT UNIQUE NOT NULL,raw BLOB NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(session_id,event_id,hash)) STRICT;
CREATE TABLE IF NOT EXISTS lab_events(session_id TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,sequence INTEGER NOT NULL,
 writer_epoch INTEGER NOT NULL,kind TEXT NOT NULL,envelope TEXT NOT NULL,disposition TEXT NOT NULL,version INTEGER NOT NULL,reason TEXT NOT NULL,
 PRIMARY KEY(session_id,event_id),FOREIGN KEY(session_id,event_id,hash) REFERENCES lab_raw(session_id,event_id,hash)) STRICT;
CREATE INDEX IF NOT EXISTS lab_events_scope ON lab_events(session_id,scope,sequence);
CREATE TABLE IF NOT EXISTS lab_dispositions(receipt_id TEXT NOT NULL REFERENCES lab_raw(receipt_id),version INTEGER NOT NULL,
 disposition TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(receipt_id,version)) STRICT;
CREATE TABLE IF NOT EXISTS lab_seals(session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,seal_id TEXT UNIQUE NOT NULL,
 manifest_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(session_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS lab_diagnostics(diagnostic_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES lab_sessions,
 scope TEXT,code TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_marks(mark_id TEXT NOT NULL,revision INTEGER NOT NULL,session_id TEXT NOT NULL REFERENCES lab_sessions,
 type TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(mark_id,revision)) STRICT;
CREATE TABLE IF NOT EXISTS lab_audit(audit_id TEXT PRIMARY KEY,actor TEXT NOT NULL,operation TEXT NOT NULL,subject TEXT NOT NULL,
 detail TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_jobs(job_id TEXT PRIMARY KEY,kind TEXT NOT NULL,study_id TEXT,state TEXT NOT NULL,
 phase TEXT NOT NULL,config TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_job ON lab_jobs((1)) WHERE state IN ('RUNNING','RECOVERY_REQUIRED');
CREATE TABLE IF NOT EXISTS lab_projections(generation_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,source_hash TEXT NOT NULL,algorithm TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(generation_id,session_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS lab_environments(environment_id TEXT PRIMARY KEY,record TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS lab_versions_update BEFORE UPDATE ON lab_versions BEGIN SELECT RAISE(ABORT,'immutable protocol'); END;
CREATE TRIGGER IF NOT EXISTS lab_versions_delete BEFORE DELETE ON lab_versions BEGIN SELECT RAISE(ABORT,'immutable protocol'); END;
CREATE TRIGGER IF NOT EXISTS lab_raw_update BEFORE UPDATE ON lab_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS lab_raw_delete BEFORE DELETE ON lab_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS lab_events_update BEFORE UPDATE OF session_id,event_id,hash,scope,sequence,writer_epoch,kind,envelope ON lab_events BEGIN SELECT RAISE(ABORT,'immutable envelope'); END;
CREATE TRIGGER IF NOT EXISTS lab_seals_update BEFORE UPDATE ON lab_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS lab_seals_delete BEFORE DELETE ON lab_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS lab_disposition_update BEFORE UPDATE ON lab_dispositions BEGIN SELECT RAISE(ABORT,'immutable disposition'); END;
CREATE TRIGGER IF NOT EXISTS lab_disposition_delete BEFORE DELETE ON lab_dispositions BEGIN SELECT RAISE(ABORT,'immutable disposition'); END;
CREATE TRIGGER IF NOT EXISTS lab_terminal BEFORE UPDATE OF state ON lab_sessions WHEN OLD.state IN ('COMPLETED','TERMINATED') AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'irreversible session'); END;
CREATE TRIGGER IF NOT EXISTS lab_permit_terminal BEFORE UPDATE OF state ON lab_permits WHEN OLD.state<>'ISSUED' AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'irreversible permit'); END;
CREATE TRIGGER IF NOT EXISTS lab_diagnostics_update BEFORE UPDATE ON lab_diagnostics BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_diagnostics_delete BEFORE DELETE ON lab_diagnostics BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_marks_update BEFORE UPDATE ON lab_marks BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_marks_delete BEFORE DELETE ON lab_marks BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_audit_update BEFORE UPDATE ON lab_audit BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_audit_delete BEFORE DELETE ON lab_audit BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_writers_update BEFORE UPDATE ON lab_writers BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_writers_delete BEFORE DELETE ON lab_writers BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_environments_update BEFORE UPDATE ON lab_environments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_environments_delete BEFORE DELETE ON lab_environments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
`;

```

### src/server/session-admission.ts L1–L61

```
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {ContractError} from '../shared/contract.js';
import type {SessionAdmissionStatus} from '../shared/lab-contract.js';
interface Entry {ordinal:number;session_id:string;ticket_id:string;status:SessionAdmissionStatus['status'];lease_until:number}
export const SESSION_LEASE_MS=5*60000;
// Admission leases are durable. An ISSUED permit pins a slot regardless of
// elapsed time, including offline runs and unconfirmed process interruption.
export class SessionAdmission {
  constructor(private db:Database.Database,readonly limit=2,private now=Date.now){
    if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('INVALID_SESSION_CONCURRENCY');
    db.transaction(()=>{
      for(const row of db.prepare("SELECT s.session_id FROM lab_sessions s WHERE s.state NOT IN ('COMPLETED','TERMINATED') AND EXISTS(SELECT 1 FROM lab_permits p WHERE p.session_id=s.session_id AND p.state='ISSUED') ORDER BY s.rowid").all() as {session_id:string}[]){
        db.prepare("INSERT INTO lab_session_queue(session_id,ticket_id,status,lease_until) VALUES (?,?,'ACTIVE',?) ON CONFLICT(session_id) DO UPDATE SET status='ACTIVE'").run(row.session_id,randomUUID(),this.now()+SESSION_LEASE_MS);
      }
    }).immediate();
  }
  private entry(sid:string){return this.db.prepare('SELECT * FROM lab_session_queue WHERE session_id=?').get(sid) as Entry|undefined;}
  private limited(sid:string){const row=this.db.prepare("SELECT json_array_length(v.protocol,'$.groups') AS n FROM lab_sessions s JOIN lab_versions v ON v.version_id=s.version_id WHERE s.session_id=?").get(sid) as {n:number};return row.n>0;}
  private entries(status:string){return this.db.prepare("SELECT q.* FROM lab_session_queue q JOIN lab_sessions s USING(session_id) JOIN lab_versions v USING(version_id) WHERE q.status=? AND json_array_length(v.protocol,'$.groups')>0 ORDER BY q.ordinal").all(status) as Entry[];}
  private terminal(sid:string){const row=this.db.prepare('SELECT state FROM lab_sessions WHERE session_id=?').get(sid) as {state:string};return ['COMPLETED','TERMINATED'].includes(row.state);}
  private pinned(sid:string){return !!this.db.prepare("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'").get(sid);}
  private sweep(){
    this.db.prepare("UPDATE lab_session_queue SET status='ENDED' WHERE status IN ('ACTIVE','QUEUED') AND session_id IN (SELECT session_id FROM lab_sessions WHERE state IN ('COMPLETED','TERMINATED'))").run();
    this.db.prepare("UPDATE lab_session_queue SET status='EXPIRED' WHERE status IN ('ACTIVE','QUEUED') AND lease_until<=? AND NOT EXISTS(SELECT 1 FROM lab_permits p WHERE p.session_id=lab_session_queue.session_id AND p.state='ISSUED')").run(this.now());
    // Retire legacy waiting tickets. Their sessions and raw answers stay intact;
    // they must explicitly retry rather than starting automatically later.
    this.db.prepare("UPDATE lab_session_queue SET status='LEFT',lease_until=0 WHERE status='QUEUED'").run();
  }
  private describe(row:Entry|undefined):SessionAdmissionStatus{
    return {status:row?.status??'LEFT',ticket_id:row?.ticket_id??null,position:0,limit:row&&!this.limited(row.session_id)?null:this.limit,poll_ms:60000,lease_until:row?.lease_until??0,lease_remaining_ms:Math.max(0,(row?.lease_until??0)-this.now()),pinned:row?this.pinned(row.session_id):false};
  }
  view(sid:string){return this.describe(this.entry(sid));}
  join(sid:string,nonce?:string){
    this.sweep();if(this.terminal(sid))return {...this.view(sid),status:'ENDED' as const};
    let row=this.entry(sid);const ticket=nonce??row?.ticket_id??randomUUID();
    if(!row||row.status!=='ACTIVE'){
      if(this.limited(sid)&&this.entries('ACTIVE').length>=this.limit)throw new ContractError('SESSION_CAPACITY_FULL',409,{retry_after_seconds:1800});
      this.db.prepare('DELETE FROM lab_session_queue WHERE session_id=?').run(sid);
      this.db.prepare("INSERT INTO lab_session_queue(session_id,ticket_id,status,lease_until) VALUES (?,?,'ACTIVE',?)").run(sid,ticket,this.now()+SESSION_LEASE_MS);
    }else if(row.ticket_id!==ticket)this.db.prepare('UPDATE lab_session_queue SET ticket_id=? WHERE session_id=?').run(ticket,sid);
    this.renew(sid);this.sweep();row=this.entry(sid);return this.describe(row);
  }
  private renew(sid:string){
    // Polling normally reads only; at most one lease UPDATE per minute.
    this.db.prepare("UPDATE lab_session_queue SET lease_until=? WHERE session_id=? AND status IN ('ACTIVE','QUEUED') AND lease_until<=?").run(this.now()+SESSION_LEASE_MS,sid,this.now()+SESSION_LEASE_MS-60000);
  }
  touch(sid:string,nonce:string){
    this.sweep();const row=this.entry(sid);if(!row||row.ticket_id!==nonce)throw new ContractError('SESSION_QUEUE_FENCED',409);
    this.renew(sid);return this.describe(this.entry(sid));
  }
  leave(sid:string,nonce:string){
    const row=this.entry(sid);if(row?.ticket_id!==nonce)return {status:'LEFT' as const};