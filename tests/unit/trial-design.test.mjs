import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {parseProtocol,stableJSON,sampleProtocol} from '../../src/shared/protocol.ts';
import {balancedDurations,orderTrials,realizeTrials} from '../../src/shared/trial-design.ts';
import {RunReplay} from '../../src/shared/run-replay.ts';
import {fixture} from '../helpers/lab-fixture.mjs';
import {plan} from '../helpers/run-trace.mjs';

const seed=[12,34,56,78];
const questionnaire=(count=8)=>({schema:'questionnaire-v1',title:'Timing and ordering',orientation:'portrait',pages:[],
  timing_defaults:{stimulus_ms:'3+-0.5',isi_ms:{base:500,jitter:100},feedback_ms:200},
  groups:[{id:'task',title:'Images and text',choices:['left','right'],repeats:0,ordering:{mode:'balanced',max_run:1},
    response_keys:{left:'KeyF',right:'KeyJ'},feedback:{correct:'correct',incorrect:'incorrect',miss:'miss',neutral:'recorded'},
    trials:Array.from({length:count},(_,i)=>({root_id:`trial-${i}`,text:`Text ${i}`,category:i%2?'B':'A',correct:'left'}))}]});

test('general jitter balances requested durations for small/odd/even trial counts and seeds reproduce',()=>{
  for(const n of [1,2,3,7,50,99,100]){
    const values=balancedDurations({base:3000,jitter:500},n,seed);
    assert.ok(Math.abs(values.reduce((a,b)=>a+b,0)-n*3000)<1e-7);
    assert.ok(values.every(v=>v>=2500&&v<=3500));
    assert.deepEqual(values,balancedDurations({base:3000,jitter:500},n,seed));
  }
  assert.notDeepEqual(balancedDurations({base:3000,jitter:500},20,seed),balancedDurations({base:3000,jitter:500},20,[1,2,3,4]));
});

test('item timing excludes overrides from each balance pool, frame ceiling is explicit, normalized protocol is idempotent',()=>{
  const input=questionnaire();input.groups[0].trials[0].image_ms=1200;
  input.groups[0].trials[1].timing={isi_ms:'0.7+-0.2'};
  const p=compileQuestionnaire(input),g=p.groups[0],result=realizeTrials(g,g.trials,seed,1000/60);
  assert.deepEqual(parseProtocol(p),p);assert.equal(stableJSON(parseProtocol(p)),stableJSON(p));
  assert.equal(result.design.balanced_pools.stimulus_ms.length,7);
  assert.equal(result.design.balanced_pools.isi_ms.length,7);
  assert.equal(result.design.requested.find(t=>t.root_id==='trial-0').image_ms,1200);
  assert.ok(Math.abs(result.design.requested.filter(t=>t.root_id!=='trial-0').reduce((n,t)=>n+t.image_ms,0)-7*3000)<1e-7);
  for(const t of result.roots){const req=result.design.requested.find(r=>r.root_id===t.root_id);
    for(const field of ['image_ms','isi_ms','feedback_ms']){assert.ok(t[field]>=req[field]-1e-8);assert.ok(t[field]-req[field]<1000/60+1e-8);}}
  assert.deepEqual(realizeTrials(g,g.trials,seed,1000/60),result);
});

test('fixed, image shuffle, category blocks and balanced interleaving retain every stimulus exactly once',()=>{
  const g=compileQuestionnaire(questionnaire()).groups[0];
  assert.deepEqual(orderTrials(g.trials,{mode:'fixed'},seed),g.trials);
  const ids=g.trials.map(t=>t.root_id).sort();
  for(const mode of ['shuffle','category','balanced'])for(let i=1;i<=100;i++){
    const out=orderTrials(g.trials,{mode},[i,2,3,4]);assert.deepEqual(out.map(t=>t.root_id).sort(),ids);
    if(mode==='balanced')assert.ok(out.slice(1).every((t,j)=>t.category!==out[j].category));
    if(mode==='category')assert.equal(out.filter((t,j)=>j&&t.category!==out[j-1].category).length,1);
  }
  assert.throws(()=>orderTrials(g.trials.slice(0,3).map(t=>({...t,category:'A'})),{mode:'balanced',max_run:1},seed),/UNSATISFIABLE/);
  assert.throws(()=>orderTrials(g.trials.map(t=>({...t,category:undefined})),{mode:'category'},seed),/CATEGORY_REQUIRED/);
});

