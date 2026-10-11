import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash,randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {installJsonTransport,jsonReceiveCharge} from '../../src/server/json-transport.ts';
import {prepareJsonPost} from '../../src/web/json-transport.ts';
import {request} from '../../src/web/dom.ts';
import {ContractError} from '../../src/shared/contract.ts';

const path='/api/participate/sessions/test/ingest';
const large=JSON.stringify({raw:JSON.stringify({text:'中文🙂\n'.repeat(4000)}),request_id:'stable-request'});
const headers=body=>({'content-type':'application/json','content-encoding':'gzip','x-uncompressed-length':String(Buffer.byteLength(body))});
function appFor(t) {
  const app=Fastify();installJsonTransport(app);
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof ContractError?error.status:error.statusCode??500).send({code:error.code,ingestion:'NOT_INGESTED'}));
  app.post('/api/participate/sessions/:session/ingest',req=>({raw:req.body.raw,hash:createHash('sha256').update(req.body.raw).digest('hex')}));
  app.post('/api/participate/sessions/:session/covariates',req=>req.body);
  app.post('/api/participate/sessions/:session/seal',req=>req.body);
  t.after(()=>app.close());return app;
}
test('native gzip reduces large JSON, keeps exact Unicode raw/hash and small/control requests plain',async t=>{
  const app=appFor(t),wire=await prepareJsonPost(path,large);
  assert.equal(wire.headers['Content-Encoding'],'gzip');assert.ok(wire.body.byteLength<Buffer.byteLength(large)*.875);
  assert.equal(gunzipSync(Buffer.from(wire.body)).toString(),large);
  const response=await app.inject({method:'POST',url:path,headers:wire.headers,payload:Buffer.from(wire.body)});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{raw:JSON.parse(large).raw,hash:createHash('sha256').update(JSON.parse(large).raw).digest('hex')});
  for (const [url,body] of [[path,'{"raw":"tiny"}'],['/api/participate/sessions/test/seal',large]]) {
    const plain=await prepareJsonPost(url,body);assert.equal(plain.body,body);assert.equal(plain.headers['Content-Encoding'],undefined);
  }
});
test('absent, failing or unhelpful compression falls back to the identical plain request',async t=>{
  const native=globalThis.CompressionStream;t.after(()=>{globalThis.CompressionStream=native;});
  globalThis.CompressionStream=undefined;assert.equal((await prepareJsonPost(path,large)).body,large);
  globalThis.CompressionStream=class {constructor(){throw new Error('unavailable');}};
  assert.equal((await prepareJsonPost(path,large)).body,large);
  globalThis.CompressionStream=native;
  const random=JSON.stringify({raw:randomBytes(20000).toString('latin1')});
  // JSON escaping makes random bytes compressible, so test the ratio decision via a valid native-sized stream.
  globalThis.CompressionStream=class extends TransformStream {constructor(){super({transform(chunk,c){c.enqueue(chunk);}});}};
  assert.equal((await prepareJsonPost(path,random)).body,random);
});
test('explicit overload retry reuses the same compressed bytes and original event identities',async t=>{
  const bodies=[],native=globalThis.CompressionStream;let compressions=0;
  t.mock.method(globalThis,'CompressionStream',class extends native {constructor(format){super(format);compressions++;}});
  t.mock.method(globalThis,'fetch',async (_url,options)=>{bodies.push(options.body);return bodies.length===1?new Response('{}',{status:503,headers:{'Retry-After':'0'}}):new Response('{"ok":true}');});
  assert.deepEqual(await request(path,JSON.parse(large)),{ok:true});
  assert.equal(compressions,1);assert.equal(bodies.length,2);assert.strictEqual(bodies[0],bodies[1]);
  assert.equal(gunzipSync(Buffer.from(bodies[0])).toString(),large);
});
test('malformed, truncated, CRC-corrupt, wrong-length and expanding gzip never reach a handler; slots recover',async t=>{
  const app=appFor(t),zipped=gzipSync(large),corrupt=Buffer.from(zipped);corrupt[corrupt.length-8]^=255;
  const cases=[
    [Buffer.from('not gzip'),headers(large),400],
    [zipped.subarray(0,zipped.length-5),headers(large),400],
    [corrupt,headers(large),400],
    [zipped,{...headers(large),'x-uncompressed-length':String(Buffer.byteLength(large)+1)},400],
    [zipped,{...headers(large),'x-uncompressed-length':'10'},413],
    [zipped,{...headers(large),'x-uncompressed-length':'1048577'},413],
    [zipped,{...headers(large),'x-uncompressed-length':'1e5'},400],
    [zipped,{...headers(large),'content-encoding':'br'},415],
  ];
  for (const [payload,requestHeaders,status] of cases) {
    const response=await app.inject({method:'POST',url:path,headers:requestHeaders,payload});
    assert.equal(response.statusCode,status,response.body);assert.equal(response.json().ingestion,'NOT_INGESTED');
  }
  const blocked=await app.inject({method:'POST',url:path.replace('ingest','seal'),headers:headers(large),payload:zipped});assert.equal(blocked.statusCode,415);
  const valid=await app.inject({method:'POST',url:path,headers:headers(large),payload:zipped});assert.equal(valid.statusCode,200,valid.body);
});
test('receive charge uses declared decoded bytes; chunked wire still reserves the whole allowance',()=>{
  const request={headers:{'content-encoding':'gzip','x-uncompressed-length':'800000'}};
  assert.ok(jsonReceiveCharge(request,1000)>1_600_000);
  assert.ok(jsonReceiveCharge(request,1_048_576)>2_648_576);
  assert.equal(jsonReceiveCharge({headers:{}},1000),3024);
});
test('unfinished gzip connections cap at four, allow plain controls, and aborted clients release slots',async t=>{
  const app=appFor(t);let arrived=0,notify;
  app.addHook('onRequest',async req=>{if(req.headers['content-encoding']==='gzip'){arrived++;notify?.();}});
  const origin=await app.listen({host:'127.0.0.1',port:0}),connections=[];
  t.after(()=>{for(const connection of connections) connection.destroy();});
  for (let i=0;i<4;i++) {
    const connection=httpRequest(`${origin}${path}`,{method:'POST',headers:headers(large)});connection.on('error',()=>{});connections.push(connection);
    const reached=new Promise(resolve=>{notify=resolve;});connection.write(gzipSync(large).subarray(0,10));await reached;
  }
  assert.equal(arrived,4);
  assert.equal((await app.inject({method:'POST',url:path,headers:headers(large),payload:gzipSync(large)})).statusCode,503);
  assert.equal((await app.inject({method:'POST',url:path.replace('ingest','seal'),payload:{control:true}})).statusCode,200);
  for (const connection of connections) connection.destroy();
  // Wait for real server abort notifications, with a bounded test deadline.
  const deadline=Date.now()+2000;let response;
  do {await new Promise(resolve=>setTimeout(resolve,10));response=await app.inject({method:'POST',url:path,headers:headers(large),payload:gzipSync(large)});} while(response.statusCode===503&&Date.now()<deadline);
  assert.equal(response.statusCode,200,response.body);
});

test('stalled gzip body times out before ingestion and frees its decoder',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const app=appFor(t);
  let notify;const reached=new Promise(resolve=>{notify=resolve;});app.addHook('preParsing',async(_req,_reply,payload)=>{notify();return payload;});
  const origin=await app.listen({host:'127.0.0.1',port:0});let connection;
  const finished=new Promise((resolve,reject)=>{
    connection=httpRequest(`${origin}${path}`,{method:'POST',headers:headers(large)},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body}));});connection.on('error',reject);
  });t.after(()=>connection.destroy());
  connection.write(gzipSync(large).subarray(0,10));await reached;t.mock.timers.tick(15000);
  const result=await finished;assert.equal(result.status,408);assert.deepEqual(JSON.parse(result.body),{code:'REQUEST_BODY_TIMEOUT',ingestion:'NOT_INGESTED'});
  const valid=await app.inject({method:'POST',url:path,headers:headers(large),payload:gzipSync(large)});assert.equal(valid.statusCode,200,valid.body);
});
