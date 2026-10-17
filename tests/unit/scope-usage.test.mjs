import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {LabStore} from '../../src/server/lab-store.ts';
import {digest} from '../../src/server/collection-store.ts';
import {storedRawBytes} from '../../src/server/evidence-storage.ts';
import {compactEvidence} from '../../src/server/compact-evidence.ts';
import {CollectionStore} from '../../src/server/collection-store.ts';

const interaction={schema:'interaction-v1',time_origin:1000,samples:[{type:'input',at:1,context:{page_id:'welcome'},value:'中文😀'.repeat(500)}]};
const usage=f=>f.db.prepare('SELECT session_id,scope,events,bytes FROM lab_scope_usage ORDER BY session_id,scope').all();
const expected=f=>f.db.prepare('SELECT session_id,scope,count(*) AS events,sum(lab_raw_bytes(raw)) AS bytes FROM lab_raw GROUP BY session_id,scope ORDER BY session_id,scope').all();

test('scope usage counts logical UTF-8 bytes, conflicting hashes and independent scopes without double-counting retries',t=>{
  const f=fixture(t),one=f.wire('d-ui-one','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null});
  f.ingest([one]);
  const changed=JSON.parse(one.raw);changed.payload.interaction.samples[0].value='different hash';
  const raw=JSON.stringify(changed),conflict={event_id:one.event_id,hash:digest(raw),raw};
  assert.equal(f.ingest([conflict]).receipts[0].reason,'EVENT_ID_HASH_CONFLICT');
  const other=f.wire('d-ui-two','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null});f.ingest([other]);
  const before=usage(f);assert.deepEqual(before,expected(f));
  assert.equal(before.find(row=>row.scope==='d-ui-one').events,2);
  assert.equal(before.find(row=>row.scope==='d-ui-one').bytes,Buffer.byteLength(one.raw)+Buffer.byteLength(raw));
  f.ingest([one,conflict,other]);assert.deepEqual(usage(f),before);
});

test('usage upgrade backfills legacy records once and preserves compression/expansion and restart behavior',t=>{
  const f=fixture(t);new CollectionStore(f.db);
  f.ingest([f.wire('d-ui-legacy','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null})]);
  compactEvidence(f.db,'expand',false);
  new LabStore(f.db);
  f.ingest([f.wire('d-ui-compressed','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null})]);
  const before=expected(f);
  f.db.exec("DROP TRIGGER lab_raw_scope_usage; DROP TABLE lab_scope_usage; DELETE FROM lab_meta WHERE key='scope_usage'");
  let reads=0;f.db.function('lab_raw_bytes',{deterministic:true},raw=>{reads++;return storedRawBytes(raw);});
  new LabStore(f.db);assert.deepEqual(usage(f),before);assert.equal(reads,2);
  reads=0;new LabStore(f.db);assert.equal(reads,0);
  compactEvidence(f.db,'compact',false);assert.deepEqual(usage(f),before);
  compactEvidence(f.db,'expand',false);assert.deepEqual(usage(f),before);
  assert.deepEqual(usage(f),expected(f));
});

test('ingestion reads logical sizes only for new records and loads a frozen protocol once per batch',t=>{
  const f=fixture(t),scope='d-ui-profile';
  for(let i=0;i<64;i+=16)f.ingest(Array.from({length:16},()=>f.wire(scope,'INPUT_DIAGNOSTIC',{interaction})));
  let reads=0,loads=0;
  f.db.function('lab_raw_bytes',{deterministic:true},raw=>{reads++;return storedRawBytes(raw);});
  const frozen=f.store.frozen.bind(f.store);f.store.frozen=(...args)=>{loads++;return frozen(...args);};
  const events=Array.from({length:16},()=>f.wire(scope,'INPUT_DIAGNOSTIC',{interaction}));
  const result=f.ingest(events);assert.ok(result.receipts.every(r=>r.disposition==='ACCEPTED'));
  assert.equal(reads,16);assert.equal(loads,1);
  reads=0;loads=0;assert.deepEqual(f.ingest(events),result);assert.equal(reads,0);assert.equal(loads,1);
});

test('scope usage is isolated between sessions sharing the same scope name',t=>{
  const f=fixture(t),one=f.wire('d-ui-shared','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null});f.ingest([one]);
  const credential=digest(randomUUID()),created=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),credential_hash:credential}});
  const call=(op,data)=>f.store.execute({operation:`lab/participant.${op}`,session_id:created.session_id,credential_hash:credential,data});
  const claim=call('claim',{request_id:randomUUID(),writer_id:'other-writer'});
  const event={...JSON.parse(one.raw),event_id:randomUUID(),session_id:created.session_id,writer_id:'other-writer',writer_epoch:claim.writer_epoch};
  const raw=JSON.stringify(event);call('ingest',{events:[{event_id:event.event_id,hash:digest(raw),raw}]});
  assert.deepEqual(usage(f),expected(f));assert.equal(usage(f).length,2);
  assert.ok(usage(f).every(row=>row.events===1&&row.scope==='d-ui-shared'));
});

test('a failed legacy backfill rolls back counters and its marker before retrying',t=>{
  const f=fixture(t);f.ingest([f.wire('d-ui-upgrade','INPUT_DIAGNOSTIC',{interaction},{sequence:0,previous:null})]);
  const before=usage(f);f.db.prepare("DELETE FROM lab_meta WHERE key='scope_usage'").run();
  f.db.function('lab_raw_bytes',{deterministic:true},raw=>{throw new Error('injected backfill failure');});
  assert.throws(()=>new LabStore(f.db),/injected backfill failure/);
  assert.deepEqual(usage(f),before);assert.equal(f.db.prepare("SELECT value FROM lab_meta WHERE key='scope_usage'").get(),undefined);
  f.db.function('lab_raw_bytes',{deterministic:true},storedRawBytes);new LabStore(f.db);
  assert.deepEqual(usage(f),expected(f));
});
