import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {prepareJsonPost} from '../src/web/json-transport.ts';
import {JSON_TRANSPORT} from '../src/shared/transport.ts';

const option=name=>process.argv.slice(2).find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const unzip=promisify(gunzip),encoder=new TextEncoder(),path='/api/participate/sessions/TEST_ONLY/ingest';
const wire=event=>{const raw=JSON.stringify(event);return {event_id:event.event_id,hash:createHash('sha256').update(raw).digest('hex'),raw};};
const events=Array.from({length:16},(_,sequence)=>wire({event_schema_version:'lab-events-v1',event_id:`TEST_ONLY-${sequence}`,session_id:'TEST_ONLY',
  scope:'d-ui-profile',sequence,kind:'INPUT_DIAGNOSTIC',payload:{interaction:{schema:'interaction-v1',time_origin:100000,samples:Array.from({length:24},(_,i)=>({
    type:'pointermove',at:sequence*100+i,raw_timestamp:sequence*100+i,rt_ms:i,context:{page_id:'TEST_ONLY',question_id:'scale',phase:'answer'},
    target:'#scale',box:{x:10,y:100,width:300,height:40},x:10+i,y:120,pointer_id:1,pointer_type:'touch',button:-1,buttons:1,pressure:.5,
    width:12,height:12,tilt_x:0,tilt_y:0,twist:0,tangential_pressure:0,is_primary:true,coalesced:true,trusted:true,value:String(i),
  }))}}}));
assert.ok(events.reduce((sum,event)=>sum+Buffer.byteLength(event.raw),0)<=256*1024);
const cases=[{label:'small-control',url:'/api/participate/sessions/TEST_ONLY/activity',json:JSON.stringify({writer_id:'TEST_ONLY',writer_epoch:1,elapsed_ms:60000}),events:[]},
  {label:'synthetic-16-event-interaction-batch',url:path,json:JSON.stringify({batch_id:'TEST_ONLY-stable',events}),events}];
const browserPath=option('browser-records');
if(browserPath){const browser=JSON.parse(await readFile(browserPath,'utf8'));cases.push({label:'chromium-test-collected-records',url:path,json:JSON.stringify({batch_id:'TEST_ONLY-browser',events:browser}),events:browser});}
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const results=[];
for(const item of cases){
  const prepare=[],decode=[],hash=[],bytes=Buffer.byteLength(item.json);let encoded;
  for(let iteration=0;iteration<11;iteration++){
    let started=performance.now();encoded=await prepareJsonPost(item.url,item.json);const prepareMs=performance.now()-started;
    started=performance.now();const text=encoded.headers['Content-Encoding']==='gzip'?(await unzip(Buffer.from(encoded.body))).toString():encoded.body;
    const parsed=JSON.parse(text),decodeMs=performance.now()-started;assert.equal(text,item.json);
    if(item.events.length) assert.deepEqual(parsed.events,item.events);
    started=performance.now();await Promise.all(item.events.map(async event=>{
      const digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',encoder.encode(event.raw))).toString('hex');assert.equal(digest,event.hash);
    }));const hashMs=performance.now()-started;
    if(iteration){prepare.push(prepareMs);decode.push(decodeMs);hash.push(hashMs);}
  }
  const wireBytes=typeof encoded.body==='string'?Buffer.byteLength(encoded.body):encoded.body.byteLength;
  results.push({label:item.label,event_count:item.events.length,decoded_json_bytes:bytes,wire_body_bytes:wireBytes,encoding:encoded.headers['Content-Encoding']??'identity',
    saved_percent:Number(((1-wireBytes/bytes)*100).toFixed(2)),median_prepare_ms:Number(median(prepare).toFixed(3)),
    median_decode_and_parse_ms:Number(median(decode).toFixed(3)),median_utf8_and_sha256_ms:Number(median(hash).toFixed(3))});
}
const report={mode:'TEST_ONLY',schema:'transport-profile-v1',sampled_at:new Date().toISOString(),runtime:process.version,platform:process.platform,
  scope:'Local Node native CompressionStream/WebCrypto and asynchronous zlib. Chromium records, when supplied, are test fixtures. No mobile/ECS timing or capacity claim.',
  measured_iterations:10,policy:JSON_TRANSPORT,results};
const output=JSON.stringify(report,null,2);if(option('out'))await writeFile(option('out'),`${output}\n`);process.stdout.write(`${output}\n`);
