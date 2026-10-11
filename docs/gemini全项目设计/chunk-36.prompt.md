全项目设计讨论，传输段 36，源码主题：实验执行与准备（源包 12/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  async function finish(){phase='closing';disable();remove();try{await emit({type:'CLOSING',at:now(),unresolved:false});replay.finish();await a.ledger.drain();await a.ledger.closeScope(plan.scope,[...a.session.path,plan.group_id]);status.textContent='评分已完成，正在保存与核对…';await a.seal(plan.scope);await a.sync();release();returnToPage();}catch(error){if((await a.ledger.state()).pending[plan.scope]){release();document.body.classList.remove('runner-layout');status.textContent='评分已完成，保存与封存待重试。';content.replaceChildren(button('重试保存与核对',async()=>{try{await a.seal(plan.scope);await a.sync();returnToPage();}catch(e){status.textContent=String(e);}}));}else await stop(error);}}
  function tick(raf:number){if(stopped||phase==='closing')return;const at=now();try{if(lastFrame&&at-lastFrame>plan.budget.long_frame_ms)throw new Error('LONG_FRAME');lastFrame=at;if(phase==='waiting'&&intentReady&&at>=plan.start){const root=plan.roots[index]!,image=images.get(root.asset_id!)!;if(!image)throw new Error('RATING_IMAGE_NOT_PREPARED');ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);const scale=Math.min(canvas.width/image.width,canvas.height/image.height),w=image.width*scale,h=image.height*scale;ctx.drawImage(image,(canvas.width-w)/2,(canvas.height-h)/2,w,h);canvas.style.visibility='visible';void emit({type:'ONSET',at,draw_time:now(),raf_time:raf-origin,instance_id:instance()}).catch(stop);phase='rating';visible(true);question=0;answers=[];selected=null;submission=null;if(age){age.parentElement!.style.visibility='hidden';age.value='';}resetQuestion(0);submit.disabled=true;submit.textContent=items>1?'下一题':'提交评分';heading.textContent=plan.rating!.items?.[0]??plan.rating!.prompt;status.textContent=`第 ${index+1}/${plan.roots.length} 张 · ${heading.textContent}`;recorder.screen();}else if(phase==='rating'&&submission){blank();visible(false);clearAt=now();const answer=submission;phase='isi';answerSaved=false;disable();status.textContent='评分已记录，请等待下一张。';recorder.screen();void emit({type:'RATING',at,draw_time:clearAt,raf_time:raf-origin,input_time:answer.at,instance_id:instance(),values:answer.values}).then(()=>{answerSaved=true;}).catch(stop);}else if(phase==='isi'&&answerSaved&&at>=clearAt+plan.roots[index]!.isi_ms){void emit({type:'END',at,instance_id:instance()}).catch(stop);index++;if(index===plan.roots.length){void finish();return;}phase='waiting';void intent().catch(stop);}}catch(error){void stop(error);return;}frame=requestAnimationFrame(tick);}
  document.body.classList.add('running');submit.style.visibility='hidden';disable();blank();visible(false);await intent();if(!stopped)frame=requestAnimationFrame(tick);
}

