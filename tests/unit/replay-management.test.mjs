import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,utimes,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fixture} from '../helpers/lab-fixture.mjs';
import {LabStore} from '../../src/server/lab-store.ts';
import {digest} from '../../src/server/collection-store.ts';
import {RecordingDownloads} from '../../src/server/recording-downloads.ts';
import {cleanRecordingDownloads} from '../../src/server/clean-recording-downloads.ts';
const screen={type:'screen',at:1,context:{page_id:'welcome'},width:390,height:844,dpr:3,scroll_x:0,scroll_y:0,visual_viewport:null,background:'#fff',nodes:[{tag:'div',x:10,y:20,width:200,height:80,text:'中文😀 </script><script>alert(1)</script>',style:{color:'#000','font-size':'16px'}}]};
function record(f,samples,scope='d-ui-test'){const event=f.wire(scope,'INPUT_DIAGNOSTIC',{interaction:{schema:'interaction-v1',time_origin:1700000000000.125,samples}},{sequence:0,previous:null});f.ingest([event]);return event;}
test('replay listing requires a valid screen; input-only and invalid histories remain retained, filtered paging and restart stay consistent',t=>{
 const f=fixture(t);assert.equal(f.admin('study.list').studies[0].replayable_sessions,0);record(f,[{type:'input',at:1,context:{},value:'old'}]);
 assert.equal(f.admin('session.recording',{session_id:f.created.session_id}).replayable,false);assert.equal(f.admin('session.list',{study_id:f.study.study_id,replayable:true}).sessions.length,0);
 const valid=record(f,[screen,{type:'pointermove',at:2.1234567,context:{},x:3.14159265,y:4.125}],'d-ui-screen');f.ingest([valid]);
 assert.equal(f.admin('study.list').studies[0].replayable_sessions,1);const row=f.admin('session.list',{study_id:f.study.study_id,replayable:'true'}).sessions[0];assert.equal(row.recording_screens,1);assert.equal(row.recording_samples,3);
 record(f,[{}],'d-ui-bad');assert.ok(f.admin('session.actions',{session_id:f.created.session_id}).batches.every(b=>b.schema==='interaction-v1'));
 new LabStore(f.db);assert.equal(f.admin('session.recording',{session_id:f.created.session_id}).screens,1);
 f.db.prepare("DELETE FROM lab_meta WHERE key='replay_index'").run();f.db.prepare('DELETE FROM lab_replay_index').run();new LabStore(f.db);assert.equal(f.admin('session.recording',{session_id:f.created.session_id}).screens,1);
 assert.equal(f.admin('session.list',{study_id:f.study.study_id,replayable:true,limit:1,offset:1}).sessions.length,0);
});
test('per-session trajectory and standalone HTML preserve exact raw bytes and exclude other sessions and credentials',async t=>{
 const f=fixture(t),event=record(f,[screen,{type:'pointermove',at:3.123456789,context:{},x:1.23456789,y:0}]);
 record(f,[{...screen,nodes:[{tag:'canvas',x:0,y:0,width:10,height:10,style:{},asset_id:'00000000-0000-0000-0000-000000000000'}]},{type:'pointermove',at:2,context:{},x:1,y:1}],'d-ui-forged');
 const other=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),credential_hash:digest('other')}}),downloads=new RecordingDownloads(f.path,f.root);t.after(()=>downloads.close());
 const output=await downloads.build(f.created.session_id);try{const body=JSON.parse(gunzipSync(await readFile(output.path)).toString());assert.equal(body.session_id,f.created.session_id);assert.equal(body.events[0].raw_utf8,event.raw);assert.equal(body.events[0].hash,event.hash);assert.equal(body.events[0].canonical,1);assert.equal(body.record_count,2);assert.ok(!JSON.stringify(body).includes(other.session_id));assert.ok(!JSON.stringify(body).includes('credential_hash'));assert.ok(!Object.hasOwn(body,'credential'));}finally{await output.cleanup();}
 const html=await downloads.build(f.created.session_id,undefined,'html');try{const text=await readFile(html.path,'utf8');assert.ok(text.startsWith('<!doctype html>'));assert.ok(!text.includes('alert(1)</script>'));const encoded=/id="recording-data" type="application\/octet-stream">([^<]+)</.exec(text)[1];const body=JSON.parse(gunzipSync(Buffer.from(encoded,'base64')).toString());assert.equal(body.events[0].raw_utf8,event.raw);assert.deepEqual(Object.keys(body.embedded_assets),[]);assert.ok(text.includes("connect-src 'none'"));}finally{await html.cleanup();}
});
test('daily cleanup only removes expired temporary replay exports',async t=>{
 const f=fixture(t),bucket=join(f.root,'research-recording-downloads'),expired=join(bucket,randomUUID()),fresh=join(bucket,randomUUID());await mkdir(expired,{recursive:true,mode:0o700});await mkdir(fresh,{mode:0o700});await writeFile(join(expired,'replay.html'),'derived');await writeFile(join(f.root,'original.json'),'raw');await utimes(expired,new Date(0),new Date(0));
 const result=await cleanRecordingDownloads(f.root);assert.equal(result.removed,1);await assert.rejects(access(expired));await access(fresh);assert.equal(await readFile(join(f.root,'original.json'),'utf8'),'raw');
});