test('invalid ranges, ambiguous stimuli, key maps and minimum repeat ISI fail at import',()=>{
  for(const update of [p=>p.timing_defaults.stimulus_ms='0.2+-0.5',p=>p.groups[0].trials[0].asset_id='image',
    p=>p.groups[0].response_keys.right='KeyF',p=>{p.groups[0].repeats=1;p.timing_defaults.isi_ms='0.1+-0.09';}]){
    const p=questionnaire();update(p);assert.throws(()=>compileQuestionnaire(p));
  }
  const p=sampleProtocol();assert.deepEqual(parseProtocol(p),p);
  const legacy={id:'old',title:'old',choices:['left','right'],repeats:0,trials:[{root_id:'one',asset_id:'image',image_ms:200,isi_ms:300,correct:null}]};
  p.groups=[legacy];p.variants[0].group_order=['old'];p.variants[0].trial_order={old:['one']};
  assert.deepEqual(parseProtocol(p),p);assert.equal(realizeTrials(legacy,legacy.trials,seed,10).design,undefined);
});

test('service stores an immutable seeded text plan with no image references; response and feedback replay normally',t=>{
  const p=compileQuestionnaire(questionnaire(2)),f=fixture(t,p),reservation=f.call('reserve',{request_id:randomUUID(),...f.fence});
  const readiness={frame_ms:10,commit_ms:5,protocol_hash:f.version.hash,layout:'portrait',assets:{},geometry:{viewport:{width:800,height:800,dpr:1},canvas:{x:0,y:0,width:600,height:400},buttons:[{choice:'left',x:0,y:500,width:100,height:60},{choice:'right',x:110,y:500,width:100,height:60}]}};
  const request={request_id:randomUUID(),...f.fence,reservation_id:reservation.reservation_id,readiness};
  const permit=f.call('permit',request);assert.deepEqual(f.call('permit',request),permit);
  assert.equal(f.version.assets.length,0);assert.deepEqual(permit.plan.response_keys,p.groups[0].response_keys);
  assert.deepEqual(realizeTrials(p.groups[0],p.groups[0].trials,permit.plan.seed,10).roots,permit.plan.roots);
  const replay=new RunReplay(permit.plan);let serial=0,events=[];
  const emit=r=>{replay.apply(r);events.push(f.wire(permit.scope,'GROUP_RECORD',{record:r}));};
  const stage=at=>{const op=replay.scheduler.stage(`intent-${serial++}`,at,'test');events.push(f.wire(permit.scope,'GROUP_RECORD',{record:{type:'OP',at,operation:op}}));emit({type:'COMMIT',at:at+1,op_id:op.op_id});};
  stage(0);
  while(replay.scheduler.queue.length){
    const e=replay.scheduler.queue[0],id=e.candidate.instance_id,on=e.target;
    emit({type:'ONSET',at:on,instance_id:id,draw_time:on});
    if(replay.scheduler.queue.length>1)stage(on+1);
    emit({type:'INPUT',at:on+10,input_time:on+10,raw_timestamp:on+10,time_origin:123000,pointer_id:-1,pointer_type:'keyboard',key_code:'KeyF',x:0,y:0,action:'down',choice:'left',valid:true});
    emit({type:'INPUT',at:on+11,input_time:on+11,raw_timestamp:on+11,time_origin:123000,pointer_id:-1,pointer_type:'keyboard',key_code:'KeyF',x:0,y:0,action:'up',choice:'left',valid:false});
    emit({type:'WINDOW',at:on+e.candidate.image_ms,draw_time:on+e.candidate.image_ms,instance_id:id,processed_watermark:replay.inputAudit.length,answer:'left'});
    emit({type:'END',at:on+e.candidate.image_ms+e.candidate.feedback_ms+e.candidate.isi_ms,instance_id:id});
  }
  emit({type:'CLOSING',at:20000,unresolved:false});
  assert.ok(replay.finish().every(r=>r.answer==='left'&&r.rt_ms===10));
  assert.ok(f.ingest(events).receipts.every(r=>r.disposition==='ACCEPTED'));
  // Group seals require an independent maintenance proof in the HTTP path;
  // the pure replay above checks exactly the persisted event bytes.
});

