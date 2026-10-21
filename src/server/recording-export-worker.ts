import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';
import {createWriteStream} from 'node:fs';
import {chmod,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {decodeRaw} from './evidence-storage.js';
import {fileHash,assetPath,writeDurable} from './private-files.js';
import {isReplayScreen} from '../shared/replay-recording.js';
import {offlineReplayDocument} from './offline-replay-document.js';
import {recordingPhotos} from './recording-photos.js';

const config=workerData as {database:string;session:string;path:string;format:'json'|'html';root:string;playerPath:string};
async function run(){
  const db=new Database(config.database,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  try{
    db.exec('BEGIN');
    const session=db.prepare('SELECT s.session_id,s.study_id,s.version_id,s.state,t.title AS study_title FROM lab_sessions s JOIN lab_studies t USING(study_id) WHERE session_id=?').get(config.session);
    if(!session)throw new Error('SESSION_NOT_FOUND');
    const target=createWriteStream(config.path,{flags:'wx',mode:0o600}),gzip=createGzip({level:6});
    const completed=pipeline(gzip,target);void completed.catch(()=>{});
    let bytes=0,records=0;const source=createHash('sha256'),assets=new Set<string>();
    async function emit(text:string){bytes+=Buffer.byteLength(text);if(bytes>(config.format==='html'?128:1024)*1024*1024)throw new Error('TRAJECTORY_EXPORT_TOO_LARGE');if(!gzip.write(text))await once(gzip,'drain');}
    try{
      await emit(JSON.stringify({schema:'session-trajectory-v1',...session,photos:recordingPhotos(db,config.session),photo_identity_policy:'Photos are mapped from this session permit plans and immutable asset metadata; join each sample context.instance_id/asset_id to photos; original raw_utf8 bytes are unchanged.',exported_at:new Date().toISOString(),raw_encoding:'exact original UTF-8 in raw_utf8; SHA-256 applies to decoded raw_utf8 bytes',evidence_policy:'All retained d-ui scopes for this session, including noncanonical or rejected evidence; no credentials or other sessions'}).slice(0,-1)+',"events":[');
      const rows=db.prepare(`SELECT r.event_id,r.hash,r.scope,r.receipt_id,r.received_at,r.raw,d.disposition,d.version AS disposition_version,d.reason,CASE WHEN e.hash=r.hash THEN 1 ELSE 0 END AS canonical
        FROM lab_raw r JOIN lab_dispositions d USING(receipt_id) LEFT JOIN lab_events e ON e.session_id=r.session_id AND e.event_id=r.event_id WHERE r.session_id=? AND r.scope LIKE 'd-ui-%'
        AND d.version=(SELECT max(v.version) FROM lab_dispositions v WHERE v.receipt_id=r.receipt_id) ORDER BY r.rowid`);
      for(const row of rows.iterate(config.session) as Iterable<Record<string,unknown>>){
        if(++records>100000)throw new Error('TRAJECTORY_EXPORT_TOO_LARGE');
        const {raw,...metadata}=row,decoded=decodeRaw(raw as Buffer,String(row.hash));source.update(String(row.event_id));source.update('\0');source.update(String(row.hash));
        if(config.format==='html'&&row.canonical){const batch=(JSON.parse(decoded.toString('utf8')) as {payload:{interaction?:{samples?:unknown[]}}}).payload.interaction;
          if(Array.isArray(batch?.samples))for(const sample of batch.samples)if(isReplayScreen(sample))for(const node of sample.nodes)if(node.tag==='canvas'&&node.asset_id)assets.add(node.asset_id);
        }
        await emit((records===1?'':',')+JSON.stringify({...metadata,raw_utf8:decoded.toString('utf8')}));
      }
      await emit('],"embedded_assets":{');let totalAssets=0,index=0;
      // Screen snapshots are client-authored. Only embed an image that this
      // session's frozen plans actually reference and that belongs to its study;
      // unknown or foreign ids are skipped instead of failing the whole replay.
      const allowedAssets=new Set<string>();
      for(const row of db.prepare('SELECT plan FROM lab_permits WHERE session_id=?').iterate(config.session) as Iterable<{plan:string}>){
        const plan=JSON.parse(row.plan) as {roots?:{asset_id?:string}[]};
        for(const root of plan.roots??[])if(root.asset_id)allowedAssets.add(root.asset_id);
      }
      for(const asset of assets){
        if(!allowedAssets.has(asset))continue;
        const info=db.prepare("SELECT a.hash,a.bytes,a.format FROM lab_assets a JOIN lab_sessions s USING(study_id) WHERE s.session_id=? AND a.asset_id=? AND a.state='READY'").get(config.session,asset) as {hash:string;bytes:number;format:string}|undefined;
        if(!info)continue;
        if(!['png','jpeg','webp'].includes(info.format))continue;
        totalAssets+=info.bytes;if(totalAssets>64*1024*1024)throw new Error('TRAJECTORY_EXPORT_TOO_LARGE');
        const packed=await readFile(await assetPath(config.root,asset));if(createHash('sha256').update(packed).digest('hex')!==info.hash)throw new Error('REPLAY_IMAGE_HASH_MISMATCH');
        await emit((index++?',':'')+JSON.stringify(asset)+':'+JSON.stringify({hash:info.hash,data_url:`data:image/${info.format};base64,${packed.toString('base64')}`}));
      }
      await emit('},"record_count":'+records+',"source_hash":'+JSON.stringify(source.digest('hex'))+'}\n');gzip.end();await completed;
    }catch(error){gzip.destroy(error instanceof Error?error:new Error(String(error)));await completed.catch(()=>{});throw error;}
    db.exec('COMMIT');await chmod(config.path,0o600);let path=config.path;
    if(config.format==='html'){const packed=await readFile(config.path);if(packed.length>64*1024*1024)throw new Error('TRAJECTORY_EXPORT_TOO_LARGE');path=join(dirname(config.path),'replay.html');await writeDurable(path,offlineReplayDocument(packed.toString('base64'),await readFile(config.playerPath,'utf8')));}
    return {path,hash:await fileHash(path),records,uncompressed_bytes:bytes};
  }finally{db.close();}
}
try{parentPort!.postMessage({result:await run()});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:'TRAJECTORY_EXPORT_FAILED'});}finally{parentPort!.close();}
