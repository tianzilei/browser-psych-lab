import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PreparationQueue} from '../../src/server/preparation-queue.ts';
import {downloadBudget,downloadOriginal} from '../../src/web/asset-download.ts';
import {request} from '../../src/web/dom.ts';
test('preparation rejects full capacity without a queue and releases only after actual stream exit',()=>{
 let now=0;const q=new PreparationQueue(1,()=>now);assert.equal(q.join('one:1:0','a').status,'READY');
 assert.throws(()=>q.join('two:1:0','b'),e=>e.code==='PREPARATION_CAPACITY_FULL'&&e.status===409&&e.details.retry_after_seconds===1800);assert.equal(q.stats().queued,0);
 let canceled=0;const end=q.transfer('one:1:0','a',()=>canceled++);assert.throws(()=>q.transfer('one:1:0','a',()=>{}),/STREAM_BUSY/);
 now=91000;assert.throws(()=>q.join('two:1:0','b'),/CAPACITY_FULL/);q.releaseSession('one','stale');assert.equal(canceled,0);
 q.releaseSession('one','a');assert.equal(canceled,1);assert.throws(()=>q.join('two:1:0','b'),/CAPACITY_FULL/);end();end();assert.equal(q.join('two:1:0','b').status,'READY');
 assert.throws(()=>q.join('two:1:0','other'),/ALREADY_ACTIVE/);q.close();assert.equal(q.stats().active,0);
});
test('abandoned preparation expires and hard deadline cancels real streams',()=>{
 let now=0;const q=new PreparationQueue(1,()=>now);q.join('old','a');now=90001;assert.equal(q.stats().active,0);q.join('new','n');
 let canceled=0;const end=q.transfer('new','n',()=>canceled++);now+=20*60000;assert.throws(()=>q.join('retry','r'),/CAPACITY_FULL/);assert.equal(canceled,1);end();assert.equal(q.join('retry','r').status,'READY');
 assert.throws(()=>new PreparationQueue(0),/INVALID/);assert.throws(()=>new PreparationQueue(10001),/INVALID/);
});
test('legacy assets reject immediately at capacity and release their streams exactly once',async()=>{
 const q=new PreparationQueue(1);q.join('modern','a');await assert.rejects(q.legacyTransfer('old',new AbortController().signal,()=>{}),/CAPACITY_FULL/);assert.equal(q.stats().queued,0);
 const aborted=new AbortController();aborted.abort(new Error('client closed'));await assert.rejects(q.legacyTransfer('old',aborted.signal,()=>{}),/client closed/);
 q.release('modern','a');const done=await q.legacyTransfer('old',new AbortController().signal,()=>{});assert.equal(q.stats().streams,1);assert.throws(()=>q.join('next','b'),/CAPACITY_FULL/);done();done();assert.equal(q.join('next','b').status,'READY');q.close();
});
test('download budgets tolerate low bandwidth while bounding total time',()=>{
  assert.ok(downloadBudget(1024*1024)>20000);assert.ok(downloadBudget(5*1024*1024)>=15*60000);
  assert.ok(downloadBudget(8*1024*1024)<=20*60000);assert.ok(downloadBudget(100)>=60000);
});
test('original streams handle progress, stall, excess, truncation and parent cancellation',async t=>{
  const server=createServer((req,res)=>{
    if(req.url==='/slow'){res.write('a');setTimeout(()=>res.write('b'),40);setTimeout(()=>res.end('c'),80);}
    else if(req.url==='/stall'){res.write('a');}
    else if(req.url==='/excess')res.end('abcdef');else res.end('a');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${server.address().port}`,progress=[];
  const bytes=await downloadOriginal(`${origin}/slow`,3,new AbortController().signal,n=>progress.push(n),{stall_ms:65,total_ms:200});
  assert.equal(new TextDecoder().decode(bytes),'abc');assert.equal(progress.at(-1),3);
  await assert.rejects(downloadOriginal(`${origin}/stall`,3,new AbortController().signal,()=>{},{stall_ms:30,total_ms:200}),/停滞/);
  await assert.rejects(downloadOriginal(`${origin}/excess`,3,new AbortController().signal,()=>{}),/超出/);
  await assert.rejects(downloadOriginal(`${origin}/truncated`,3,new AbortController().signal,()=>{}),/完整/);
  const aborted=new AbortController();aborted.abort(new Error('caller canceled'));await assert.rejects(downloadOriginal(`${origin}/slow`,3,aborted.signal,()=>{}),/caller canceled/);
  await assert.rejects(downloadOriginal(`${origin}/slow`,3,new AbortController().signal,()=>{},{stall_ms:100,total_ms:30}),/预算/);
});
test('HTTP overload retry preserves serialized idempotent bytes and refuses ambiguous fetch errors',async t=>{
  const attempts=[];let fail=false;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{attempts.push(options.body);if(fail)throw new Error('connection lost');return attempts.length===1?new Response('{}',{status:503,headers:{'Retry-After':'0'}}):new Response('{"ok":true}');});
  const body={request_id:'stable',payload:'same bytes'};assert.deepEqual(await request('/test',body),{ok:true});assert.equal(attempts[0],attempts[1]);
  fail=true;await assert.rejects(request('/test',body),/connection lost/);assert.equal(attempts.length,3);
});
test('asset overload retry remains inside the same transfer budget and preserves ticket headers',async t=>{
  let count=0;const headers={'X-Preparation-Ticket':'same-ticket'};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{assert.deepEqual(options.headers,headers);return ++count===1?new Response('{}',{status:429,headers:{'Retry-After':'0'}}):new Response('abc');});
  assert.equal(new TextDecoder().decode(await downloadOriginal('/original',3,new AbortController().signal,()=>{},undefined,headers)),'abc');assert.equal(count,2);
});
