import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RunReplay} from '../../src/shared/run-replay.ts';
import {plan,trace} from '../helpers/run-trace.mjs';
test('hundreds of seeded fixed/dynamic traces independently replay cap, gap, intent and draw evidence',()=>{
  for(let n=1;n<=100;n++)for(let cap=0;cap<=2;cap++){
    const p=plan([n,n*2,n*3,n*4],cap),generated=trace(p,number=>n%2?null:number===1?'right':'left'),replay=new RunReplay(p);
    for(const r of generated.records)replay.apply(r);assert.deepEqual(replay.finish(),generated.results);
    assert.ok(generated.results.length<=p.roots.length*(cap+1));assert.equal(new Set(generated.results.map(r=>r.instance_id)).size,generated.results.length);
  }
});
test('forged random evidence, timing, watermark, answer and omission cannot close normally',()=>{
  const p=plan(),r=trace(p).records;
  for(const mutate of [a=>{a.find(x=>x.type==='OP'&&x.operation.type==='INSERT').operation.random.state[0]++;},a=>{a.find(x=>x.type==='ONSET').at=0;},a=>{a.find(x=>x.type==='WINDOW').processed_watermark++;},a=>{a.find(x=>x.type==='WINDOW').answer='left';},a=>{a.splice(a.findIndex(x=>x.type==='COMMIT'),1);}]){
    const clone=structuredClone(r);mutate(clone);const replay=new RunReplay(p);assert.throws(()=>{for(const row of clone)replay.apply(row);replay.finish();});
  }
});
test('held touch and release cannot answer next image; epoch timestamps normalize, later correct does not replace first',()=>{
  const p=plan([1,2,3,4],0,1),r=new RunReplay(p),s=r.scheduler,a=s.stage('intent',0,'fixture');s.acknowledge(a.op_id,1);r.apply({type:'ONSET',at:1000,instance_id:'root-0:1',draw_time:1000});
  const input=(at,choice,action='down',valid=true)=>r.apply({type:'INPUT',at,pointer_id:1,input_time:at,raw_timestamp:at+100000,time_origin:100000,action,valid,choice,pointer_type:'touch',x:1,y:1});
  input(1010,'right');input(1020,'left','down',false);input(1030,'left','up',false);input(1040,'left');assert.equal(r.results.get('root-0:1').answer,'right');
  assert.throws(()=>input(1050,'left','up',true),/RELEASE_CANNOT_ANSWER/);
});
test('late earlier legal correction cancels only an unstarted proposal; staged correction terminates',()=>{
  for(const count of [1,2]){const p=plan([1,2,3,4],1,count),all=trace(p).records,insert=all.findIndex(r=>r.type==='OP'&&r.operation.type==='INSERT');const stop= count===1?insert+4:insert+2,records=all.slice(0,stop),r=new RunReplay(p);for(const row of records)r.apply(row);
    const late={type:'INPUT',at:1210,pointer_id:7,input_time:1100,raw_timestamp:1100,time_origin:100000,action:'down',valid:true,choice:'left',pointer_type:'touch',x:1,y:1};r.apply(late);
    if(count===1){assert.throws(()=>r.apply({type:'CORRECTION',at:1211,root_id:'root-0',op_id:'correct',evidence:'earlier-first'}),/CORRECTION_BEFORE_SOFTWARE_ONSET/);assert.equal(r.scheduler.state,'TERMINATED');}
    else {const model=new RunReplay(p);for(const row of records)model.apply(row);model.apply(late);const operation=model.scheduler.correctRoot('root-0',1211,'correct','earlier-first');r.apply({type:'CORRECTION',at:1211,root_id:'root-0',op_id:'correct',evidence:'earlier-first',operation});r.apply({type:'COMMIT',at:1212,op_id:'correct'});assert.equal(r.scheduler.queue.some(e=>e.proposal_id!==null),false);assert.equal(r.obligations.has('root-0'),false);}
  }
});
