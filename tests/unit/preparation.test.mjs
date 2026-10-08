import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PreparationQueue} from '../../src/server/preparation-queue.ts';
import {downloadBudget,downloadOriginal} from '../../src/web/asset-download.ts';
import {request} from '../../src/web/dom.ts';
test('FIFO tickets, exact cancellation, one stream and actual stream exit bound preparation',()=>{
  let now=0;const q=new PreparationQueue(1,()=>now);
  assert.equal(q.join('one:1:0','a').status,'READY');assert.equal(q.join('two:1:0','b').position,1);assert.equal(q.join('three:1:0','c').position,2);
  let canceled=0;const end=q.transfer('one:1:0','a',()=>canceled++);
  assert.throws(()=>q.transfer('one:1:0','a',()=>{}),/STREAM_BUSY/);
  now=89000;q.touch('two:1:0','b');q.touch('three:1:0','c');now=91000;
  assert.equal(q.touch('two:1:0','b').status,'QUEUED'); // Active HTTP survives lease age.
  q.releaseSession('one','stale');assert.equal(canceled,0);
  q.releaseSession('one','a');assert.equal(canceled,1);assert.equal(q.touch('two:1:0','b').status,'QUEUED');
  end();end();assert.equal(q.touch('two:1:0','b').status,'READY');q.release('two:1:0','b');assert.equal(q.touch('three:1:0','c').status,'READY');
  q.release('three:1:0','c');q.join('one:1:1','new');q.releaseSession('one','a');assert.equal(q.touch('one:1:1','new').status,'READY');
  assert.throws(()=>q.join('one:1:1','other'),/ALREADY_QUEUED/);q.close();assert.equal(q.stats().active,0);
});
test('preparation queue is bounded, expires abandoned clients, and cancels its hard deadline',()=>{
  let now=0;const q=new PreparationQueue(1,()=>now);
  for(let i=0;i<64;i++)q.join(`s${i}:1:0`,String(i));assert.throws(()=>q.join('full','65'),/QUEUE_FULL/);
  now=90001;assert.equal(q.stats().active,0);assert.equal(q.join('new','n').status,'READY');
  let canceled=0;const end=q.transfer('new','n',()=>canceled++);now+=20*60000;
  q.join('waiting','w');assert.equal(canceled,1);assert.equal(q.touch('waiting','w').status,'QUEUED');end();assert.equal(q.touch('waiting','w').status,'READY');
  assert.throws(()=>new PreparationQueue(0),/INVALID/);
});
test('legacy asset GET shares FIFO capacity and cleans canceled or timed-out waits',async()=>{
  const q=new PreparationQueue(1);q.join('modern','a');const controller=new AbortController();
  const pending=q.legacyTransfer('old',controller.signal,()=>{},1000);assert.equal(q.stats().queued,1);
  controller.abort(new Error('client closed'));await assert.rejects(pending,/client closed/);assert.equal(q.stats().queued,0);
  await assert.rejects(q.legacyTransfer('old',new AbortController().signal,()=>{},10),/LEGACY_PREPARATION_BUSY/);assert.equal(q.stats().queued,0);
  const ready=q.legacyTransfer('old',new AbortController().signal,()=>{},1000);q.release('modern','a');const done=await ready;
  assert.equal(q.stats().streams,1);assert.equal(q.join('modern-next','b').status,'QUEUED');done();done();assert.equal(q.touch('modern-next','b').status,'READY');q.close();
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
