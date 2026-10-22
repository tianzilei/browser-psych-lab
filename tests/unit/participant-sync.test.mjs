import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ParticipantAPI} from '../../src/web/participant-api.ts';

function fixture(t){
  const rows=new Map(),acks=[];
  const ledger={drain:async()=>{},state:async()=>({preparations:{}}),pendingIds:async()=>new Set(rows.keys()),
    batch:async(scope,ids)=>[...rows.values()].filter(row=>ids.has(row.event_id)&&(scope===undefined||row.scope===scope||row.scope.startsWith('d-ui-'))).slice(0,1),
    acknowledge:async receipts=>{acks.push(...receipts);for(const row of receipts)rows.delete(row.event_id);}};
  const api=new ParticipantAPI(ledger,{session_id:'test'});
  const add=(id,scope='current')=>rows.set(id,{event_id:id,hash:id,raw:id,scope});
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  return {api,rows,acks,add};
}
test('background and foreground sync serialize; a continuously growing outbox cannot keep one sync open',async t=>{
  const f=fixture(t);f.add('first');let active=0,maxActive=0,calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async(_url,request)=>{
    active++;maxActive=Math.max(maxActive,active);const events=JSON.parse(request.body).events;
    if(++calls===1){f.add('later');await gate;}
    active--;return Response.json({receipts:events.map(event=>({...event,custody:'PERSISTED'}))});
  };
  const first=f.api.sync('current');await new Promise(resolve=>setTimeout(resolve,10));
  const second=f.api.sync('current');release();await first;
  assert.equal(f.rows.has('later'),true,'late appends belong to the next bounded pass');
  await second;assert.equal(maxActive,1);assert.equal(calls,2);assert.equal(f.rows.size,0);
});
test('failed uploads keep exact identities for retry and never send future questionnaire scopes',async t=>{
  const f=fixture(t);f.add('answer');f.add('future','next-page');f.add('screen','d-ui-clock-0');let fail=true;
  const batches=[];
  globalThis.fetch=async(_url,request)=>{
    const {events}=JSON.parse(request.body);batches.push(events);
    if(fail){fail=false;throw new TypeError('NetworkError');}
    return Response.json({receipts:events.map(event=>({...event,custody:'PERSISTED'}))});
  };
  await assert.rejects(f.api.sync('current'),/NetworkError/);assert.equal(f.acks.length,0);
  await f.api.sync('current');assert.deepEqual(batches[0],batches[1]);
  assert.deepEqual([...f.rows.keys()],['future']);assert.equal(f.acks.length,2);
});
test('a mismatched custody response cannot acknowledge or discard local records',async t=>{
  const f=fixture(t);f.add('answer');
  globalThis.fetch=async()=>Response.json({receipts:[{event_id:'answer',hash:'different'}]});
  await assert.rejects(f.api.sync(),/CUSTODY_RECEIPT_MISMATCH/);
  assert.equal(f.acks.length,0);assert.equal(f.rows.size,1);
});
