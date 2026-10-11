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
    if(this.pinned(sid))throw new ContractError('RUN_LOCKED',409);
    this.db.prepare("UPDATE lab_session_queue SET status='LEFT',lease_until=0 WHERE session_id=?").run(sid);this.sweep();return {status:'LEFT' as const};
  }
  ended(sid:string){this.db.prepare("UPDATE lab_session_queue SET status='ENDED',lease_until=0 WHERE session_id=?").run(sid);this.sweep();}
  stats(){this.sweep();const rows=this.db.prepare("SELECT status,count(*) AS n FROM lab_session_queue WHERE status IN ('ACTIVE','QUEUED') GROUP BY status").all() as {status:string;n:number}[];
    const active=rows.find(r=>r.status==='ACTIVE')?.n??0;const limitedActive=this.entries('ACTIVE').length;return {active,unlimited_active:active-limitedActive,limited_active:limitedActive,queued:0,limit:this.limit,capacity:this.limit,over_limit:Math.max(0,limitedActive-this.limit),pinned:(this.db.prepare("SELECT count(*) AS n FROM lab_session_queue q WHERE q.status='ACTIVE' AND EXISTS(SELECT 1 FROM lab_permits p WHERE p.session_id=q.session_id AND p.state='ISSUED')").get() as {n:number}).n};}
}
