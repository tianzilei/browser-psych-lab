import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../src/server/database.ts';
import {LabStore} from '../src/server/lab-store.ts';
import {digest} from '../src/server/collection-store.ts';
import {storedRawBytes} from '../src/server/evidence-storage.ts';
import {sampleProtocol} from '../src/shared/protocol.ts';

// An isolated SQLite writer-path probe. No live database or participant data.
const directory=mkdtempSync(join(tmpdir(),'bpl-ingestion-profile-'));
const db=openDatabase(join(directory,'database.sqlite'));
try {
  const store=new LabStore(db),csrf=randomUUID(),token=digest('TEST_ONLY-profile-admin');
  store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const admin=(op,data)=>store.execute({operation:`lab/${op}`,credential_hash:token,data:{csrf,...data}});
  const study=admin('study.create',{request_id:randomUUID()});
  const protocol=sampleProtocol();protocol.questionnaire_layout='adaptive';
  const saved=admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol});
  const version=admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});
  admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
  let rawByteReads=0,frozenReads=0;
  db.function('lab_raw_bytes',{deterministic:true},raw=>{rawByteReads++;return storedRawBytes(raw);});
  const frozen=store.frozen.bind(store);store.frozen=(...args)=>{frozenReads++;return frozen(...args);};
  const results=[];
  for(const kind of ['PAGE_REVISION','INPUT_DIAGNOSTIC']) {
    const credential=digest(randomUUID());
    const session=store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:version.version_id,credential_hash:credential}});
    const call=(op,data)=>store.execute({operation:`lab/participant.${op}`,session_id:session.session_id,credential_hash:credential,data});
    const claim=call('claim',{request_id:randomUUID(),writer_id:'TEST_ONLY-profile-writer'});
    const scope=kind==='PAGE_REVISION'?'welcome':'d-ui-profile';
    const payload=kind==='PAGE_REVISION'?{question_id:'ready',answer:'是'}:{interaction:{schema:'interaction-v1',time_origin:100000,
      samples:[{type:'input',at:1,context:{page_id:'welcome'},value:'测试样式'.repeat(600)}]}};
    let sequence=0,previous=null;
    function batch() {
      return Array.from({length:16},()=>{
        const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:session.session_id,version_id:version.version_id,
          protocol_hash:version.hash,writer_id:'TEST_ONLY-profile-writer',writer_epoch:claim.writer_epoch,scope,sequence,previous,
          clock_epoch:'TEST_ONLY-profile-clock',time_ms:sequence++,kind,payload};
        const raw=JSON.stringify(event),wire={event_id:event.event_id,hash:digest(raw),raw};
        previous={event_id:wire.event_id,hash:wire.hash};return wire;
      });
    }
    for(const retained of [0,1024,4096]) {
      while(sequence<retained)assert.ok(call('ingest',{events:batch()}).receipts.every(r=>r.disposition==='ACCEPTED'));
      rawByteReads=0;frozenReads=0;const times=[],retries=[];
      for(let iteration=0;iteration<10;iteration++) {
        const events=batch(),started=performance.now(),response=call('ingest',{events});
        times.push(performance.now()-started);assert.ok(response.receipts.every(r=>r.disposition==='ACCEPTED'));
        const retryStarted=performance.now();assert.deepEqual(call('ingest',{events}),response);retries.push(performance.now()-retryStarted);
      }
      const percentile=(values,p)=>Number(values.toSorted((a,b)=>a-b)[Math.ceil(values.length*p)-1].toFixed(3));
      results.push({kind,retained_at_start:retained,batch_events:16,measured_batches:times.length,
        p50_ms:percentile(times,.5),p95_ms:percentile(times,.95),retry_p50_ms:percentile(retries,.5),
        raw_byte_function_calls:rawByteReads,frozen_loads:frozenReads});
    }
  }
  const report={schema:'ingestion-profile-v1',mode:'TEST_ONLY',sampled_at:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,
    scope:'Local synchronous LabStore ingestion with WAL/FULL and macOS fullfsync when applicable; 10 batches per depth plus exact retries. Excludes HTTP, worker RPC, real mobile devices and ECS capacity.',results};
  const output=JSON.stringify(report,null,2)+'\n';
  if(process.argv[2])writeFileSync(resolve(process.argv[2]),output);
  process.stdout.write(output);
} finally {db.close();rmSync(directory,{recursive:true,force:true});}
