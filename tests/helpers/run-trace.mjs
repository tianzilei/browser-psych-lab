import {RunReplay} from '../../src/shared/run-replay.ts';
import {sampleProtocol} from '../../src/shared/protocol.ts';
export function plan(seed=[1,2,3,4],repeats=2,count=4){return {group_id:'pictures',scope:'g-test',seed,roots:Array.from({length:count},(_,i)=>({root_id:`root-${i}`,asset_id:`image-${i}`,image_ms:200,isi_ms:300,correct:'left'})),choices:['left','right'],repeats,start:1000,frame_ms:1000/60,layout:'portrait',budget:sampleProtocol().budget};}
export function trace(p,answer=(number)=>number===1?null:'left'){
  const replay=new RunReplay(p),s=replay.scheduler,records=[];let serial=0;
  const emit=r=>{records.push(r);replay.apply(r);};
  const op=(audit,at)=>{if(audit){records.push({type:'OP',at,operation:structuredClone(audit)});emit({type:'COMMIT',at:at+1,op_id:audit.op_id});}};
  const stage=at=>{if(!s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='STAGED')&&s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='UNSTARTED'))op(s.stage(`stage-${serial++}`,at,'fixture'),at);};
  stage(0);let safety=0;
  while(s.queue.length){if(++safety>300)throw new Error('bounded trace exceeded');const e=s.queue[0],id=e.candidate.instance_id,t=e.target;
    emit({type:'ONSET',at:t,instance_id:id,draw_time:t});stage(t+1);
    const choice=answer(e.candidate.number,e.candidate.root_id);
    if(choice){emit({type:'INPUT',at:t+10,action:'down',pointer_id:1,input_time:t+10,valid:true,choice,raw_timestamp:t+10,time_origin:123000,pointer_type:'touch',x:(p.geometry?.buttons.find(b=>b.choice===choice)?.x??0)+1,y:(p.geometry?.buttons.find(b=>b.choice===choice)?.y??0)+1});emit({type:'INPUT',at:t+11,action:'up',pointer_id:1,input_time:t+11,valid:false,choice,raw_timestamp:t+11,time_origin:123000,pointer_type:'touch',x:(p.geometry?.buttons.find(b=>b.choice===choice)?.x??0)+1,y:(p.geometry?.buttons.find(b=>b.choice===choice)?.y??0)+1});}
    emit({type:'WINDOW',at:t+e.candidate.image_ms,instance_id:id,draw_time:t+e.candidate.image_ms,processed_watermark:replay.inputAudit.length,answer:replay.results.get(id).answer});
    if(replay.obligations.has(e.candidate.root_id))op(s.proposeRepeat(e.candidate.root_id,`proposal-${serial++}`,`insert-${serial++}`,t+e.candidate.image_ms+1,'fixture-window'),t+e.candidate.image_ms+1);
    stage(t+e.candidate.image_ms+3);emit({type:'END',at:t+e.candidate.image_ms+e.candidate.isi_ms,instance_id:id});
  }
  const unresolved=[...replay.obligations].some(root=>s.candidates.some(c=>c.root_id===root&&s.executions.get(c.instance_id)==='UNSTARTED'));
  emit({type:'CLOSING',at:records.at(-1).at+1,unresolved});return {records,results:replay.finish(),replay};
}
