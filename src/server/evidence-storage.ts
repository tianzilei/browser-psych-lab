import type Database from 'better-sqlite3';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export const RAW_REFERENCE='@raw-v1';
export const EVIDENCE_STORAGE='gzip-single-copy-v1';
const magic=Buffer.from([0,66,80,76,71,90,49,0]),headerBytes=12,maxRawBytes=128*1024;
const installed=new WeakSet<Database.Database>();
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function buffer(value:Uint8Array){return Buffer.isBuffer(value)?value:Buffer.from(value.buffer,value.byteOffset,value.byteLength);}
export function storedRawBytes(value:Uint8Array):number {
  const bytes=buffer(value);
  if(!bytes.subarray(0,magic.length).equals(magic))return bytes.length;
  if(bytes.length<headerBytes+20)throw new Error('INVALID_COMPRESSED_EVIDENCE');
  const length=bytes.readUInt32BE(8);if(!length||length>maxRawBytes)throw new Error('INVALID_COMPRESSED_EVIDENCE_LENGTH');return length;
}
export function decodeRaw(value:Uint8Array,expectedHash?:string):Buffer {
  const bytes=buffer(value),length=storedRawBytes(bytes);
  const decoded=bytes.subarray(0,magic.length).equals(magic)?gunzipSync(bytes.subarray(headerBytes),{maxOutputLength:length}):bytes;
  if(decoded.length!==length||expectedHash!==undefined&&hash(decoded)!==expectedHash)throw new Error('EVIDENCE_HASH_MISMATCH');
  return decoded;
}
export function encodeRaw(value:Uint8Array):Buffer {
  // Small questionnaire envelopes also contain compressible schema/chain keys.
  // Keep the existing 10% savings gate for entropy-heavy or tiny records.
  const bytes=buffer(value);if(bytes.length<512)return bytes;
  if(bytes.length>maxRawBytes)throw new Error('EVIDENCE_SIZE_EXCEEDED');
  const compressed=gzipSync(bytes,{level:6});
  if(compressed.length+headerBytes>=bytes.length*0.9)return bytes;
  const header=Buffer.alloc(headerBytes);magic.copy(header);header.writeUInt32BE(bytes.length,8);return Buffer.concat([header,compressed]);
}
export function installEvidenceFunctions(db:Database.Database){
  if(installed.has(db))return;
  db.function('lab_raw_bytes',{deterministic:true},(raw:Uint8Array)=>storedRawBytes(raw));
  db.function('lab_raw_text',{deterministic:true},(raw:Uint8Array,expectedHash:string)=>decodeRaw(raw,expectedHash).toString('utf8'));
  installed.add(db);
}
export function verifyEvidence(db:Database.Database){
  installEvidenceFunctions(db);let records=0,logicalBytes=0,storedBytes=0;
  for(const row of db.prepare('SELECT raw,hash FROM lab_raw').iterate() as Iterable<{raw:Buffer;hash:string}>){const decoded=decodeRaw(row.raw,row.hash);records++;logicalBytes+=decoded.length;storedBytes+=row.raw.length;}
  let events=0;
  for(const row of db.prepare('SELECT e.envelope,r.raw,e.hash FROM lab_events e JOIN lab_raw r USING(session_id,event_id,hash)').iterate() as Iterable<{envelope:string;raw:Buffer;hash:string}>){
    if(row.envelope!==RAW_REFERENCE&&!Buffer.from(row.envelope,'utf8').equals(decodeRaw(row.raw,row.hash)))throw new Error('EVIDENCE_ENVELOPE_MISMATCH');events++;
  }
  return {records,events,logical_bytes:logicalBytes,stored_raw_bytes:storedBytes,storage:EVIDENCE_STORAGE};
}
