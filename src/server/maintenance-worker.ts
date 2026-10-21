import { parentPort,workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {imageInfo,unpackImages} from './image-package.js';
import { mkdir,unlink,copyFile,readdir,lstat,chmod,readFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { openSync,writeSync,fsyncSync,closeSync,constants } from 'node:fs';
import { privateRoot,assetPath,fileHash,publishExclusive,writeDurable,syncDirectory,openPrivate } from './private-files.js';
import { digest } from './collection-store.js';
import { stableJSON,pageSnapshot,evaluate,type Protocol,type Answer } from '../shared/protocol.js';
import { RunReplay } from '../shared/run-replay.js';
import { parseLabEvent,type GroupPlan,type RunRecord } from '../shared/lab-contract.js';
import { id,object } from '../shared/contract.js';
import {ANSWER_LAYOUT,ANSWER_TIME_ZONE,answerLayout,exportDateTime,trajectoryColumns,csvRow,csvCell} from './export-csv.js';
import {RATING_LAYOUT,ratingLayout,ratingRows} from './rating-export.js';
import {recordingPhotos} from './recording-photos.js';
import {resolvePhoto,type PhotoIdentity} from '../shared/photo-identity.js';
import {validInteractionBatch} from '../shared/interaction.js';
import {installEvidenceFunctions,decodeRaw,verifyEvidence} from './evidence-storage.js';
import {preparationColumns,preparationRows,PREPARATION_LAYOUT} from './preparation-export.js';

const config=workerData as {path:string;root:string;job:string;kind:string;config:Record<string,unknown>};
const phase=(phase:string,data?:unknown)=>parentPort!.postMessage({phase,data});
async function copyChecked(source:string,target:string){const bytes=await openPrivate(source);try{await bytes.close();await copyFile(source,target,constants.COPYFILE_EXCL);const file=await openPrivate(target);try{try{await file.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await file.close();}}finally{await bytes.close().catch(()=>{});}return fileHash(target);}
async function copyTree(source:string,target:string,files:{path:string;hash:string}[],prefix:string){
  await mkdir(target,{mode:0o700});
  for(const name of await readdir(source)){if(!/^[a-zA-Z0-9._-]+$/.test(name))throw new Error('INVALID_RELEASE_PATH');const from=join(source,name),to=join(target,name);const st=await lstat(from);
    if(st.isSymbolicLink())throw new Error('RELEASE_SYMLINK');if(st.isDirectory())await copyTree(from,to,files,`${prefix}/${name}`);
    else if(st.isFile())files.push({path:`${prefix}/${name}`,hash:await copyChecked(from,to)});else throw new Error('INVALID_RELEASE_OBJECT');}
  await syncDirectory(target);
}
async function run(){
  if(config.kind==='RECOVER'){
    const original=object(config.config.original_config),inventory:{path:string;hash:string;bytes:number}[]=[];let count=0;
    async function inspect(path:string,prefix:string){let entries:string[];try{entries=await readdir(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      for(const name of entries){if(++count>10000||! /^[a-zA-Z0-9._-]+$/.test(name))throw new Error('RECOVERY_INVENTORY_BUDGET');const next=join(path,name),st=await lstat(next);if(st.isSymbolicLink())throw new Error('RECOVERY_SYMLINK');if(st.isDirectory())await inspect(next,`${prefix}/${name}`);else if(st.isFile())inventory.push({path:`${prefix}/${name}`,hash:await fileHash(next),bytes:st.size});else throw new Error('RECOVERY_UNKNOWN_OBJECT');}}
    if(['BACKUP','EXPORT'].includes(String(config.config.original_kind)))await inspect(join(config.root,config.config.original_kind==='BACKUP'?'research-backups':'research-exports',config.job),'job');
    if(original.asset_id){const asset=id(original.asset_id);try{const path=await assetPath(config.root,asset),st=await lstat(path);inventory.push({path:`asset/${asset}`,hash:await fileHash(path),bytes:st.size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const tempdir=join(config.root,'research-assets','.tmp');try{for(const name of await readdir(tempdir))if(name.startsWith(`${asset}-`)){const st=await lstat(join(tempdir,name));inventory.push({path:`temporary/${name}`,hash:await fileHash(join(tempdir,name)),bytes:st.size});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(original.package_id){const packageId=id(original.package_id),directory=join(config.root,'research-assets','packages',packageId);await inspect(directory,'package');
      let manifest:unknown[]=[];try{manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as unknown[];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!Array.isArray(manifest)||manifest.length>100)throw new Error('INVALID_PACKAGE_RECOVERY_MANIFEST');
      for(const item of manifest){const asset=id(object(item).asset_id);try{const path=await assetPath(config.root,asset),st=await lstat(path);inventory.push({path:`asset/${asset}`,hash:await fileHash(path),bytes:st.size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      const temporary=join(config.root,'research-assets','.tmp');try{for(const name of await readdir(temporary))if(name.startsWith(`${packageId}-`))inventory.push({path:`temporary/${name}`,hash:await fileHash(join(temporary,name)),bytes:(await lstat(join(temporary,name))).size});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return {verified:true,report:config.config.report,inventory,disposition:'preserved-for-explicit-maintenance',verified_at:new Date().toISOString()};
  }
  if(config.kind==='UPLOAD'){
    const temp=String(config.config.temp),asset=id(config.config.asset_id);const st=await lstat(temp);
    if(!st.isFile()||st.isSymbolicLink()||st.size>8*1024*1024)throw new Error('INVALID_UPLOAD_FILE');
    const meta=imageInfo(await readFile(temp));
    const hash=await publishExclusive(temp,await assetPath(config.root,asset));
    return {asset_id:asset,info:{hash,bytes:st.size,...meta}};
  }
  if(config.kind==='PACKAGE'){
    const temp=String(config.config.temp),packageId=id(config.config.package_id);
    const packed=await readFile(temp);phase('VALIDATING_HEADERS');let images:ReturnType<typeof unpackImages>;
    try{images=unpackImages(packed);}catch(error){await unlink(temp);await syncDirectory(dirname(temp));throw Object.assign(new Error(error instanceof Error?error.message:'INVALID_ZIP'),{validation_rejected:true});}
    const dir=await privateRoot(join(config.root,'research-assets','packages',packageId)),result=images.map(image=>({asset_id:randomUUID(),path:image.path,hash:digest(image.bytes),bytes:image.bytes.length,...image.info}));
    // Write the inventory before publishing anything, so interrupted work is recoverable.
    await writeDurable(join(dir,'manifest.json'),stableJSON(result));
    for(const [index,image] of images.entries()){const asset=result[index]!.asset_id,staged=join(dir,asset);await writeDurable(staged,image.bytes);await publishExclusive(staged,await assetPath(config.root,asset));}
    await unlink(temp);await syncDirectory(dirname(temp));
    return {study_id:config.config.study_id,name:config.config.name,hash:digest(packed),images:result};
  }
  if(config.kind==='DELETE'){
    const path=await assetPath(config.root,id(config.config.asset_id));
    try{const f=await openPrivate(path);await f.close();await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const temporary=join(config.root,'research-assets','.tmp');let removed=0;try{for(const name of await readdir(temporary))if(name.startsWith(`${id(config.config.asset_id)}-`)){const file=await openPrivate(join(temporary,name));await file.close();await unlink(join(temporary,name));removed++;}await syncDirectory(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await syncDirectory(dirname(path));return {asset_id:config.config.asset_id,purged:true,temporary_removed:removed};
  }
  const db=new Database(config.path,{readonly:true,fileMustExist:true});installEvidenceFunctions(db);db.pragma('query_only=ON');
  try{
    if(config.kind==='REPLAY'){
      db.exec('BEGIN');const sid=id(config.config.session_id),scope=id(config.config.scope);const started=Date.now();
      const permit=db.prepare('SELECT plan FROM lab_permits WHERE session_id=? AND scope=?').get(sid,scope) as {plan:string}|undefined;
      if(!permit)throw new Error('PERMIT_NOT_FOUND');
      const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,scope);
      const replay=new RunReplay(JSON.parse(permit.plan) as GroupPlan);let count=0;
      for(const row of db.prepare('SELECT envelope,disposition FROM lab_event_evidence WHERE session_id=? AND scope=? ORDER BY sequence').iterate(sid,scope) as Iterable<{envelope:string;disposition:string}>){
        if(++count>5000||Date.now()-started>30000||row.disposition!=='ACCEPTED')throw new Error('REPLAY_INPUT_OR_BUDGET_INVALID');
        const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);
      }
      const results=replay.finish();db.exec('COMMIT');return {session_id:sid,scope,source_hash:digest(stableJSON(refs)),valid:true,algorithm:'run-replay-v1',results};
    }
    if(config.kind==='REBUILD'){
      db.exec('BEGIN');const study=id(config.config.study_id),projections:unknown[]=[];const started=Date.now();
      for(const p of db.prepare("SELECT p.session_id,p.scope,p.plan FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND p.state='CLOSED_NORMAL'").iterate(study) as Iterable<{session_id:string;scope:string;plan:string}>){
        if(projections.length>=1000||Date.now()-started>30000)throw new Error('REBUILD_BUDGET_EXCEEDED');const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(p.session_id,p.scope);const replay=new RunReplay(JSON.parse(p.plan));
        for(const row of db.prepare('SELECT envelope,disposition FROM lab_event_evidence WHERE session_id=? AND scope=? ORDER BY sequence').iterate(p.session_id,p.scope) as Iterable<{envelope:string;disposition:string}>){if(row.disposition!=='ACCEPTED')throw new Error('REBUILD_INPUT_INVALID');const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);}
        projections.push({session_id:p.session_id,scope:p.scope,source_hash:digest(stableJSON(refs)),result:replay.finish()});if(Buffer.byteLength(stableJSON(projections))>4*1024*1024)throw new Error('REBUILD_RESULT_BUDGET_EXCEEDED');
      }db.exec('COMMIT');return {generation_id:config.job,projections,algorithm:'run-replay-v1'};
    }
    if(config.kind==='BACKUP'){
      const localOnly=config.config.local_only===true;
      const target=await privateRoot(join(config.root,'research-backups',config.job));const destination=join(target,'database.sqlite');
      phase('DATABASE_BACKUP');await db.backup(destination);await chmod(destination,0o600);const restored=new Database(destination,{readonly:true,fileMustExist:true});
      try{
        if(restored.pragma('integrity_check',{simple:true})!=='ok'||(restored.pragma('foreign_key_check') as unknown[]).length)throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED');
        verifyEvidence(restored);
        const assets=restored.prepare("SELECT asset_id,hash,bytes FROM lab_assets WHERE state='READY'").all() as {asset_id:string;hash:string;bytes:number}[];
        const runners=restored.prepare('SELECT DISTINCT runner_hash FROM lab_versions').all() as {runner_hash:string}[];
        // Parent establishes durable pins from THIS completed backup view before releasing the barrier.
        phase('PIN_REQUIRED',assets);await new Promise<void>(resolve=>parentPort!.once('message',()=>resolve()));
        await mkdir(join(target,'assets'),{mode:0o700});await mkdir(join(target,'runners'),{mode:0o700});const files:{path:string;hash:string}[]=[];
        files.push({path:'database.sqlite',hash:await fileHash(destination)});let total=0;
        for(const asset of assets){total+=asset.bytes;if(total>512*1024*1024)throw new Error('BACKUP_ASSET_BUDGET_EXCEEDED');
          const h=await copyChecked(await assetPath(config.root,asset.asset_id),join(target,'assets',`${asset.asset_id}.bin`));if(h!==asset.hash)throw new Error('BACKUP_ASSET_HASH_MISMATCH');files.push({path:`assets/${asset.asset_id}.bin`,hash:h});}
        for(const runner of runners){const from=join(config.root,'research-assets','runners',runner.runner_hash),release=JSON.parse(await readFile(join(from,'release.json'),'utf8')) as {runnerHash:string;files:{path:string;hash:string}[]};
          if(release.runnerHash!==runner.runner_hash||digest(JSON.stringify(release.files))!==runner.runner_hash)throw new Error('BACKUP_RUNNER_IDENTITY_MISMATCH');for(const f of release.files){if(!/^[a-zA-Z0-9._/-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='..')||await fileHash(join(from,f.path))!==f.hash)throw new Error('BACKUP_RUNNER_HASH_MISMATCH');}
          await copyTree(from,join(target,'runners',runner.runner_hash),files,`runners/${runner.runner_hash}`);}
        const manifest={schema:'backup-v1',job_id:config.job,completed_at:new Date().toISOString(),database_view:'completed-online-backup',backup_scope:localOnly?'local-only':'standard',files,assets,software:'browser-psych-lab',restore_gate:'CLOSED',secret_configuration:'configure-separately'};
        await writeDurable(join(target,'manifest.json'),stableJSON(manifest));await syncDirectory(target);
        let independent=false;const independentRoot=localOnly?'':String(config.config.independent_root??'');
        if(independentRoot){const independentPath=await privateRoot(independentRoot);if((await lstat(independentPath)).dev===(await lstat(config.root)).dev)throw new Error('BACKUP_TARGET_SAME_FILESYSTEM');phase('INDEPENDENT_COPY');const copied:{path:string;hash:string}[]=[];await copyTree(target,join(independentPath,config.job),copied,'backup');for(const file of copied){const local=file.path.slice('backup/'.length);if(await fileHash(join(target,local))!==file.hash)throw new Error('INDEPENDENT_COPY_MISMATCH');}independent=true;}
        return {job_id:config.job,files:files.length,manifest_hash:await fileHash(join(target,'manifest.json')),independent,local_only:localOnly,independence:localOnly?'LOCAL_ONLY':independent?'INDEPENDENT':'UNSPECIFIED',independent_target:independentRoot||null};
      }finally{restored.close();}
    }
    if(config.kind==='EXPORT'){
      const format=config.config.format??'all';if(format!=='all'&&format!=='answers')throw new Error('INVALID_EXPORT_FORMAT');
      const answersOnly=format==='answers';
      const sid=id(config.config.study_id);const target=await privateRoot(join(config.root,'research-exports',config.job));
      const output=join(target,'data.csv');const fd=answersOnly?undefined:openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      const descriptors:number[]=fd===undefined?[]:[fd],files:Record<string,{rows:number;bytes:number;hash?:string;columns:readonly string[]}>={};
      const snapshot=randomUUID(),started=Date.now(),source=createHash('sha256');let bytes=0,totalBytes=0,rows=0,flatRows=0;const tables:Record<string,number>={};
      const cell=(x:string)=>`"${x.replaceAll('"','""')}"`;
      // Raw evidence, its envelope and both trajectory views share this budget.
      // Stream to disk so larger studies do not accumulate a CSV in memory.
      const maxBytes=1024*1024*1024,maxRows=2000000,maxMs=90000;
      const charge=(text:string)=>{totalBytes+=Buffer.byteLength(text);if(totalBytes>maxBytes||Date.now()-started>maxMs)throw new Error('EXPORT_BUDGET_EXCEEDED');};
      const emit=(text:string)=>{if(fd===undefined)throw new Error('EXPORT_FILE_NOT_SELECTED');charge(text);bytes+=Buffer.byteLength(text);writeSync(fd,text);};
      const flatFile=(name:string,columns:readonly string[])=>{
        const descriptor=openSync(join(target,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);descriptors.push(descriptor);
        const info=files[name]={rows:0,bytes:0,columns},header='\uFEFF'+columns.map(csvCell).join(',')+'\r\n';charge(header);info.bytes+=Buffer.byteLength(header);writeSync(descriptor,header);
        return (row:Record<string,unknown>)=>{if(++flatRows+rows>maxRows)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');const text=csvRow(columns,row);charge(text);info.bytes+=Buffer.byteLength(text);info.rows++;writeSync(descriptor,text);};
      };
      try{
        db.exec('BEGIN');const study=db.prepare('SELECT study_id,title FROM lab_studies WHERE study_id=?').get(sid) as {study_id:string;title:string}|undefined;if(!study)throw new Error('STUDY_NOT_FOUND');
        const actualReadAt=new Date().toISOString();
        const versions=db.prepare('SELECT version_id,protocol FROM lab_versions WHERE study_id=? AND (version_id IN (SELECT version_id FROM lab_sessions WHERE study_id=?) OR version_id=(SELECT version_id FROM lab_versions WHERE study_id=? ORDER BY rowid DESC LIMIT 1)) ORDER BY rowid DESC').all(sid,sid,sid) as {version_id:string;protocol:string}[];
        const parsedVersions=versions.map(v=>({...v,protocol:JSON.parse(v.protocol) as Protocol})),layout=answerLayout(parsedVersions),ratings=ratingLayout(parsedVersions);
        const answerRow=flatFile('answers.csv',layout.columns),trajectoryRow=answersOnly?undefined:flatFile('trajectories.csv',trajectoryColumns);
        const preparationRow=flatFile('preparations.csv',preparationColumns);
        const ratingRow=ratings.enabled?flatFile('ratings.csv',ratings.columns):undefined,sessionMetadata=new Map<string,Record<string,unknown>>();
        const photoAssets=new Map((db.prepare('SELECT asset_id,name,hash FROM lab_assets WHERE study_id=?').all(sid) as {asset_id:string;name:string;hash:string}[]).map(a=>[a.asset_id,a]));
        const photoCache=new Map<string,PhotoIdentity[]>(),photos=(session:string)=>{let p=photoCache.get(session);if(!p){p=recordingPhotos(db,session);photoCache.set(session,p);}return p;};
        source.update(`photo_assets\0${stableJSON([...photoAssets.values()])}\n`);
        if(answersOnly){source.update(`study\0${stableJSON(study)}\n`);source.update(`versions\0${stableJSON(versions)}\n`);}
        if(!answersOnly){
        emit('table,data_json\r\n');
        const queries:Record<string,string>={
          studies:'SELECT study_id,title,draft,revision,admission,created_at FROM lab_studies WHERE study_id=?',
          versions:'SELECT * FROM lab_versions WHERE study_id=?',assets:'SELECT * FROM lab_assets WHERE study_id=?',
          sessions:'SELECT session_id,study_id,version_id,admission_id,state,writer_id,writer_epoch,lease_until,page_index,group_index,answers,path,allocation_id,completion,created_at FROM lab_sessions WHERE study_id=?',
          slots:'SELECT a.* FROM lab_slots a JOIN lab_versions v USING(version_id) WHERE v.study_id=?',
        };
        queries.questionnaire_sources='SELECT * FROM lab_questionnaire_sources WHERE study_id=?';queries.packages='SELECT * FROM lab_packages WHERE study_id=?';queries.package_images='SELECT * FROM lab_package_images WHERE study_id=?';
        queries.study_order='SELECT * FROM lab_study_order WHERE study_id=?';
        queries.reanswer_links='SELECT a.* FROM lab_reanswer_links a JOIN lab_sessions s ON s.session_id=a.new_session_id WHERE s.study_id=?';
        for(const table of ['writers','permits','events','raw','seals','diagnostics','marks','projections','covariates','consents','group_selections'])queries[table]=`SELECT a.* FROM lab_${table} a JOIN lab_sessions s USING(session_id) WHERE s.study_id=?`;
        queries.events='SELECT a.* FROM lab_event_evidence a JOIN lab_sessions s USING(session_id) WHERE s.study_id=? ORDER BY s.rowid,a.scope,a.sequence,a.evidence_rowid';
        queries.dispositions='SELECT d.* FROM lab_dispositions d JOIN lab_raw r USING(receipt_id) JOIN lab_sessions s USING(session_id) WHERE s.study_id=?';
        for(const [table,query]of Object.entries(queries)){tables[table]=0;
          for(const row of db.prepare(query).iterate(sid) as Iterable<Record<string,unknown>>){if(++rows+flatRows>maxRows)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');
            if(Buffer.isBuffer(row.raw)){row.raw_utf8=decodeRaw(row.raw,String(row.hash)).toString('utf8');delete row.raw;}delete row.evidence_rowid;const encoded=stableJSON(row);source.update(`${table}\0${encoded}\n`);emit(`${cell(table)},${cell(encoded)}\r\n`);tables[table]++;}
        }
        // Derived trial rows are recomputed from the same read view, including interrupted histories.
        for(const row of db.prepare("SELECT e.session_id,e.event_id,e.envelope FROM lab_event_evidence e JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND e.kind='INPUT_DIAGNOSTIC' AND e.scope LIKE 'd-ui-%' ORDER BY e.evidence_rowid").iterate(sid) as Iterable<{session_id:string;event_id:string;envelope:string}>){const batch=parseLabEvent(row.envelope).payload.interaction;if(!validInteractionBatch(batch))continue;for(const sample of batch.samples){const photo=resolvePhoto(photos(row.session_id),sample.context as Record<string,unknown>),encoded=stableJSON({...sample,session_id:row.session_id,event_id:row.event_id,time_origin:batch.time_origin,...(photo?{photo}: {})});if(++rows+flatRows>maxRows)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');emit(`${cell('interaction_actions')},${cell(encoded)}\r\n`);source.update(`interaction_actions\0${encoded}\n`);tables.interaction_actions=(tables.interaction_actions??0)+1;}}
        for(const row of db.prepare("SELECT e.envelope,e.disposition,e.reason,r.received_at,s.state FROM lab_event_evidence e JOIN lab_sessions s USING(session_id) JOIN lab_raw r USING(session_id,event_id,hash) WHERE s.study_id=? AND e.kind IN ('INPUT_DIAGNOSTIC','GROUP_RECORD') ORDER BY s.rowid,e.scope,e.sequence,e.evidence_rowid").iterate(sid) as Iterable<{envelope:string;disposition:string;reason:string;received_at:number;state:string}>){
          const event=parseLabEvent(row.envelope),common={snapshot_id:snapshot,study_id:sid,session_id:event.session_id,version_id:event.version_id,session_state:row.state,event_id:event.event_id,scope:event.scope,sequence:event.sequence,writer_epoch:event.writer_epoch,clock_epoch:event.clock_epoch,event_kind:event.kind,disposition:row.disposition,reason:row.reason,received_at:row.received_at,event_time_ms:event.time_ms};
          const interaction=event.payload.interaction;
          if(validInteractionBatch(interaction)){
            for(const [index,item]of interaction.samples.entries()){
              const sample=object(item),context=sample.context&&!Array.isArray(sample.context)?object(sample.context):{};
              // Sample keys are client-authored; keep session/event/clock identity authoritative.
              trajectoryRow!({...sample,...common,...resolvePhoto(photos(event.session_id),context),sample_index:index,time_origin:interaction.time_origin,at:sample.at,event_type:sample.type,page_id:context.page_id,question_id:context.question_id,target:sample.target,x:sample.x,y:sample.y,key:sample.key,code:sample.code,value:sample.value,payload_json:stableJSON(sample)});
            }
          }else if(event.kind==='GROUP_RECORD'&&event.payload.record&&typeof event.payload.record==='object'&&!Array.isArray(event.payload.record)){
            const record=object(event.payload.record);trajectoryRow!({...common,...resolvePhoto(photos(event.session_id),record),sample_index:0,time_origin:record.time_origin,clock_origin:record.clock_origin,at:record.at,event_type:record.type,x:record.x,y:record.y,code:record.key_code,value:record.answer??record.choice,payload_json:stableJSON(record)});
          }else trajectoryRow!({...common,sample_index:0,event_type:'diagnostic',payload_json:stableJSON(event.payload)});
        }
        }
        for(const session of db.prepare('SELECT s.session_id,s.version_id,s.state,s.created_at,s.page_index,s.path,v.protocol,c.accepted_at AS consent_accepted_at,(SELECT max(r.received_at) FROM lab_raw r WHERE r.session_id=s.session_id) AS last_received_at FROM lab_sessions s JOIN lab_versions v USING(version_id) LEFT JOIN lab_consents c USING(session_id) WHERE s.study_id=? ORDER BY s.rowid').iterate(sid) as Iterable<{session_id:string;version_id:string;state:string;created_at:number;page_index:number;path:string;protocol:string;consent_accepted_at:number|null;last_received_at:number|null}>){
          const protocol=JSON.parse(session.protocol) as Protocol,path=JSON.parse(session.path) as string[],answers:Record<string,Answer>={},states:Record<string,unknown>={};
          for(const row of preparationRows(db,session,protocol)){preparationRow({snapshot_id:snapshot,study_id:sid,...row});if(answersOnly)source.update(`preparation\0${stableJSON(row)}\n`);}
          if(answersOnly)source.update(`session\0${stableJSON(session)}\n`);
          for(const [index,page]of protocol.pages.entries()){
            if(path.includes(page.id)){const event=db.prepare("SELECT envelope FROM lab_event_evidence WHERE session_id=? AND scope=? AND kind='PAGE_SNAPSHOT' AND disposition='ACCEPTED' ORDER BY sequence DESC LIMIT 1").get(session.session_id,page.id) as {envelope:string}|undefined;if(!event)throw new Error('EXPORTED_PAGE_EVIDENCE_MISSING');if(answersOnly)source.update(`sealed_page\0${event.envelope}\n`);const snapshot=pageSnapshot(page,answers,object(parseLabEvent(event.envelope).payload.answers) as Record<string,Answer>);for(const [q,state]of Object.entries(snapshot)){states[q]={page_id:page.id,...state};answers[q]=state.answer;}}
            else if(index<session.page_index&&!evaluate(page.condition,answers)){for(const q of page.questions){states[q.id]={page_id:page.id,state:'SKIPPED',answer:null,reason:'PAGE_BRANCH'};answers[q.id]=null;}}
            else for(const q of page.questions)states[q.id]={page_id:page.id,state:index===session.page_index?'UNCONFIRMED':'NOT_REACHED',answer:null};
          }
          if(!answersOnly){const json=stableJSON({session_id:session.session_id,states});emit(`${cell('question_states')},${cell(json)}\r\n`);source.update(`question_states\0${json}\n`);rows++;tables.question_states=(tables.question_states??0)+1;}
          const wide:Record<string,unknown>={snapshot_id:snapshot,study_id:sid,study_title:study.title,session_id:session.session_id,version_id:session.version_id,protocol_title:protocol.title,session_state:session.state,session_created_at:exportDateTime(session.created_at),consent_accepted_at:exportDateTime(session.consent_accepted_at),last_received_at:exportDateTime(session.last_received_at),time_zone:ANSWER_TIME_ZONE};
          sessionMetadata.set(session.session_id,{snapshot_id:snapshot,study_id:sid,study_title:study.title,session_id:session.session_id,version_id:session.version_id,session_state:session.state,compensation_phone:typeof answers['compensation-phone']==='string'?answers['compensation-phone']:null});
          for(const field of layout.fields)wide[field.state_column]='NOT_IN_VERSION';
          const put=(key:string,value:Answer,state:unknown,label?:string|null)=>{const field=layout.byKey.get(key)!;wide[field.value_column]=value!==null&&typeof value==='object'?stableJSON(value):value;wide[field.state_column]=state;if(field.label_column)wide[field.label_column]=label??null;if(field.json_column)wide[field.json_column]=stableJSON(value);};
          for(const page of protocol.pages)for(const q of page.questions){
            const parent=object(states[q.id]);
            if(q.type==='scales'){
              const answer=parent.answer&&typeof parent.answer==='object'?object(parent.answer):{};
              for(const axis of q.axes!){const value=typeof answer[axis.id]==='number'?answer[axis.id] as number:null;
                put(`${q.id}:${axis.id}`,value,value!==null?'ANSWERED':['ANSWERED','UNANSWERED'].includes(String(parent.state))?'UNANSWERED':parent.state,value===null?null:axis.labels[value-axis.min]);
              }
            }else{
              const value=(parent.answer??null) as Answer;put(q.id,value,parent.state,q.type==='scale'&&typeof value==='number'?q.labels?.[value-q.min!]:null);
            }
          }
          answerRow(wide);
          if(!answersOnly)for(const page of protocol.pages)for(const q of page.questions)if(q.type==='scales'){
            const parent=object(states[q.id]),answer=parent.answer&&typeof parent.answer==='object'?object(parent.answer):{};
            for(const axis of q.axes!){const value=typeof answer[axis.id]==='number'?answer[axis.id] as number:null;
              const state=value!==null?'ANSWERED':['ANSWERED','UNANSWERED'].includes(String(parent.state))?'UNANSWERED':parent.state;
              const row={session_id:session.session_id,version_id:session.version_id,page_id:page.id,question_id:q.id,axis_id:axis.id,axis_title:axis.title,min:axis.min,max:axis.max,value,label:value===null?null:axis.labels[value-axis.min],state};
              const encoded=stableJSON(row);if(++rows+flatRows>maxRows)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');emit(`${cell('axis_answers')},${cell(encoded)}\r\n`);source.update(`axis_answers\0${encoded}\n`);tables.axis_answers=(tables.axis_answers??0)+1;
            }
          }
        }
        for(const permit of db.prepare('SELECT p.* FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=?').iterate(sid) as Iterable<{session_id:string;scope:string;plan:string;state:string;writer_epoch:number}>){
          const plan=JSON.parse(permit.plan) as GroupPlan;if(answersOnly&&!plan.rating)continue;
          const replay=new RunReplay(plan);let replayError:string|null=null;let previous:{event_id:string;hash:string}|null=null;let sequence=0;const sourceDispositions:Record<string,number>={};
          try{for(const row of db.prepare('SELECT envelope,disposition,reason,hash FROM lab_event_evidence WHERE session_id=? AND scope=? ORDER BY sequence').iterate(permit.session_id,permit.scope) as Iterable<{envelope:string;disposition:string;reason:string;hash:string}>){sourceDispositions[row.disposition]=(sourceDispositions[row.disposition]??0)+1;if(row.disposition!=='ACCEPTED'&&row.reason!=='HISTORICAL_RECONCILIATION_REQUIRED')throw new Error('NONCANONICAL_HISTORY');const e=parseLabEvent(row.envelope);if(e.writer_epoch!==permit.writer_epoch||e.sequence!==sequence++||stableJSON(e.previous)!==stableJSON(previous))throw new Error('HISTORICAL_CHAIN_GAP_OR_FENCE');previous={event_id:e.event_id,hash:row.hash};if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);}if(permit.state==='CLOSED_NORMAL')replay.finish();}catch(error){replayError=String(error);}
          const results=[...replay.results.values()],derived={session_id:permit.session_id,scope:permit.scope,permit_state:permit.state,historical:permit.state!=='CLOSED_NORMAL',source_dispositions:sourceDispositions,algorithm:'run-replay-v1',results,executions:Object.fromEntries(replay.scheduler.executions),replay_error:replayError};const json=stableJSON(derived);source.update(`trial_results\0${permit.plan}\0${json}\n`);
          if(!answersOnly){emit(`${cell('trial_results')},${cell(json)}\r\n`);rows++;tables.trial_results=(tables.trial_results??0)+1;}
          if(ratingRow)for(const row of ratingRows(ratings,plan,results,permit.state,replayError,photoAssets))ratingRow({...sessionMetadata.get(permit.session_id),...row});
        }
        if(!answersOnly){
        for(const audit of db.prepare('SELECT * FROM lab_audit WHERE subject=? OR subject IN (SELECT version_id FROM lab_versions WHERE study_id=?) OR subject IN (SELECT session_id FROM lab_sessions WHERE study_id=?)').iterate(sid,sid,sid)){const json=stableJSON(audit);emit(`${cell('audit')},${cell(json)}\r\n`);source.update(`audit\0${json}\n`);rows++;tables.audit=(tables.audit??0)+1;}
        const refs=db.prepare('SELECT r.* FROM lab_asset_refs r JOIN lab_assets a USING(asset_id) WHERE a.study_id=?').all(sid);
        const refsJson=stableJSON(refs);emit(`${cell('asset_refs')},${cell(refsJson)}\r\n`);source.update(`asset_refs\0${refsJson}\n`);rows++;tables.asset_refs=1;
        }
        db.exec('COMMIT');
        if(rows+flatRows>maxRows)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');
        for(const descriptor of descriptors)try{fsyncSync(descriptor);}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
        for(const [name,info]of Object.entries(files))info.hash=await fileHash(join(target,name));
        const manifest={schema:'export-v1',result_export_revision:'photo-identity-v2',format,snapshot_id:snapshot,study_id:sid,actual_read_at:actualReadAt,algorithm:'single-read-view-v1',source_hash:source.digest('hex'),tables,rows:answersOnly?flatRows:rows,bytes:answersOnly?totalBytes:bytes,...(answersOnly?{}:{csv_hash:await fileHash(output),raw_encoding:'exact UTF-8 in raw_utf8 cells'}),all_session_states:true,
          files,...(ratings.enabled?{ratings_layout:RATING_LAYOUT,primary_results_file:'ratings.csv',rating_definitions:ratings.definitions,ratings_policy:'One row per participant per selected photo; photo_id, photo_filename, photo_path and photo_hash identify the rated image; five impressions, familiarity and age are separate columns; only CLOSED_NORMAL replayed results are ANSWERED; interrupted results remain UNCONFIRMED; compensation_phone comes from the sealed questionnaire page; old versions use their own question definitions and familiarity position.'}:{}),preparations_layout:PREPARATION_LAYOUT,preparations_policy:'Client preparation attempts and permit readiness are separate records identified by record_source; configured budget comes from frozen protocol; missing historical measurements remain empty with NOT_MEASURED; configuration-only is not a measured success; client metadata is self-reported; time durations use milliseconds, received_at is server Unix milliseconds.',answers_layout:ANSWER_LAYOUT,answers_time_zone:ANSWER_TIME_ZONE,answer_columns:layout.fields,csv_text_policy:'UTF-8 BOM; formula-like text prefixed with apostrophe; json question columns and payload_json preserve exact values',answers_policy:'One row per session, union of question/axis columns across participating versions and latest version; only sealed page answers are confirmed; missing answers stay empty with explicit state; dates are YYYY-MM-DD HH:mm:ss.SSS in Asia/Shanghai',trajectory_policy:'One row per interaction sample or GROUP_RECORD, including diagnostic/blocked events with disposition/reason; at and time_origin retained when present; clock_epoch/clock_origin required to compare different run clocks; row order is not a global chronology',
          dictionary:{consents:'Explicit agreement to frozen consent document; SHA-256 of stableJSON(consent); accepted_at is server Unix milliseconds in data.csv and formatted Beijing time in answers.csv; join sessions/version protocol for exact text',event_schema:'lab-events-v1',runner:'canvas-v1',axis_answers:'One row per axis in data.csv; integer value and configured label; null means unanswered; skipped/unconfirmed/not-reached states retained',question_states:{ANSWERED:'sealed valid answer',UNANSWERED:'sealed visible optional empty answer',SKIPPED:'verified branch hidden',UNCONFIRMED:'no sealed final snapshot for current page',NOT_REACHED:'page position not reached',NOT_IN_VERSION:'question or axis does not exist in this session version'},software_quality:'SOFTWARE_ONLY; physical display/input timing unverified',human_marks:'append-only annotations; never rewrite raw or system diagnosis'}};
        await writeDurable(join(target,'manifest.json'),stableJSON(manifest));await syncDirectory(target);return manifest;
      }finally{for(const descriptor of descriptors)closeSync(descriptor);if(db.inTransaction)db.exec('ROLLBACK');}
    }
    throw new Error('UNSUPPORTED_MAINTENANCE_JOB');
  }finally{db.close();}
}
try{const result=await run();parentPort!.postMessage({result});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:'MAINTENANCE_FAILED',validation_rejected:(error as {validation_rejected?:boolean})?.validation_rejected===true});}finally{parentPort!.close();}
