import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {Readable} from 'node:stream';
import Fastify from 'fastify';
import {openDatabase} from '../src/server/database.ts';
import {encodeRaw,decodeRaw} from '../src/server/evidence-storage.ts';
import {prepareJsonPost} from '../src/web/json-transport.ts';
import {installJsonTransport} from '../src/server/json-transport.ts';

const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const uuid=value=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
const median=values=>Number(values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(4));
const directory=mkdtempSync(join(tmpdir(),'bpl-transfer-profile-'));
const app=Fastify();installJsonTransport(app);
const compressionPath=new URL('../src/server/response-compression.ts',import.meta.url);
const responseCompression=existsSync(fileURLToPath(compressionPath));
if(responseCompression)(await import(compressionPath.href)).installResponseCompression(app);
const storage=[],uploads=[],downloads=[];
try{
  for(const kind of ['PAGE_REVISION','INPUT_DIAGNOSTIC']){
    const rows=Array.from({length:1000},(_,sequence)=>Buffer.from(JSON.stringify({event_schema_version:'lab-events-v1',event_id:uuid(sequence),session_id:uuid('session'),version_id:uuid('version'),protocol_hash:digest('protocol'),
      writer_id:uuid('writer'),writer_epoch:1,scope:kind==='PAGE_REVISION'?'welcome':'d-ui-profile',sequence,previous:sequence?{event_id:uuid(sequence-1),hash:digest(sequence-1)}:null,
      clock_epoch:uuid('clock'),time_ms:sequence*12.345,kind,payload:kind==='PAGE_REVISION'?{question_id:'ready',answer:sequence%2?'是':'否'}:{interaction:{schema:'interaction-v1',time_origin:100000,
        samples:[{type:'input',at:sequence,context:{page_id:'welcome'},value:'测试样式'.repeat(600)}]}}})));
    const packed=[],times=[];
    for(const raw of rows){const start=performance.now(),bytes=encodeRaw(raw);times.push(performance.now()-start);assert.deepEqual(decodeRaw(bytes,digest(raw)),raw);packed.push(bytes);}
    const path=join(directory,`${kind}.sqlite`),db=openDatabase(path);
    try{db.exec('CREATE TABLE evidence(raw BLOB NOT NULL) STRICT');const insert=db.prepare('INSERT INTO evidence VALUES (?)');db.transaction(()=>{for(const bytes of packed)insert.run(bytes);}).immediate();db.pragma('wal_checkpoint(TRUNCATE)');
      storage.push({kind,records:rows.length,logical_bytes:rows.reduce((n,b)=>n+b.length,0),stored_payload_bytes:packed.reduce((n,b)=>n+b.length,0),sqlite_file_bytes:statSync(path).size,median_encode_ms:median(times)});
    }finally{db.close();}
  }
  const refs=Array.from({length:5000},(_,i)=>({event_id:uuid(i),hash:digest(i)}));
  const manifest={request_id:uuid('request'),writer_id:uuid('writer'),writer_epoch:1,manifest:{manifest_id:uuid('manifest'),scope:'welcome',path:['welcome'],events:refs}};
  const questionnaire={schema:'questionnaire-v1',title:'TEST_ONLY transfer profile',pages:Array.from({length:20},(_,p)=>({id:`page${p}`,questions:Array.from({length:10},(_,q)=>({id:`q${p}-${q}`,type:'single',title:`第 ${p*10+q+1} 题：请选择符合您情况的选项`,choices:['非常不同意','不同意','一般','同意','非常同意']}))}))};
  const cases=[['seal','/api/participate/sessions/profile/seal',manifest],['reconcile','/api/participate/sessions/profile/reconcile',manifest],['questionnaire-import','/api/lab/studies/profile/import',{request_id:uuid('import'),source:JSON.stringify(questionnaire)}]];
  for(const [,url]of cases)app.post(url,request=>request.body);
  app.get('/api/participate/versions/profile',()=>({protocol:questionnaire,assets:[]}));
  const csv='\uFEFFsession_id,question_id,answer\r\n'+Array.from({length:10000},(_,i)=>`${uuid(i)},q${i%200},"中文,原始答案 ${i%7}"\r\n`).join('');
  app.get('/api/lab/jobs/profile/answers.csv',(_request,reply)=>reply.type('text/csv; charset=utf-8').send(Readable.from(Array.from({length:Math.ceil(csv.length/16384)},(_,i)=>csv.slice(i*16384,(i+1)*16384)))));
  for(const [label,url,data]of cases){
    const json=JSON.stringify(data),times=[];let prepared;
    for(let i=0;i<11;i++){const start=performance.now();prepared=await prepareJsonPost(url,json);if(i)times.push(performance.now()-start);}
    const body=typeof prepared.body==='string'?Buffer.from(prepared.body):Buffer.from(prepared.body);
    assert.equal((prepared.headers['Content-Encoding']==='gzip'?gunzipSync(body):body).toString(),json);
    const response=await app.inject({method:'POST',url,headers:prepared.headers,payload:body});assert.equal(response.statusCode,200,response.body);
    const decoded=response.headers['content-encoding']==='gzip'?gunzipSync(response.rawPayload):response.rawPayload;assert.deepEqual(JSON.parse(decoded.toString()),data);
    uploads.push({label,logical_bytes:Buffer.byteLength(json),wire_body_bytes:body.length,encoding:prepared.headers['Content-Encoding']??'identity',median_prepare_ms:median(times)});
  }
  for(const [label,url,original]of [['questionnaire-json','/api/participate/versions/profile',JSON.stringify({protocol:questionnaire,assets:[]})],['answers-csv','/api/lab/jobs/profile/answers.csv',csv]]){
    const times=[];let response;
    for(let i=0;i<11;i++){const start=performance.now();response=await app.inject({url,headers:{'accept-encoding':'gzip'}});if(i)times.push(performance.now()-start);assert.equal(response.statusCode,200);}
    const decoded=response.headers['content-encoding']==='gzip'?gunzipSync(response.rawPayload):response.rawPayload;assert.equal(decoded.toString(),original);
    downloads.push({label,logical_bytes:Buffer.byteLength(original),wire_body_bytes:response.rawPayload.length,encoding:response.headers['content-encoding']??'identity',median_handler_and_encoding_ms:median(times)});
  }
  const report={schema:'transfer-storage-profile-v1',mode:'TEST_ONLY',sampled_at:new Date().toISOString(),runtime:process.version,platform:process.platform,arch:process.arch,response_compression_installed:responseCompression,
    scope:'Deterministic synthetic records. Storage: 1,000 encoded raw payloads in an isolated one-column SQLite table, WAL checkpointed; not total application DB size. Upload: native CompressionStream plus real bounded server parser round-trip. Download: Fastify inject encoded JSON and streamed CSV, exact decoded bytes verified. Excludes sockets, TLS, HTTP headers, mobile/ECS CPU and real network latency.',storage,uploads,downloads};
  const output=JSON.stringify(report,null,2)+'\n';if(process.argv[2])writeFileSync(resolve(process.argv[2]),output);process.stdout.write(output);
}finally{await app.close();rmSync(directory,{recursive:true,force:true});}
