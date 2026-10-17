import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.js';
import {LAB_SQL} from './lab-schema.js';
import {decodeRaw,encodeRaw,verifyEvidence,RAW_REFERENCE,EVIDENCE_STORAGE} from './evidence-storage.js';

// Offline, reversible physical representation change. No event is reserialized.
export function evidenceProof(db:Database.Database){
  const verified=verifyEvidence(db),proof=createHash('sha256');
  for(const row of db.prepare('SELECT * FROM lab_raw ORDER BY rowid').iterate() as Iterable<Record<string,unknown>>){
    const {raw,...metadata}=row,decoded=decodeRaw(raw as Buffer,String(row.hash));
    proof.update(JSON.stringify(metadata));proof.update(`\0${decoded.length}\0`);proof.update(decoded);
  }
  for(const row of db.prepare('SELECT e.*,r.raw FROM lab_events e JOIN lab_raw r USING(session_id,event_id,hash) ORDER BY e.rowid').iterate() as Iterable<Record<string,unknown>>){
    const {raw,...metadata}=row;metadata.envelope=decodeRaw(raw as Buffer,String(row.hash)).toString('utf8');proof.update(JSON.stringify(metadata));
  }
  return {...verified,proof:proof.digest('hex')};
}
export function compactEvidence(db:Database.Database,mode:'compact'|'expand'='compact',vacuum=true){
  const owner=randomUUID();let leased=false,before:ReturnType<typeof evidenceProof>|undefined,after:ReturnType<typeof evidenceProof>|undefined;
  try{
    db.transaction(()=>{
      const existing=db.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get() as {value:string}|undefined;
      if(existing){const previous=JSON.parse(existing.value) as {pid:number};let alive=true;
        try{process.kill(previous.pid,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
        if(alive)throw new Error('STOP_SERVER_BEFORE_EVIDENCE_MIGRATION');}
      const schema=(db.prepare("SELECT value FROM lab_meta WHERE key='schema'").get() as {value:string}|undefined)?.value;
      if(!['1','2'].includes(schema??''))throw new Error('UNSUPPORTED_LAB_SCHEMA');
      if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw new Error('INVALID_EVIDENCE_DATABASE');
      before=evidenceProof(db);
      if(mode==='compact')db.exec(LAB_SQL);
      const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('lab_raw_update','lab_events_update') ORDER BY name").all() as {name:string;sql:string}[];
      if(triggers.length!==2)throw new Error('EVIDENCE_IMMUTABILITY_TRIGGERS_MISSING');
      db.exec('DROP TRIGGER lab_raw_update; DROP TRIGGER lab_events_update');
      const update=db.prepare('UPDATE lab_raw SET raw=? WHERE session_id=? AND event_id=? AND hash=?');
      const chunk=db.prepare('SELECT rowid AS cursor,session_id,event_id,hash,raw FROM lab_raw WHERE rowid>? ORDER BY rowid LIMIT 32');let cursor=0;
      for(;;){const rows=chunk.all(cursor) as {cursor:number;session_id:string;event_id:string;hash:string;raw:Buffer}[];if(!rows.length)break;
        for(const row of rows){const decoded=decodeRaw(row.raw,row.hash),packed=mode==='compact'?encodeRaw(decoded):decoded;
          if(!packed.equals(row.raw))update.run(packed,row.session_id,row.event_id,row.hash);cursor=row.cursor;
        }
      }
      if(mode==='compact'){
        db.prepare('UPDATE lab_events SET envelope=? WHERE envelope<>?').run(RAW_REFERENCE,RAW_REFERENCE);
        db.prepare("UPDATE lab_meta SET value='2' WHERE key='schema'").run();
        db.prepare("INSERT INTO lab_meta VALUES ('evidence_storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(EVIDENCE_STORAGE);
      }else{
        db.exec('UPDATE lab_events SET envelope=(SELECT CAST(r.raw AS TEXT) FROM lab_raw r WHERE r.session_id=lab_events.session_id AND r.event_id=lab_events.event_id AND r.hash=lab_events.hash)');
        db.exec("DROP VIEW IF EXISTS lab_event_evidence; UPDATE lab_meta SET value='1' WHERE key='schema'; DELETE FROM lab_meta WHERE key='evidence_storage'");
      }
      for(const trigger of triggers)db.exec(trigger.sql);
      after=evidenceProof(db);if(before.proof!==after.proof)throw new Error('EVIDENCE_MIGRATION_PROOF_MISMATCH');
      db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),'OFFLINE_MAINTENANCE',mode==='compact'?'EVIDENCE_COMPACTED':'EVIDENCE_EXPANDED',EVIDENCE_STORAGE,JSON.stringify({before,after}),Date.now());
      db.prepare("INSERT OR REPLACE INTO p0_meta VALUES ('app_instance',?)").run(JSON.stringify({pid:process.pid,owner,operation:'evidence-migration'}));
    }).immediate();
    leased=true;db.pragma('wal_checkpoint(TRUNCATE)');if(vacuum)db.exec('VACUUM');
    if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw new Error('INVALID_MIGRATED_DATABASE');
    return {mode,before:before!,after:after!,vacuum};
  }finally{
    // Do not remove another process's lease when admission or the transaction failed.
    if(leased){db.transaction(()=>{const record=db.prepare("SELECT value FROM p0_meta WHERE key='app_instance'").get() as {value:string}|undefined;
      if(record&&(JSON.parse(record.value) as {owner:string}).owner===owner)db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
    }).immediate();db.pragma('wal_checkpoint(TRUNCATE)');}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [path,mode='compact']=process.argv.slice(2);if(!path||!['compact','expand'].includes(mode))throw new Error('Usage: node dist/server/compact-evidence.js DATABASE_PATH [compact|expand] (server must be stopped; take a backup first)');
  const db=openDatabase(resolve(path));try{console.log(JSON.stringify(compactEvidence(db,mode as 'compact'|'expand'),null,2));}finally{db.close();}
}