```

### src/web/prepare.ts L1–L47

```
import {openDB,deleteDB} from 'idb';
import {downloadOriginal,DOWNLOAD_POLICY} from './asset-download.js';
import type {LabSession} from '../shared/lab-contract.js';
import {worstAuditPayload,type Group,type Protocol} from '../shared/protocol.js';
export async function refreshProbe(protocol:Protocol){
  const times:number[]=[];await new Promise<void>(resolve=>{let prior:number|null=null;const tick=(t:number)=>{if(prior!==null)times.push(t-prior);prior=t;if(times.length<30)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
  const sorted=[...times].sort((a,b)=>a-b),frame=sorted[Math.floor(sorted.length/2)]!;
  if(1000/frame<protocol.budget.refresh_min_hz||1000/frame>protocol.budget.refresh_max_hz||Math.max(...times)>protocol.budget.long_frame_ms)throw new Error('当前刷新节奏不符合该版本预算。');
  return {frame_ms:frame,observed_intervals:times};
}
export async function storageProbe(group:Group,protocol:Protocol){const name=`bpl-storage-probe-${crypto.randomUUID()}`,db=await openDB(name,1,{upgrade(db){db.createObjectStore('events');db.createObjectStore('outbox');db.createObjectStore('meta');}});const samples:number[]=[];
  try{const payload=worstAuditPayload(group,protocol.budget.draw_budget);await db.put('meta',{head:null,sequence:0},'state');for(let i=0;i<10;i++){const start=performance.now();for(let j=0;j<4;j++){
    const meta=await db.get('meta','state');const event={event_id:crypto.randomUUID(),previous:meta.head,sequence:meta.sequence,clock_epoch:crypto.randomUUID(),writer_id:crypto.randomUUID(),protocol_hash:'f'.repeat(64),payload};const raw=JSON.stringify(event),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
    const tx=db.transaction(['events','outbox','meta'],'readwrite',{durability:'strict'});const row={event_id:event.event_id,hash,raw};await tx.objectStore('meta').get('state');await tx.objectStore('events').put(row,'latest');await tx.objectStore('outbox').put(row,'latest');await tx.objectStore('meta').put({head:{event_id:event.event_id,hash},sequence:meta.sequence+1},'state');await tx.done;
  }samples.push(performance.now()-start);}return {commit_ms:Math.max(...samples),samples,path:'four-full-envelope-meta-events-outbox-strict-v1',audit_bytes:new TextEncoder().encode(JSON.stringify(payload)).length};}
  finally{db.close();await deleteDB(name);}
}
export async function prepareImages(session:LabSession,group:Group,status:(text:string)=>void,signal?:AbortSignal,headers:Record<string,string>={}){
  const infos=group.trials.filter(t=>t.asset_id).map(t=>session.frozen.assets.find(a=>a.asset_id===t.asset_id)!);if(infos.some(a=>!a))throw new Error('冻结资源清单不完整。');
  const unique=[...new Map(infos.map(a=>[a.hash,a])).values()];const estimated=unique.reduce((n,a)=>n+a.width*a.height*4,0),originalBytes=unique.reduce((n,a)=>n+a.bytes,0);
  if(estimated>session.frozen.protocol.budget.max_decoded_bytes)throw new Error('图片解码预算不足。');
  const bitmaps=new Map<string,ImageBitmap>(),controller=new AbortController(),started=performance.now();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(()=>controller.abort(new Error('本组准备超过 20 分钟，请检查网络或联系研究者。')),DOWNLOAD_POLICY.maximum_ms);
  let received=0;
  try{
    // Serial download + decode bounds compressed working memory to one image and
    // avoids doubling every participant's competing stream on a shared 1–5 Mbps link.
    for(const info of unique){
      controller.signal.throwIfAborted();const prior=received;
      const report=(bytes:number)=>status(`下载 ${Math.min(99,Math.floor((prior+bytes)/Math.max(1,originalBytes)*100))}%`);
      report(0);const data=await downloadOriginal(`/api/participate/sessions/${session.session_id}/assets/${info.asset_id}`,info.bytes,controller.signal,report,undefined,headers);
      const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');if(h!==info.hash)throw new Error('图片摘要不匹配。');
      controller.signal.throwIfAborted();
      const bitmap=await createImageBitmap(new Blob([data],{type:`image/${info.format}`}));
      if(controller.signal.aborted||bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();controller.signal.throwIfAborted();throw new Error('图片尺寸与冻结清单不符。');}
      bitmaps.set(info.hash,bitmap);received+=info.bytes;
    }
    controller.signal.throwIfAborted();status('下载 100%');
    const byAsset=new Map(infos.map(a=>[a.asset_id,bitmaps.get(a.hash)!]));
    return {byAsset,hashes:Object.fromEntries(infos.map(a=>[a.asset_id,a.hash])),decoded_bytes:estimated,
      download:{original_bytes:originalBytes,downloaded_bytes:received,unique_images:unique.length,elapsed_ms:performance.now()-started,policy:'serial-stall60s-total20m-v1'},
      release:()=>{for(const image of bitmaps.values())image.close();bitmaps.clear();}};
  }catch(error){controller.abort(error);for(const image of bitmaps.values())image.close();throw error;}
  finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
}

```

### src/web/preparation-gate.ts L1–L25

```
import {request,uid} from './dom.js';
import type {ParticipantAPI} from './participant-api.js';
interface Ticket {ticket_id:string;status:'QUEUED'|'READY';position:number;poll_ms:number}
export async function awaitPreparation(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onFailure:(error:unknown)=>void=()=>{}){
  const ticket=uid(),url=api.path('preparation'),fence=api.fence();
  const body=(action:string)=>({action,ticket_id:ticket,...fence});
  let timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),released=false;
  const release=async()=>{if(released)return;released=true;clearTimeout(timer);await pending;
    await request(url,body('release')).catch(()=>{});};
  const hidden=()=>{clearTimeout(timer);void fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body('release')),keepalive:true}).catch(()=>{});};
  window.addEventListener('pagehide',hidden,{once:true});
  try{
    let result=await request<Ticket>(url,body('join'),undefined,signal);
    if(result.status!=='READY')throw new Error('当前作答人数较多，建议30分钟后再进行答题。已保存的答卷保留。');
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{await request<Ticket>(url,body('touch'),undefined,signal);}
      catch(error){renewalError=error;onFailure(error);}
      finally{if(!released&&!signal.aborted&&!renewalError)renew();}
    })();},20000);};let renewalError:unknown;renew();
    return {headers:{'X-Preparation-Ticket':ticket,'X-Writer-Id':fence.writer_id,'X-Writer-Epoch':String(fence.writer_epoch)},
      check:()=>{if(renewalError)throw renewalError;signal.throwIfAborted();},
      release:async()=>{window.removeEventListener('pagehide',hidden);await release();}};
  }catch(error){window.removeEventListener('pagehide',hidden);await release();throw error;}
}

