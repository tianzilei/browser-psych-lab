import type Database from 'better-sqlite3';

// Raw records are immutable. Count every retained hash, including conflicts,
// in the same transaction as its receipt; rejected batches roll back both.
export function prepareScopeUsage(db:Database.Database) {
  db.transaction(()=>{
    if((db.prepare("SELECT value FROM lab_meta WHERE key='scope_usage'").get() as {value:string}|undefined)?.value==='raw-bytes-v1')return;
    db.prepare('DELETE FROM lab_scope_usage').run();
    db.prepare(`INSERT INTO lab_scope_usage SELECT session_id,scope,count(*),sum(lab_raw_bytes(raw))
      FROM lab_raw GROUP BY session_id,scope`).run();
    db.prepare("INSERT INTO lab_meta VALUES ('scope_usage','raw-bytes-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }).immediate();
}
