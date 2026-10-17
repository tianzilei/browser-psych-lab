import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {sampleProtocol} from '../../src/shared/protocol.ts';

test('legacy UI diagnostic chains exceeding 32 MiB retain custody and allow answer sealing',t=>{
  const p=sampleProtocol();p.groups=[];p.variants[0].group_order=[];p.variants[0].trial_order={};
  const f=fixture(t,p),scope='d-ui-legacy-clock-0';
  const interaction={schema:'interaction-v1',time_origin:100000,samples:[{
    type:'input',at:123,raw_timestamp:123,context:{page_id:'welcome'},
    target:'#personal',box:null,x:null,y:null,trusted:true,value:'x'.repeat(120*1024),
  }]};
  let last;
  for(let i=0;i<280;i+=16){
    const events=Array.from({length:Math.min(16,280-i)},()=>f.wire(scope,'INPUT_DIAGNOSTIC',{interaction}));
    // The transport budget is 512 KiB, independent of the scope's retained size.
    for(let j=0;j<events.length;j+=4)assert.ok(f.ingest(events.slice(j,j+4)).receipts.every(r=>r.disposition==='ACCEPTED'));
    last=events.at(-1);
  }
  const before=f.db.prepare('SELECT count(*) AS n,sum(lab_raw_bytes(raw)) AS bytes FROM lab_raw WHERE scope=?').get(scope);
  assert.ok(before.bytes>32*1024*1024);
  const receipt=f.ingest([last]).receipts[0];assert.equal(receipt.custody,'PERSISTED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_raw WHERE scope=?').get(scope).n,before.n);
  const answer=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}},{sequence:0,previous:null});
  assert.equal(f.ingest([answer]).receipts[0].disposition,'ACCEPTED');
  assert.equal(f.seal('welcome',[answer],['welcome']).status,'SEALED');
  assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:f.call('view').seals.map(s=>s.seal_id)}).status,'COMPLETED');
});

test('answer scope keeps its 32 MiB limit and rejected batches do not partially persist',t=>{
  const f=fixture(t);
  f.db.prepare('INSERT INTO lab_raw VALUES (?,?,?,?,?,zeroblob(?),?)').run(
    f.created.session_id,randomUUID(),'a'.repeat(64),'welcome',randomUUID(),32*1024*1024-1000,1000);
  const events=[f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:'是'}),
    f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}})];
  assert.throws(()=>f.ingest(events),error=>error.code==='SCOPE_BUDGET_EXCEEDED'&&error.status===413
    &&error.details.maximum_bytes===32*1024*1024&&error.details.scope==='welcome');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_raw WHERE scope=?').get('welcome').n,1);
});
test('a full 5000-event answer chain seals successfully with one reserved final snapshot',t=>{
  const p=sampleProtocol();p.groups=[];p.variants[0].group_order=[];p.variants[0].trial_order={};p.questionnaire_layout='adaptive';
  const f=fixture(t,p),refs=[];
  for(let i=0;i<4999;i+=16){
    const rows=Array.from({length:Math.min(16,4999-i)},(_,j)=>f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:(i+j)%2?'是':'否'}));
    assert.ok(f.ingest(rows).receipts.every(r=>r.disposition==='ACCEPTED'));refs.push(...rows);
  }
  const snapshot=f.wire('welcome','PAGE_SNAPSHOT',{answers:{ready:'是'}});
  assert.equal(f.ingest([snapshot]).receipts[0].disposition,'ACCEPTED');refs.push(snapshot);
  const count=f.db.prepare('SELECT count(*) AS n FROM lab_raw WHERE scope=?').get('welcome').n;assert.equal(count,5000);
  assert.throws(()=>f.ingest([f.wire('welcome','PAGE_REVISION',{question_id:'ready',answer:'否'})]),e=>e.code==='SCOPE_BUDGET_EXCEEDED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lab_raw WHERE scope=?').get('welcome').n,count);
  assert.equal(f.seal('welcome',refs,['welcome']).status,'SEALED');
  assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:f.call('view').seals.map(s=>s.seal_id)}).status,'COMPLETED');
});
