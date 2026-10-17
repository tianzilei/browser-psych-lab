import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture} from '../helpers/lab-fixture.mjs';
import {CollectionStore,digest} from '../../src/server/collection-store.ts';
import {encodeRaw,decodeRaw,storedRawBytes,RAW_REFERENCE,verifyEvidence} from '../../src/server/evidence-storage.ts';
import {compactEvidence,evidenceProof} from '../../src/server/compact-evidence.ts';

test('gzip evidence round-trips original JSON bytes, numeric spellings and Unicode without reserialization',()=>{
  const raw=Buffer.from('{ "x":1.2345678901234567, "at":1700000000123.125, "negative":-0, "escape":"\\u4e2d", "text":"中文😀'+ '重复样式'.repeat(2000)+'" }\n');
  const packed=encodeRaw(raw);assert.ok(packed.length<raw.length/10);assert.equal(storedRawBytes(packed),raw.length);
  assert.deepEqual(decodeRaw(packed,digest(raw)),raw);assert.deepEqual(decodeRaw(raw,digest(raw)),raw);
  assert.deepEqual(encodeRaw(Buffer.from('{}')),Buffer.from('{}'));
  const random=randomBytes(4000);assert.deepEqual(encodeRaw(random),random);
  assert.throws(()=>decodeRaw(packed,'0'.repeat(64)),/HASH_MISMATCH/);
  const corrupt=Buffer.from(packed);corrupt[corrupt.length-7]^=1;assert.throws(()=>decodeRaw(corrupt,digest(raw)));
  const bomb=Buffer.from(packed);bomb.writeUInt32BE(128*1024+1,8);assert.throws(()=>decodeRaw(bomb),/LENGTH/);
  const short=Buffer.from(packed);short.writeUInt32BE(1,8);assert.throws(()=>decodeRaw(short));
  assert.throws(()=>encodeRaw(Buffer.alloc(128*1024+1)),/SIZE_EXCEEDED/);
});
test('small questionnaire envelopes save storage without changing their exact bytes or compressing entropy-heavy input',()=>{
  const raw=Buffer.from(JSON.stringify({event_schema_version:'lab-events-v1',event_id:'test-event',session_id:'test-session',version_id:'test-version',
    protocol_hash:'a'.repeat(64),writer_id:'writer',writer_epoch:1,scope:'welcome',sequence:1,previous:{event_id:'previous',hash:'b'.repeat(64)},
    clock_epoch:'clock',time_ms:123.456789,kind:'PAGE_REVISION',payload:{question_id:'ready',answer:'中文😀'.repeat(10)}}));
  assert.ok(raw.length>=512&&raw.length<1024);const packed=encodeRaw(raw);
  assert.ok(packed.length<raw.length*.9);assert.equal(storedRawBytes(packed),raw.length);assert.deepEqual(decodeRaw(packed,digest(raw)),raw);
  const random=randomBytes(700);assert.deepEqual(encodeRaw(random),random);
});
function recording(f){const batch={schema:'interaction-v1',time_origin:1700000000000.125,samples:[{type:'input',at:12.3456789012345,raw_timestamp:12.3456789012345,x:1.23456789012345,y:-0.125,context:{page_id:'welcome'},value:'真实记录😀'.repeat(3000)}]};
  const event=f.wire('d-ui-lossless','INPUT_DIAGNOSTIC',{interaction:batch},{sequence:0,previous:null});assert.equal(f.ingest([event]).receipts[0].disposition,'ACCEPTED');return {batch,event};}
test('single-copy compressed ingestion preserves custody, retry identity, replay samples and immutable evidence',t=>{
  const f=fixture(t),{batch,event}=recording(f),raw=f.db.prepare('SELECT raw FROM lab_raw').get().raw;
  assert.ok(raw.length<Buffer.byteLength(event.raw)/10);assert.equal(f.db.prepare('SELECT envelope FROM lab_events').get().envelope,RAW_REFERENCE);
  assert.equal(decodeRaw(raw,event.hash).toString('utf8'),event.raw);
  const original=f.ingest([event]);assert.deepEqual(f.ingest([event]),original);assert.equal(verifyEvidence(f.db).records,1);
  assert.deepEqual(f.admin('session.actions',{session_id:f.created.session_id}).batches[0].samples,batch.samples);
  assert.throws(()=>f.db.prepare("UPDATE lab_raw SET raw=x'00'").run(),/immutable/);
  assert.throws(()=>f.db.prepare("UPDATE lab_events SET envelope='{}'").run(),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM lab_raw').run(),/immutable/);
});
test('offline migration is reversible, idempotent and preserves raw bytes, hashes and receipt metadata',t=>{
  const f=fixture(t);new CollectionStore(f.db);const {event}=recording(f),proof=evidenceProof(f.db).proof;
  compactEvidence(f.db,'expand');assert.equal(f.db.prepare('SELECT raw FROM lab_raw').get().raw.toString(),event.raw);
  assert.equal(f.db.prepare('SELECT envelope FROM lab_events').get().envelope,event.raw);
  assert.equal(f.db.prepare("SELECT value FROM lab_meta WHERE key='schema'").get().value,'1');
  const result=compactEvidence(f.db);assert.equal(result.before.proof,proof);assert.equal(result.after.proof,proof);
  assert.equal(compactEvidence(f.db).after.proof,proof);assert.deepEqual(f.ingest([event]).receipts[0].hash,event.hash);
  assert.throws(()=>f.db.prepare("UPDATE lab_events SET envelope='{}'").run(),/immutable/);
  compactEvidence(f.db,'expand');assert.equal(evidenceProof(f.db).proof,proof);
});
test('offline migration refuses a live server and rolls back representation and triggers on failure',t=>{
  const f=fixture(t);new CollectionStore(f.db);recording(f);compactEvidence(f.db,'expand');
  const proof=evidenceProof(f.db).proof;
  f.db.prepare("INSERT INTO p0_meta VALUES ('app_instance',?)").run(JSON.stringify({pid:process.pid,owner:'test-live-owner'}));
  assert.throws(()=>compactEvidence(f.db),/STOP_SERVER/);assert.equal(evidenceProof(f.db).proof,proof);
  f.db.prepare("DELETE FROM p0_meta WHERE key='app_instance'").run();
  f.db.exec("CREATE TRIGGER test_migration_fault BEFORE UPDATE OF envelope ON lab_events BEGIN SELECT RAISE(ABORT,'injected migration fault'); END");
  assert.throws(()=>compactEvidence(f.db),/injected migration fault/);assert.equal(evidenceProof(f.db).proof,proof);
  assert.equal(f.db.prepare("SELECT value FROM lab_meta WHERE key='schema'").get().value,'1');
  assert.equal(f.db.prepare('SELECT raw FROM lab_raw').get().raw[0],123);
  assert.throws(()=>f.db.prepare("UPDATE lab_raw SET raw=x'00'").run(),/immutable/);
  assert.throws(()=>f.db.prepare("UPDATE lab_events SET envelope='{}'").run(),/immutable|injected migration fault/);
});
