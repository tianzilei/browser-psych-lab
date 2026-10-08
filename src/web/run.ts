import './style.css';
import {el,button,uid,request} from './dom.js';
import {ParticipantAPI} from './participant-api.js';
import {prepareImages,refreshProbe,storageProbe} from './prepare.js';
import {awaitPreparation} from './preparation-gate.js';
import {cancelAdmission} from './session-gate.js';
import {RunReplay} from '../shared/run-replay.js';
import type {GroupPlan,InputRecord,RunRecord,LabSession} from '../shared/lab-contract.js';
import type {ScheduleAudit} from '../shared/scheduler.js';
const version=new URLSearchParams(location.search).get('version')??'',writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();
sessionStorage.setItem(`lab-writer-${version}`,writer);
const content=document.querySelector<HTMLDivElement>('#content')!,status=document.querySelector<HTMLParagraphElement>('#status')!,title=document.querySelector<HTMLHeadingElement>('#title')!;
let api:ParticipantAPI|null=null,active=false,owned=false,releaseImages:(()=>void)|null=null,frameId=0;
const returnToPage=()=>{location.href=`/participate.html?version=${version}`;};
function failure(error:unknown){status.textContent=error instanceof Error?error.message:'准备失败。';content.replaceChildren(button('返回保存与核对',returnToPage));}
function geometry(canvas:HTMLCanvasElement,buttons:HTMLButtonElement[]):NonNullable<GroupPlan['geometry']>{const rect=(e:HTMLElement)=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvas:rect(canvas),buttons:buttons.map(b=>({choice:b.textContent!,...rect(b)}))};}
async function prepare(){
  api=await ParticipantAPI.open(version,writer);await api.refresh();if(api.session.state==='COMPLETED'||api.session.state==='TERMINATED'||api.session.permit?.state==='ISSUED'){returnToPage();return;}
  const preparing=new AbortController(),pageHidden=()=>preparing.abort(new Error('准备页面已关闭。'));
  window.addEventListener('pagehide',pageHidden,{once:true});
  content.replaceChildren(button('退出等待',()=>cancelAdmission(preparing)));
  await api.enter(preparing.signal,text=>status.textContent=text,error=>{preparing.abort(error);releaseImages?.();releaseImages=null;failure(error);});
  await api.claim();if(api.session.page_index<api.session.frozen.protocol.pages.length){returnToPage();return;}
  const reserve=(signal?:AbortSignal)=>request<{reservation_id:string;variant_id:string}>(api!.path('reserve'),{request_id:uid(),...api!.fence()},undefined,signal);
  let reservation=await reserve();
  const p=api.session.frozen.protocol,variant=p.variants.find(v=>v.id===reservation.variant_id)!,group=p.groups.find(g=>g.id===variant.group_order[api!.session.group_index]);
  if(!group){returnToPage();return;}title.textContent=group.title;status.textContent='正在校验资源和本地保存路径…';
  content.replaceChildren(button('取消准备',()=>preparing.abort(new Error('已取消准备，可返回后重试。'))));
  let renewal:Promise<void>=Promise.resolve(),renewTimer:ReturnType<typeof setTimeout>|undefined,renewing=true;
  const renew=()=>{renewTimer=setTimeout(()=>{
    renewal=(async()=>{try{const next=await reserve(preparing.signal);if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;}
      catch(error){preparing.abort(error);}finally{if(renewing&&!preparing.signal.aborted)renew();}})();
  },60000);};renew();
  let images:Awaited<ReturnType<typeof prepareImages>>;
  try{const gate=await awaitPreparation(api,preparing.signal,text=>status.textContent=text,error=>preparing.abort(error));
    try{images=await prepareImages(api.session,group,text=>status.textContent=text,preparing.signal,gate.headers);releaseImages=images.release;gate.check();}
    finally{await gate.release();}
  }
  finally{renewing=false;clearTimeout(renewTimer);await renewal;window.removeEventListener('pagehide',pageHidden);}
  preparing.signal.throwIfAborted();
  const measured=await refreshProbe(p),storage=await storageProbe(group,p);if(storage.commit_ms>p.budget.commit_ms)throw new Error('本地事务耗时超过此版本预算，无法开始该组。');
  const canvas=el('canvas'),buttons=group.choices.map(c=>el('button',c));canvas.id='stimulus';const controls=el('div',undefined,'response-buttons');controls.append(...buttons);
  const stage=el('div',undefined,'runner-stage');stage.append(canvas,controls);content.replaceChildren(stage);
  const layout=innerWidth>innerHeight?'landscape':'portrait',min=layout==='portrait'?p.layout.portrait_min_width:p.layout.landscape_min_width;
  const width=Math.floor(Math.min(innerWidth-32,720,(innerHeight-(layout==='landscape'?180:230))*p.layout.aspect));if(width<min)throw new Error('屏幕可用区域不足，请在开始前调整方向。');
  canvas.style.width=`${width}px`;canvas.style.height=`${width/p.layout.aspect}px`;canvas.width=Math.round(width*devicePixelRatio);canvas.height=Math.round(width/p.layout.aspect*devicePixelRatio);
  const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('Canvas 不可用。');ctx.fillStyle=p.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);
  const ready=geometry(canvas,buttons);status.textContent=`${p.mode==='TEST_ONLY'?'测试数据 · ':''}资源已校验。请保持页面可见与设备方向，开始后连续完成本组。`;
  const start=button('开始本组',async()=>{try{
    api!.admission?.check();await api!.stopAdmission();start.remove();if(document.visibilityState!=='visible')throw new Error('页面当前不可见。');const actual=geometry(canvas,buttons);if(JSON.stringify(actual)!==JSON.stringify(ready))throw new Error('准备后布局已变化，请重新准备。');
    const next=await reserve();if(next.variant_id!==reservation.variant_id)throw new Error('预留方案已变化，请重新准备。');reservation=next;
    const permit=await request<NonNullable<LabSession['permit']>>(api!.path('permit'),{request_id:uid(),...api!.fence(),reservation_id:reservation.reservation_id,readiness:{...measured,...storage,download:images.download,layout,geometry:ready,assets:images.hashes,decoded_bytes:images.decoded_bytes,protocol_hash:api!.session.frozen.hash}});
    await api!.refresh();await run(permit.plan,canvas,buttons,images.byAsset,ctx);
  }catch(error){releaseImages?.();releaseImages=null;if(api?.session.permit?.state==='ISSUED')await api.terminate('PREPARATION_INTERRUPTED',{message:String(error)}).catch(()=>{});failure(error);}});content.prepend(start);
}
async function run(plan:GroupPlan,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D){
  const a=api!,origin=performance.now(),now=()=>performance.now()-origin,replay=new RunReplay(plan),s=replay.scheduler;
  let pending=false,stopped=false,closing=false,lastFrame=0;active=true;document.body.classList.add('running');
  const record=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:{...r,clock_origin:origin}});
  const emit=(r:RunRecord)=>{r.clock_origin=origin;replay.apply(r);void record(r).catch(stop);};
  const clear=()=>{ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);};
  async function stop(reason:unknown){if(stopped)return;stopped=true;active=false;cancelAnimationFrame(frameId);clear();remove();s.interrupt(false);
    status.textContent='本组已中断，已保存记录正在补传。';await record({type:'ABORT',at:now(),reason:String(reason).slice(0,150)}).catch(()=>{});
    try{await a.terminate('SOFTWARE_RUN_INTERRUPTED',{reason:String(reason).slice(0,150)});await a.sync();}catch{status.textContent='本组已中断。部分记录仍在本机，恢复页面可继续补传。';}
    releaseImages?.();releaseImages=null;content.replaceChildren(button('返回核对保存记录',returnToPage));}
  async function stage(){if(stopped||pending||s.executions.size===0||s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='STAGED')||!s.queue.some(e=>s.executions.get(e.candidate.instance_id)==='UNSTARTED'))return;
    try{const t=now(),op=s.stage(uid(),t,'single-next-instance-before-target');pending=true;await record({type:'OP',at:t,operation:op});if(!stopped)emit({type:'COMMIT',at:now(),op_id:op.op_id});}catch(error){await stop(error);}finally{pending=false;}}
  async function afterWindow(root:string){try{if(replay.obligations.has(root)&&!pending){const t=now(),op=s.proposeRepeat(root,uid(),uid(),t,'window-first-legal-answer-or-miss');if(op){pending=true;await record({type:'OP',at:t,operation:op});if(!stopped)emit({type:'COMMIT',at:now(),op_id:op.op_id});pending=false;}}await stage();}catch(error){await stop(error);}}
  function input(event:PointerEvent){if(stopped)return;if(closing){void a.ledger.append(`d-${plan.scope}`,'INPUT_DIAGNOSTIC',{reason:'GROUP_CLOSING',action:event.type,pointer_id:event.pointerId,raw_timestamp:event.timeStamp,time_origin:performance.timeOrigin,clock_origin:origin,at:now(),x:event.clientX,y:event.clientY}).catch(stop);return;}try{const at=now(),raw=event.timeStamp,mono=raw<=performance.now()+1?raw-origin:raw-performance.timeOrigin-origin;
    const action=event.type==='pointerdown'?'down':event.type==='pointerup'?'up':'cancel',choice=plan.geometry!.buttons.find(b=>event.clientX>=b.x&&event.clientX<b.x+b.width&&event.clientY>=b.y&&event.clientY<b.y+b.height)?.choice??null;
    const result=[...replay.results.values()].find(v=>mono>=v.onset&&(v.clear===null||mono<v.clear));
    const valid=action==='down'&&!!result&&!replay.pointers.has(event.pointerId)&&replay.pointers.size===0&&choice!==null;
    const old=result?.answer,oldTime=result?.input_time;const r:InputRecord={type:'INPUT',at,input_time:mono,pointer_id:event.pointerId,action,valid,choice,raw_timestamp:raw,time_origin:performance.timeOrigin,pointer_type:event.pointerType,x:event.clientX,y:event.clientY};emit(r);
    if(result&&result.clear!==null&&valid&&(oldTime===null||mono<oldTime!)&&old!==result.answer&&(plan.roots.find(t=>t.root_id===result.root_id)!.correct===null||result.correct===true)&&replay.obligations.has(result.root_id)){
      const t=now(),opid=uid(),op=s.correctRoot(result.root_id,t,opid,'verified-earlier-first-input');replay.obligations.delete(result.root_id);if(op)pending=true;
      void record({type:'CORRECTION',at:t,root_id:result.root_id,op_id:opid,evidence:'verified-earlier-first-input',...(op?{operation:op}:{})}).then(async()=>{if(op&&!stopped){emit({type:'COMMIT',at:now(),op_id:op.op_id});pending=false;await stage();}}).catch(stop);
    }
  }catch(error){void stop(error);}}
  const change=()=>{if(document.visibilityState!=='visible'||JSON.stringify(geometry(canvas,buttons))!==JSON.stringify(plan.geometry))void stop('VISIBILITY_OR_GEOMETRY_CHANGED');};
  for(const type of ['pointerdown','pointerup','pointercancel'])window.addEventListener(type,input as EventListener);
  window.addEventListener('resize',change);document.addEventListener('visibilitychange',change);
  const unload=()=>{if(active){s.interrupt(false);void record({type:'ABORT',at:now(),reason:'PAGE_HIDDEN_OR_CLOSED'});}};window.addEventListener('pagehide',unload);
  function remove(keepInputs=false){document.body.classList.remove('running');if(!keepInputs)for(const type of ['pointerdown','pointerup','pointercancel'])window.removeEventListener(type,input as EventListener);window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',unload);}
  async function finish(){closing=true;active=false;remove(true);try{emit({type:'CLOSING',at:now(),unresolved:[...replay.obligations].some(root=>s.candidates.some(c=>c.root_id===root&&s.executions.get(c.instance_id)==='UNSTARTED'))});replay.finish();await a.ledger.drain();await a.ledger.closeScope(plan.scope,[...a.session.path,plan.group_id]);status.textContent='本组结束，正在保存与核对…';await a.seal(plan.scope);remove();await a.sync();releaseImages?.();releaseImages=null;returnToPage();}catch(error){
    if(stopped)return;const pending=(await a.ledger.state()).pending[plan.scope];if(pending){status.textContent='本组已结束，保存与封存待重试。';releaseImages?.();releaseImages=null;content.replaceChildren(button('重试保存与核对',async()=>{try{await a.seal(plan.scope);remove();await a.sync();returnToPage();}catch(e){status.textContent=String(e);}}));}else{closing=false;await stop(error);}}}
  function tick(raf:number){if(stopped||closing)return;const t=now();try{
    if(lastFrame&&t-lastFrame>plan.budget.long_frame_ms)throw new Error('LONG_FRAME');lastFrame=t;
    const e=s.queue[0];if(!e){if(!pending){void finish();return;}}
    else {const id=e.candidate.instance_id,state=s.executions.get(id);
      if(t>=e.target&&state==='UNSTARTED')throw new Error('START_INTENT_NOT_COMMITTED');
      if(state==='STAGED'&&t>=e.target){if(t>=e.target+e.candidate.image_ms)throw new Error('MISSED_IMAGE_WINDOW');const image=images.get((plan.roots.find(r=>r.root_id===e.candidate.root_id)!).asset_id)!;
        clear();const scale=Math.min(canvas.width/image.width,canvas.height/image.height),w=image.width*scale,h=image.height*scale;ctx.drawImage(image,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
        emit({type:'ONSET',at:t,instance_id:id,draw_time:now(),raf_time:raf-origin});status.textContent=`本组已呈现 ${s.observed.length} 次 · 最多 ${s.candidates.length} 次`;void stage();
      }else if(state==='ONSET_OBSERVED'&&t>=e.target+e.candidate.image_ms){clear();emit({type:'WINDOW',at:t,instance_id:id,draw_time:now(),raf_time:raf-origin,answer:replay.results.get(id)!.answer,processed_watermark:replay.inputAudit.length});void afterWindow(e.candidate.root_id);
      }else if(state==='WINDOW_CLOSED'&&t>=e.target+e.candidate.image_ms+e.candidate.isi_ms){emit({type:'END',at:t,instance_id:id});void stage();}
    }
  }catch(error){void stop(error);return;}frameId=requestAnimationFrame(tick);}
  await stage();if(!stopped){status.textContent='本组即将开始。';frameId=requestAnimationFrame(tick);}
}
if(!version||!navigator.locks||!crypto.subtle)failure(new Error('浏览器能力或参与链接不完整。'));
else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;if(!owned){status.textContent='此会话已在其他页面打开。';return;}try{await prepare();}catch(error){await api?.stopAdmission();releaseImages?.();failure(error);}await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>resolve(),{once:true}));});
