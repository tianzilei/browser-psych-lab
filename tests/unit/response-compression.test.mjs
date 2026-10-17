import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Readable,PassThrough} from 'node:stream';
import {request as httpRequest} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {installResponseCompression} from '../../src/server/response-compression.ts';
import {ContractError} from '../../src/shared/contract.ts';

const json={title:'中文问卷',questions:Array.from({length:200},(_,index)=>({id:`q${index}`,title:'请选择符合您情况的选项',choices:['非常不同意','不同意','一般','同意','非常同意']}))};
const csv='\uFEFFid,answer\r\n'+Array.from({length:2000},(_,i)=>`${i},"中文,原始答案"\r\n`).join('');
function appFor(t){
  const app=Fastify();installResponseCompression(app);
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof ContractError?error.status:500).send({code:error.code??'FAILED'}));
  app.get('/api/participate/versions/test',(_req,reply)=>reply.header('Cache-Control','private, no-store').header('Vary','Origin').send(json));
  app.get('/api/lab/jobs/test/answers.csv',(_req,reply)=>reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="answers.csv"').header('Content-Length',Buffer.byteLength(csv)).send(Readable.from([csv])));
  app.get('/api/participate/sessions/test',()=>({status:'ok'}));
  app.get('/api/lab/assets/test',(_req,reply)=>reply.type('image/png').send(Buffer.alloc(12000,42)));
  app.post('/api/participate/sessions/test/reanswer',()=>({...json,credential:'test-secret'}));
  app.get('/api/lab/packed',(_req,reply)=>reply.type('application/json').header('Content-Encoding','gzip').send(Buffer.from('already-encoded')));
  t.after(()=>app.close());return app;
}
test('large API JSON negotiates gzip and preserves bytes, cache policy and Vary',async t=>{
  const app=appFor(t),response=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'br, gzip'}});
  assert.equal(response.headers['content-encoding'],'gzip');assert.equal(gunzipSync(response.rawPayload).toString(),JSON.stringify(json));
  assert.ok(response.rawPayload.length<Buffer.byteLength(JSON.stringify(json))/4);
  assert.equal(response.headers.vary,'Origin, Accept-Encoding');assert.equal(response.headers['cache-control'],'private, no-store');
  assert.equal(Number(response.headers['content-length']),response.rawPayload.length);
  for(const header of [undefined,'gzip;q=0, identity','identity;q=1, gzip;q=0.5']){
    const plain=await app.inject({url:'/api/participate/versions/test',headers:header?{'accept-encoding':header}:{}});
    assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(plain.json(),json);
  }
  const refused=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'br, identity;q=0'}});assert.equal(refused.statusCode,406);
});
test('CSV compresses as a stream while the downloaded bytes and filename stay identical',async t=>{
  const response=await appFor(t).inject({url:'/api/lab/jobs/test/answers.csv',headers:{'accept-encoding':'gzip'}});
  assert.equal(response.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(response.rawPayload),Buffer.from(csv));
  assert.equal(response.headers['content-length'],undefined);assert.equal(response.headers['content-disposition'],'attachment; filename="answers.csv"');
});
test('small controls, images, credential replies and existing compressed bodies retain their representations',async t=>{
  const app=appFor(t);
  for(const [url,method]of [['/api/participate/sessions/test','GET'],['/api/lab/assets/test','GET'],['/api/participate/sessions/test/reanswer','POST']]){
    const response=await app.inject({url,method,headers:{'accept-encoding':'gzip'}});assert.equal(response.headers['content-encoding'],undefined);
  }
  const packed=await app.inject({url:'/api/lab/packed',headers:{'accept-encoding':'gzip'}});assert.equal(packed.body,'already-encoded');
  const forced=await app.inject({url:'/api/participate/sessions/test',headers:{'accept-encoding':'gzip, identity;q=0'}});
  assert.equal(gunzipSync(forced.rawPayload).toString(),'{"status":"ok"}');
});
test('slow CSV streams bound compression jobs; aborting clients closes sources and frees slots',async t=>{
  const app=appFor(t),sources=[],connections=[];
  let notify;app.get('/api/lab/slow.csv',(_req,reply)=>{const source=new PassThrough();sources.push(source);source.write('pending');notify?.();return reply.type('text/csv').send(source);});
  const origin=await app.listen({host:'127.0.0.1',port:0});
  t.after(()=>{for(const connection of connections)connection.destroy();for(const source of sources)source.destroy();});
  for(let i=0;i<2;i++){
    const reached=new Promise(resolve=>{notify=resolve;});const connection=httpRequest(`${origin}/api/lab/slow.csv`,{headers:{'accept-encoding':'gzip'}});
    connection.on('error',()=>{});connection.end();connections.push(connection);await reached;
  }
  // Both gzip streams are occupied. Identity-capable clients proceed normally.
  const plain=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'gzip'}});assert.equal(plain.headers['content-encoding'],undefined);
  const busy=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'gzip, identity;q=0'}});assert.equal(busy.statusCode,503);
  const busyStream=await app.inject({url:'/api/lab/slow.csv',headers:{'accept-encoding':'gzip, identity;q=0'}});assert.equal(busyStream.statusCode,503);assert.equal(sources.at(-1).destroyed,true);
  const refusedStream=await app.inject({url:'/api/lab/slow.csv',headers:{'accept-encoding':'br, identity;q=0'}});assert.equal(refusedStream.statusCode,406);assert.equal(sources.at(-1).destroyed,true);
  for(const connection of connections)connection.destroy();
  const deadline=Date.now()+2000;while(sources.some(source=>!source.destroyed)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(sources.every(source=>source.destroyed));
  const recovered=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'gzip, identity;q=0'}});assert.equal(recovered.statusCode,200);assert.equal(recovered.headers['content-encoding'],'gzip');
});
test('stream read errors reach the gzip consumer and do not retain a compression slot',async t=>{
  const app=appFor(t);app.get('/api/lab/fault.csv',(_req,reply)=>reply.type('text/csv').send(new Readable({read(){this.destroy(new Error('injected read failure'));}})));
  const response=await app.inject({url:'/api/lab/fault.csv',headers:{'accept-encoding':'gzip'}});assert.equal(response.statusCode,500);
  const recovered=await app.inject({url:'/api/participate/versions/test',headers:{'accept-encoding':'gzip, identity;q=0'}});assert.equal(recovered.statusCode,200);
});