```

### src/web/asset-download.ts L1–L65

```
// Preparation only. One original image at a time; no HTTP work enters the trial loop.
import {wait,overloadDelay} from './wait.js';
export const DOWNLOAD_POLICY = Object.freeze({
  stall_ms: 60_000,
  minimum_ms: 60_000,
  maximum_ms: 20 * 60_000,
  // A planning allowance, not an assertion about the connection's guaranteed speed.
  bytes_per_second: 3 * 1024,
});
export function downloadBudget(bytes: number) {
  return Math.min(DOWNLOAD_POLICY.maximum_ms, Math.max(DOWNLOAD_POLICY.minimum_ms,
    Math.ceil(bytes / DOWNLOAD_POLICY.bytes_per_second * 1000) + DOWNLOAD_POLICY.stall_ms));
}
export async function downloadOriginal(url: string, expectedBytes: number, signal: AbortSignal,
  progress: (bytes: number) => void, policy = {stall_ms: DOWNLOAD_POLICY.stall_ms, total_ms: downloadBudget(expectedBytes)}, headers:Record<string,string>={}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 8 * 1024 * 1024)
    throw new Error('图片字节预算无效。');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const total = setTimeout(() => controller.abort(new Error('图片下载超过准备预算，请重试或联系研究者。')), policy.total_ms);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('图片传输停滞，请检查网络后重试。')), policy.stall_ms);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    activity(); // Includes the time spent waiting for response headers.
    let response:Response;
    for(let attempt=0;;attempt++){
      activity();response=await fetch(url,{cache:'no-store',signal:controller.signal,headers});
      if((response.status!==503&&response.status!==429)||attempt>=7)break;
      await response.body?.cancel();await wait(overloadDelay(response,attempt),controller.signal);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`图片下载失败 (${response.status})，可重试准备。`); }
    if (!response.body) throw new Error('浏览器不支持流式图片下载。');
    reader = response.body.getReader();
    // Allocate once from the trusted frozen size; avoid a chunk list plus another full copy.
    const bytes = new Uint8Array(expectedBytes);
    let received = 0;
    for (;;) {
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      if (received + part.value.byteLength > expectedBytes) throw new Error('图片字节数超出清单。');
      bytes.set(part.value, received); received += part.value.byteLength;
      activity(); progress(received);
    }
    if (received !== expectedBytes) throw new Error('图片未完整下载。');
    return bytes;
  } catch (error) {
    controller.abort(error);
    await reader?.cancel().catch(() => {});
    throw controller.signal.reason ?? error;
  } finally {
    clearTimeout(total); clearTimeout(idle);
    signal.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}

```

### src/web/runner-input.ts L1–L48

```
import type {GroupPlan,InputRecord} from '../shared/lab-contract.js';

// Keep listeners through ISI so a held press cannot answer the next stimulus.
export function bindRunnerInput(plan:GroupPlan,origin:number,receive:(record:InputRecord)=>void){
  const keys=plan.choices.map(choice=>[choice,plan.response_keys?.[choice]] as const);
  const primary=new Set<number>();
  function normalized(event:PointerEvent|KeyboardEvent,choice:string|null,pointer:number,action:InputRecord['action']):InputRecord{
    const at=performance.now()-origin,raw=event.timeStamp;
    return {type:'INPUT',at,input_time:raw<=performance.now()+1?raw-origin:raw-performance.timeOrigin-origin,
      pointer_id:pointer,action,valid:false,choice,raw_timestamp:raw,time_origin:performance.timeOrigin,
      pointer_type:event instanceof KeyboardEvent?'keyboard':event.pointerType,
      x:event instanceof PointerEvent?event.clientX:0,y:event instanceof PointerEvent?event.clientY:0,