全项目设计讨论，传输段 24，源码主题：维护、文件生命周期及恢复（源包 8/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

          dictionary:{consents:'Explicit agreement to frozen consent document; SHA-256 of stableJSON(consent); accepted_at is server Unix milliseconds; join sessions/version protocol for exact text',event_schema:'lab-events-v1',runner:'canvas-v1',axis_answers:'One row per axis; integer value and configured label; null means unanswered; skipped/unconfirmed/not-reached states retained',question_states:{ANSWERED:'sealed valid answer',UNANSWERED:'sealed visible optional empty answer',SKIPPED:'verified branch hidden',UNCONFIRMED:'no sealed final snapshot for current page',NOT_REACHED:'page position not reached'},software_quality:'SOFTWARE_ONLY; physical display/input timing unverified',human_marks:'append-only annotations; never rewrite raw or system diagnosis'}};
        await writeDurable(join(target,'manifest.json'),stableJSON(manifest));await syncDirectory(target);return manifest;
      }finally{closeSync(fd);if(db.inTransaction)db.exec('ROLLBACK');}
    }
    throw new Error('UNSUPPORTED_MAINTENANCE_JOB');
  }finally{db.close();}
}
try{const result=await run();parentPort!.postMessage({result});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:'MAINTENANCE_FAILED',validation_rejected:(error as {validation_rejected?:boolean})?.validation_rejected===true});}finally{parentPort!.close();}

```

### src/server/private-files.ts L1–L46

```
import { constants, createReadStream } from 'node:fs';
import { open, mkdir, realpath, lstat, link, unlink, readFile } from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type Readable } from 'node:stream';
import { ContractError, id } from '../shared/contract.js';
export async function syncDirectory(path: string) {const f=await open(path,constants.O_RDONLY);try{try{await f.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await f.close();}}
export async function privateRoot(path:string) {
  await mkdir(path,{recursive:true,mode:0o700});const target=resolve(path);
  let lexical=target;while(lexical!==parse(lexical).root){const st=await lstat(lexical);if(st.isSymbolicLink()&&st.uid!==0)throw new Error('PRIVATE_STORAGE_SYMLINK');lexical=dirname(lexical);}
  if((await lstat(target)).isSymbolicLink())throw new Error('PRIVATE_STORAGE_SYMLINK');
  const actual=await realpath(target);let current=actual;
  while(current!==parse(current).root){const st=await lstat(current);const trustedSticky=(st.mode&0o1000)&&st.uid===0;
    if(st.isSymbolicLink()||(process.platform!=='win32'&&((st.mode&0o022)&&!trustedSticky)))throw new Error('UNSAFE_PRIVATE_STORAGE_ANCESTOR');current=dirname(current);}
  return actual;
}
export async function assetPath(root:string,asset:string) {return join(await privateRoot(join(root,'research-assets')),`${id(asset)}.bin`);}
export async function openPrivate(path:string) {
  let ancestor=dirname(resolve(path));while(ancestor!==parse(ancestor).root){const st=await lstat(ancestor);if(st.isSymbolicLink()&&st.uid!==0)throw new Error('PRIVATE_FILE_ANCESTOR_SYMLINK');ancestor=dirname(ancestor);}
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await f.stat();
  if(!st.isFile()){await f.close();throw new Error('NOT_A_PRIVATE_FILE');}return f;
}
export async function fileHash(path:string) {const f=await openPrivate(path);try{const h=createHash('sha256');for await(const chunk of f.createReadStream({autoClose:false}))h.update(chunk);return h.digest('hex');}finally{await f.close();}}
export async function writeDurable(path:string,bytes:string|Uint8Array) {
  const f=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(bytes);try{await f.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await f.close();}await syncDirectory(dirname(path));
}
export async function receiveUpload(root:string,asset:string,body:Readable) {
  const directory=await privateRoot(join(root,'research-assets','.tmp'));const path=join(directory,`${id(asset)}-${randomUUID()}`);
  const f=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let bytes=0;
  try{for await(const chunk of body){bytes+=chunk.length;if(bytes>8*1024*1024)throw new ContractError('UPLOAD_TOO_LARGE',413);await f.writeFile(chunk);}try{await f.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}
  catch(error){await f.close();await unlink(path).catch(()=>{});throw error;}
  await f.close();await syncDirectory(directory);return {path,bytes};
}
export async function publishExclusive(temp:string,destination:string) {
  const h=await fileHash(temp);
  try{await link(temp,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await fileHash(destination)!==h)throw error;}
  await syncDirectory(dirname(destination));await unlink(temp);await syncDirectory(dirname(temp));return h;
}
export async function safeDownload(root:string,job:string,file:string,bucket:string) {
  if(!['research-exports','research-backups'].includes(bucket)||!['data.csv','manifest.json','database.sqlite'].includes(file))throw new ContractError('INVALID_DOWNLOAD_OBJECT');
  const directory=await privateRoot(join(root,bucket,id(job)));return openPrivate(join(directory,file));
}
export const fileBytes = readFile;
export const streamFile = createReadStream;

```

### src/server/restore.ts L1–L42

```
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
    const target=join(destination,mapped);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(join(bundle,f.path),target,constants.COPYFILE_EXCL);await chmod(target,0o600);const file=await openPrivate(target);try{try{await file.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await file.close();}await syncDirectory(dirname(target));}
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

```