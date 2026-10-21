import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Jobs, audit, requests, pins and derived indexes change during backup itself.
// Hash business content in one read view; immutable raw bodies are represented
// by their SHA-256 rather than read/decompressed a second time.
const businessTables=[
  'lab_studies','lab_study_order','lab_versions','lab_questionnaire_sources',
  'lab_archived_studies','lab_assets','lab_asset_refs','lab_packages','lab_package_images','lab_covariates',
  'lab_group_selections','lab_consents','lab_sessions','lab_writers',
  'lab_session_queue','lab_slots','lab_permits','lab_raw','lab_events',
  'lab_dispositions','lab_seals','lab_diagnostics','lab_marks','lab_environments',
];
export function businessFingerprint(db){
  return db.transaction(()=>{
    const hash=createHash('sha256');
    for(const table of businessTables){
      const columns=db.prepare(`PRAGMA table_info(${table})`).all();
      const selected=columns.filter(c=>table!=='lab_raw'||c.name!=='raw').map(c=>c.name);
      const keys=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      hash.update(JSON.stringify([table,selected])+'\n');
      for(const row of db.prepare(`SELECT ${selected.join(',')} FROM ${table} ORDER BY ${keys.join(',')}`).raw().iterate())
        hash.update(JSON.stringify(row)+'\n');
    }
    return `business-content-v2:${hash.digest('hex')}`;
  })();
}

export function fileSha256(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256');
  try{
    if(!fs.fstatSync(fd).isFile())throw new Error(`NOT_A_BACKUP_FILE:${file}`);
    const buffer=Buffer.allocUnsafe(64*1024);let size;
    while((size=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));
    return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}

export function verifyBundle(dir,{manifestHash,jobId}={}){
  const manifestPath=path.join(dir,'manifest.json'),actualHash=fileSha256(manifestPath);
  if(manifestHash&&manifestHash!==actualHash)throw new Error('BASE_MANIFEST_MISMATCH');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.schema!=='backup-v1'||(jobId&&manifest.job_id!==jobId)||
    !Array.isArray(manifest.files)||manifest.files.length>20000||!Array.isArray(manifest.assets))throw new Error('INVALID_BACKUP_MANIFEST');
  const files=new Map();
  for(const file of manifest.files){
    if(typeof file.path!=='string'||!/^[a-zA-Z0-9._/-]+$/.test(file.path)||
      file.path.split('/').some(p=>!p||p==='..'||p==='.')||files.has(file.path)||!/^[a-f0-9]{64}$/.test(file.hash))throw new Error('INVALID_BACKUP_PATH');
    let current=dir;
    for(const part of file.path.split('/')){
      current=path.join(current,part);
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('BACKUP_SYMLINK');
    }
    if(fileSha256(current)!==file.hash)throw new Error(`BACKUP_HASH_MISMATCH:${file.path}`);
    files.set(file.path,file.hash);
  }
  if(!files.has('database.sqlite'))throw new Error('BACKUP_DATABASE_MISSING');
  return {manifest,manifestHash:actualHash,files};
}

export function bundleStructure(db){
  return {
    assets:db.prepare("SELECT asset_id,hash FROM lab_assets WHERE state='READY' ORDER BY asset_id").all(),
    runners:db.prepare('SELECT DISTINCT runner_hash FROM lab_versions ORDER BY runner_hash').all().map(r=>r.runner_hash),
  };
}

export function validBasePointer(pointer){
  return !!pointer&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pointer.job_id)&&
    /^[a-f0-9]{64}$/.test(pointer.manifest_hash)&&(pointer.path??pointer.job_id)===pointer.job_id;
}

export function baseCovers(Database,dir,current,expected={}){
  try{
    const {manifest,files}=verifyBundle(dir,expected);
    const db=new Database(path.join(dir,'database.sqlite'),{readonly:true,fileMustExist:true});
    try{
      const base=bundleStructure(db),assets=new Set(base.assets.map(a=>`${a.asset_id}:${a.hash}`)),runners=new Set(base.runners);
      const declared=[...manifest.assets].sort((a,b)=>a.asset_id.localeCompare(b.asset_id)).map(a=>({asset_id:a.asset_id,hash:a.hash}));
      if(JSON.stringify(base.assets)!==JSON.stringify(declared)||base.assets.some(a=>files.get(`assets/${a.asset_id}.bin`)!==a.hash)||
        base.runners.some(r=>!files.has(`runners/${r}/release.json`)||!files.has(`runners/${r}/run.html`)))return false;
      return current.assets.every(a=>assets.has(`${a.asset_id}:${a.hash}`))&&current.runners.every(r=>runners.has(r));
    }finally{db.close();}
  }catch{return false;}
}
