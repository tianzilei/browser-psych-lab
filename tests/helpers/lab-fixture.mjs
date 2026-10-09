import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/server/database.ts';
import {LabStore} from '../../src/server/lab-store.ts';
import {digest} from '../../src/server/collection-store.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';
export function fixture(t,protocol=sampleProtocol(),options={}){
  const root=mkdtempSync(join(tmpdir(),'bpl-lab-')),path=join(root,'db.sqlite'),db=openDatabase(path);let now=1000;const store=new LabStore(db,digest('TEST_ONLY-runner'),()=>now,options.sessionConcurrency??2);
  t.after(()=>{try{db.close();}catch{}rmSync(root,{recursive:true,force:true});});
  const token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const admin=(op,data={})=>store.execute({operation:`lab/${op}`,credential_hash:token,data:{csrf,...data}});
  const study=admin('study.create',{request_id:randomUUID()});
  const saved=admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol});
  const version=admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  const credential=digest(randomUUID()),admission={request_id:randomUUID(),version_id:version.version_id,credential_hash:credential};
  const created=store.execute({operation:'lab/participant.create',data:admission});
  const call=(op,data={})=>store.execute({operation:`lab/participant.${op}`,session_id:created.session_id,credential_hash:credential,data});
  const claim=call('claim',{request_id:randomUUID(),writer_id:'writer-a'}),fence={writer_id:'writer-a',writer_epoch:claim.writer_epoch};
  let seq=0,previous=null;
  const wire=(scope,kind,payload,changes={})=>{const e={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:created.session_id,version_id:version.version_id,protocol_hash:version.hash,...fence,scope,sequence:seq++,previous,clock_epoch:'clock-a',time_ms:seq,kind,payload,...changes};const raw=JSON.stringify(e),row={event_id:e.event_id,hash:digest(raw),raw};previous={event_id:row.event_id,hash:row.hash};return row;};
  const ingest=events=>call('ingest',{events});
  const seal=(scope,events,path)=>call('seal',{request_id:randomUUID(),...fence,manifest:{manifest_id:randomUUID(),scope,path,events:events.map(({event_id,hash})=>({event_id,hash}))}});
  return {root,path,db,store,study,version,admin,admission,created,call,fence,wire,ingest,seal,setNow:v=>now=v};
}