test('keyboard mapping is audited; held or second response cannot replace the first',()=>{
  const p=plan(seed,0,1);p.response_keys={right:'KeyJ',left:'KeyF'};
  const r=new RunReplay(p),op=r.scheduler.stage('intent',0,'fixture');r.scheduler.acknowledge(op.op_id,1);
  r.apply({type:'ONSET',at:1000,instance_id:'root-0:1',draw_time:1000});
  const input=(at,choice,code,pointer,action='down',valid=true)=>r.apply({type:'INPUT',at,input_time:at,raw_timestamp:at,time_origin:123000,pointer_id:pointer,pointer_type:'keyboard',key_code:code,x:0,y:0,action,choice,valid});
  input(1010,'right','KeyJ',-2);input(1011,'right','KeyJ',-2,'down',false);input(1012,'right','KeyJ',-2,'up',false);
  input(1013,'left','KeyF',-1);assert.equal(r.results.get('root-0:1').answer,'right');
  assert.throws(()=>input(1014,'right','KeyF',-1),/KEYBOARD_INPUT/);
});

test('group overrides inherit other phases; item-only timings survive serialization and ordering does not resample timing',()=>{
  const input=questionnaire(4);input.groups[0].timing_defaults={stimulus_ms:'2±0.4'};
  input.groups[0].trials[0].timing={feedback_ms:0};
  const p=compileQuestionnaire(input),g=p.groups[0],fixed=realizeTrials({...g,ordering:{mode:'fixed'}},g.trials,seed,10);
  assert.equal(g.timing_defaults.isi_ms.base,500);
  assert.equal(fixed.roots.find(t=>t.root_id==='trial-0').feedback_ms,0);
  assert.equal(fixed.design.requested.reduce((n,t)=>n+t.image_ms,0),8000);
  const shuffled=realizeTrials({...g,ordering:{mode:'shuffle'}},g.trials,seed,10);
  assert.deepEqual([...fixed.roots].sort((a,b)=>a.root_id.localeCompare(b.root_id)),[...shuffled.roots].sort((a,b)=>a.root_id.localeCompare(b.root_id)));
  delete input.timing_defaults;delete input.groups[0].timing_defaults;
  for(const trial of input.groups[0].trials)trial.timing={stimulus_ms:'1±0.1',isi_ms:0};
  const itemOnly=compileQuestionnaire(input);assert.deepEqual(parseProtocol(itemOnly),itemOnly);
  assert.deepEqual(realizeTrials(itemOnly.groups[0],itemOnly.groups[0].trials,seed,10).design.balanced_pools,{});
});

test('unequal category counts remain feasible at the max-run boundary and invalid designs fail at import',()=>{
  const g=compileQuestionnaire(questionnaire()).groups[0];
  const roots=g.trials.map((t,i)=>({...t,category:i<6?'A':'B'}));
  for(let i=1;i<=100;i++){
    const out=orderTrials(roots,{mode:'balanced',max_run:2},[i,2,3,4]);
    assert.equal(out.filter(t=>t.category==='A').length,6);
    assert.ok(out.every((t,j)=>j<2||t.category!==out[j-1].category||t.category!==out[j-2].category));
  }
  const input=questionnaire(4);input.groups[0].trials.forEach(t=>t.category='A');
  assert.throws(()=>compileQuestionnaire(input),/UNSATISFIABLE_CATEGORY_BALANCE/);
});

test('published example compiles with a ZIP reference and keeps item overrides out of balance pools',()=>{
  const source=JSON.parse(readFileSync(new URL('../../examples/questionnaires/randomized-stimuli.json',import.meta.url),'utf8'));
  const p=compileQuestionnaire(source,ref=>{assert.equal(ref.package,'mobile-stimuli.zip');assert.equal(ref.path,'images/mobile-card.png');return 'test-asset';});
  assert.deepEqual(parseProtocol(p),p);
  const g=p.groups[0],plan=realizeTrials(g,g.trials,seed,10);
  assert.equal(plan.roots.length,6);assert.equal(plan.design.balanced_pools.stimulus_ms.length,4);assert.equal(plan.design.balanced_pools.isi_ms.length,5);
});
