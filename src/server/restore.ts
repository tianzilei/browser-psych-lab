import Database from 'better-sqlite3';
import {readFile,mkdir,copyFile,chmod,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {privateRoot,fileHash,syncDirectory,writeDurable,openPrivate} from './private-files.js';
import {digest} from './collection-store.js';
import {stableJSON} from '../shared/protocol.js';
export async function restoreBackup(bundle:string,destination:string){
  bundle=await privateRoot(resolve(bundle));destination=resolve(destination);
  try{await lstat(destination);throw new Error('RESTORE_DESTINATION_MUST_NOT_EXIST');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const raw=await readFile(join(bundle,'manifest.json'),'utf8'),manifest=JSON.parse(raw) as {schema:string;files:{path:string;hash:string}[];assets:{asset_id:string;hash:string}[]};
  if(manifest.schema!=='backup-v1'||!Array.isArray(manifest.files)||manifest.files.length>20000||!manifest.files.some(f=>f.path==='database.sqlite'))throw new Error('INVALID_BACKUP_MANIFEST');
  const paths=new Set<string>();for(const f of manifest.files){if(!/^[a-zA-Z0-9._/-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='..')||paths.has(f.path)||!/^[a-f0-9]{64}$/.test(f.hash))throw new Error('INVALID_BACKUP_PATH');paths.add(f.path);if(await fileHash(join(bundle,f.path))!==f.hash)throw new Error('BACKUP_HASH_MISMATCH');}
  const backupDB=new Database(join(bundle,'database.sqlite'),{readonly:true,fileMustExist:true});
  try{if(backupDB.pragma('integrity_check',{simple:true})!=='ok'||(backupDB.pragma('foreign_key_check') as unknown[]).length)throw new Error('INVALID_BACKUP_DATABASE');
    const assets=backupDB.prepare("SELECT asset_id,hash FROM lab_assets WHERE state='READY' ORDER BY asset_id").all();const declared=[...manifest.assets].sort((a,b)=>a.asset_id.localeCompare(b.asset_id));if(stableJSON(assets)!==stableJSON(declared.map(a=>({asset_id:a.asset_id,hash:a.hash}))))throw new Error('BACKUP_REFERENCE_MISMATCH');
    for(const a of declared)if(!manifest.files.some(f=>f.path===`assets/${a.asset_id}.bin`&&f.hash===a.hash))throw new Error('BACKUP_REFERENCE_MISSING');
    for(const v of backupDB.prepare('SELECT DISTINCT runner_hash FROM lab_versions').all() as {runner_hash:string}[])if(!paths.has(`runners/${v.runner_hash}/release.json`)||!paths.has(`runners/${v.runner_hash}/run.html`))throw new Error('BACKUP_RUNNER_MISSING');
  }finally{backupDB.close();}
  await privateRoot(dirname(destination));await mkdir(destination,{mode:0o700});
  for(const f of manifest.files){const mapped=f.path==='database.sqlite'?'database/browser-psych-lab.sqlite':f.path.startsWith('assets/')?`research-assets/${f.path.slice(7)}`:f.path.startsWith('runners/')?`research-assets/${f.path}`:null;if(!mapped)throw new Error('UNKNOWN_BACKUP_OBJECT');
    const target=join(destination,mapped);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(join(bundle,f.path),target,constants.COPYFILE_EXCL);await chmod(target,0o600);const file=await openPrivate(target);try{await file.sync();}finally{await file.close();}await syncDirectory(dirname(target));}
  for(const dir of ['research-assets','research-exports','research-backups'])await privateRoot(join(destination,dir));
  const db=new Database(join(destination,'database/browser-psych-lab.sqlite'));db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
  try{db.transaction(()=>{
    db.prepare("UPDATE lab_meta SET value='CLOSED' WHERE key='collection_gate'").run();db.prepare('DELETE FROM lab_admin_tokens').run();
    // Never infer interrupted permits ended normally. Explicit participant recovery closes them UNKNOWN.
    db.prepare("UPDATE lab_jobs SET state='RECOVERY_REQUIRED',phase='RESTORED_UNRESOLVED' WHERE state='RUNNING'").run();
    const report={manifest_hash:digest(raw),collection_gate:'CLOSED',unclosed_permits:db.prepare("SELECT count(*) AS n FROM lab_permits WHERE state='ISSUED'").get(),unresolved_jobs:db.prepare("SELECT count(*) AS n FROM lab_jobs WHERE state='RECOVERY_REQUIRED'").get()};
    db.prepare('INSERT INTO lab_audit VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),'RESTORE','RESTORED_CLOSED',digest(raw),stableJSON(report),Date.now());
    // The restored owner cannot be the original live process.
    db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
  }).immediate();db.pragma('wal_checkpoint(TRUNCATE)');}finally{db.close();}
  const report={schema:'restore-report-v1',backup_manifest_hash:digest(raw),verified_at:new Date().toISOString(),destination,gate:'CLOSED',verification:'all-file-hashes-integrity-foreign-keys-and-references',independent_restore_claim:'operator-verification-required'};
  await writeDurable(join(destination,'restore-report.json'),stableJSON(report));await syncDirectory(destination);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw new Error('Usage: node dist/server/restore.js BACKUP_BUNDLE NEW_STORAGE_ROOT');
  console.log(JSON.stringify(await restoreBackup(process.argv[2]!,process.argv[3]!),null,2));
}
