import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {parseProtocol} from '../../src/shared/protocol.ts';
import {sampleTrials} from '../../src/shared/trial-sampling.ts';
import {RunReplay} from '../../src/shared/run-replay.ts';
import {fixture} from '../helpers/lab-fixture.mjs';
const input=()=>JSON.parse(readFileSync('examples/project1/experiment.json','utf8'));
const protocol=()=>compileQuestionnaire(input(),ref=>`asset-${ref.path.split('/').at(-1).split('.')[0]}`);
test('Project1 sampling is reproducible, without replacement, and balances both factors for every participant',()=>{
  const p=protocol(),g=p.groups[0];assert.deepEqual(parseProtocol(p),p);assert.equal(g.trials.length,102);
  const allocations=new Set(),selections=new Set();
  for(let i=1;i<=500;i++){
    const seed=[i,Math.imul(i,0x9e3779b9)>>>0,Math.imul(i,0x85ebca6b)>>>0,4],result=sampleTrials(g.trials,g.sampling,seed);assert.deepEqual(sampleTrials(g.trials,g.sampling,seed),result);
    assert.equal(result.roots.length,32);assert.equal(new Set(result.roots.map(t=>t.root_id)).size,32);
    const female=result.roots.filter(t=>t.category.startsWith('female')).length,glasses=result.roots.filter(t=>!t.category.includes('no-glasses')).length;
    assert.equal(female,16);assert.equal(glasses,16);
    for(const [key,n] of Object.entries(result.sampling.counts))assert.equal(result.roots.filter(t=>t.category===key).length,n);
    allocations.add(result.sampling.allocation);selections.add(result.sampling.selected.join(','));
  }
  assert.equal(allocations.size,1);assert(selections.size>450);
});
test('invalid sampling, non-neutral answers, repeated ratings and wrong choices fail import',()=>{
  for(const edit of [p=>p.groups[0].sampling.allocations[0]['female-glasses']=15,p=>p.groups[0].rating.labels.pop(),p=>p.groups[0].trials[0].correct='1',p=>p.groups[0].repeats=1,p=>p.groups[0].choices[0]='zero']){
    const v=input();edit(v);assert.throws(()=>compileQuestionnaire(v,ref=>ref.path.replaceAll('/','-')));
  }
});
const makePlan=()=>{const p=protocol(),g=p.groups[0],seed=[1,2,3,4],selected=sampleTrials(g.trials,g.sampling,seed);return {group_id:g.id,scope:'group',seed,...selected,rating:g.rating,choices:g.choices,repeats:0,start:1000,frame_ms:10,layout:'portrait',budget:p.budget};};
function onset(replay,at=1000){const id=replay.plan.roots[0].root_id+':1';replay.apply({type:'RATING_INTENT',at:0,instance_id:id});replay.apply({type:'ONSET',at,draw_time:at,raf_time:at,instance_id:id});return id;}
test('response-contingent replay waits indefinitely for a score then enforces full ISI from image clearing',()=>{
  const p=makePlan(),r=new RunReplay(p),id=onset(r);
  assert.throws(()=>r.apply({type:'RATING',at:2000,draw_time:2000,raf_time:2000,input_time:1990,instance_id:id,values:[0,0,0,0,0]}),/ANSWER/);
  r.apply({type:'RATING',at:90000,draw_time:90002,raf_time:90000,input_time:89995,instance_id:id,values:[7,7,7,7,7]});
  assert.throws(()=>r.apply({type:'END',at:93001,instance_id:id}),/ISI_TOO_SHORT/);
  r.apply({type:'END',at:93002,instance_id:id});assert.equal(r.results.get(id).rating,7);assert.equal(r.results.get(id).isi_ms,3000);
  assert.throws(()=>r.finish(),/NORMALLY_CLOSED/);
});
test('replay rejects skipped, uncommitted, duplicated and unanswered rating trials',()=>{
  const p=makePlan(),r=new RunReplay(p),id=p.roots[0].root_id+':1';
  assert.throws(()=>r.apply({type:'ONSET',at:1000,draw_time:1000,raf_time:1000,instance_id:id}),/ONSET/);
  const r2=new RunReplay(p);onset(r2);assert.throws(()=>r2.apply({type:'END',at:5000,instance_id:id}),/ISI/);
  const r3=new RunReplay(p);onset(r3);r3.apply({type:'RATING',at:2000,draw_time:2000,raf_time:2000,input_time:2000,instance_id:id,values:[4,4,4,4,4]});
  assert.throws(()=>r3.apply({type:'RATING',at:2001,draw_time:2001,raf_time:2001,input_time:2001,instance_id:id,value:7}),/ANSWER/);
  assert.throws(()=>r3.apply({type:'CLOSING',at:6000,unresolved:false}),/INCOMPLETE/);
});
test('32 complete rating trials replay to scored results with labels and image/category references',()=>{
  const p=makePlan(),r=new RunReplay(p);let at=1000;
  for(const root of p.roots){const id=root.root_id+':1';r.apply({type:'RATING_INTENT',at:at-1,instance_id:id});r.apply({type:'ONSET',at,draw_time:at,raf_time:at,instance_id:id});at+=1234;r.apply({type:'RATING',at,draw_time:at,raf_time:at,input_time:at-4,instance_id:id,values:[5,5,5,5,5]});at+=3000;r.apply({type:'END',at,instance_id:id});at+=10;}
  r.apply({type:'CLOSING',at,unresolved:false});const result=r.finish();assert.equal(result.length,32);assert(result.every(v=>v.rating===5&&v.rating_label==='一般'&&v.rt_ms===1230&&v.isi_ms===3000&&v.asset_id&&v.category));
});
test('selection history separates first choice RT and submission RT and checks the committed value',()=>{
  const r=new RunReplay(makePlan()),id=onset(r);
  for(const [at,value] of [[1100,2],[1200,2],[1300,7]])for(let item=0;item<5;item++)r.apply({type:'RATING_CHANGE',at:at+item,instance_id:id,item,value});
  r.apply({type:'RATING',at:1400,draw_time:1401,raf_time:1400,input_time:1390,instance_id:id,values:[7,7,7,7,7]});
  const result=r.results.get(id);assert.equal(result.first_rt_ms,100);assert.equal(result.submit_rt_ms,390);assert.equal(result.rt_ms,390);assert.equal(result.change_count,1);
});
test('server freezes selection before download; reserve renewal and expired reservations never redraw images',t=>{
  const raw=input();raw.groups[0].trials=raw.groups[0].trials.map(({image,...rest})=>({...rest,text:rest.root_id}));delete raw.groups[0].rating;delete raw.groups[0].sampling;raw.groups[0].trials=raw.groups[0].trials.slice(0,4);raw.groups[0].choices=['1','2'];
  delete raw.layout;delete raw.consent;
  const f=fixture(t,compileQuestionnaire(raw));
  // Register candidate metadata without requiring an HTTP filesystem on Windows.
  const p=protocol();delete p.consent;for(const trial of p.groups[0].trials){f.db.prepare("INSERT INTO lab_assets VALUES (?, ?, ?, 'READY', ?, ?, 413, 626, 'webp', ?, 0)").run(trial.asset_id,f.study.study_id,trial.root_id,'a'.repeat(64),40000,trial.asset_id);}
  const saved=f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:p});
  const v=f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:saved.revision});
  const created=f.store.execute({operation:'lab/participant.create',data:{request_id:randomUUID(),version_id:v.version_id,credential_hash:'b'.repeat(64)}});
  const call=(op,data={})=>f.store.execute({operation:`lab/participant.${op}`,session_id:created.session_id,credential_hash:'b'.repeat(64),data});
  const claim=call('claim',{request_id:randomUUID(),writer_id:'rating-writer'}),fence={writer_id:'rating-writer',writer_epoch:claim.writer_epoch};
  const reserve=()=>call('reserve',{request_id:randomUUID(),...fence});const first=reserve();assert.equal(first.selection.roots.length,32);assert.deepEqual(reserve().selection,first.selection);
  f.setNow(400000);assert.deepEqual(reserve().selection,first.selection);
  const prepared=call('preparation',fence);assert.equal(prepared.asset_ids.length,32);
  const choices=p.groups[0].choices,readiness={frame_ms:10,commit_ms:5,protocol_hash:v.hash,layout:'portrait',assets:Object.fromEntries(first.selection.roots.map(t=>[t.asset_id,'a'.repeat(64)])),geometry:{viewport:{width:800,height:1200,dpr:1},canvas:{x:0,y:0,width:413,height:626},buttons:choices.map((choice,i)=>({choice,x:i*88,y:800,width:80,height:48}))}};
  const permit=call('permit',{request_id:randomUUID(),...fence,reservation_id:reserve().reservation_id,readiness});assert.deepEqual(permit.plan.roots,first.selection.roots);assert.equal(permit.plan.rating.labels.length,9);assert.deepEqual(permit.plan.sampling,first.selection.sampling);
});\n