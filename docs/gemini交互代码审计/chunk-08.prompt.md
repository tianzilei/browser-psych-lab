当前交互源码第 8 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_08。
nt.type==='pointermove'){
      if(primary.has(event.pointerId)&&(event.buttons&1)===0){primary.delete(event.pointerId);receive(normalized(event,null,event.pointerId,'cancel'));}
      return;
    }
    if(event.type==='pointerdown'&&event.button!==0)return;
    if(event.type==='pointerdown')primary.add(event.pointerId);
    if(event.type==='pointerup'&&event.button!==0){if(primary.has(event.pointerId)){primary.delete(event.pointerId);receive(normalized(event,null,event.pointerId,'cancel'));}return;}
    const choice=plan.geometry?.buttons.find(b=>event.clientX>=b.x&&event.clientX<b.x+b.width&&event.clientY>=b.y&&event.clientY<b.y+b.height)?.choice??null;
    if(choice!==null)event.preventDefault();
    receive(normalized(event,choice,event.pointerId,event.type==='pointerdown'?'down':event.type==='pointerup'?'up':'cancel'));
    if(event.type!=='pointerdown')primary.delete(event.pointerId);
  };
  const keyboard=(event:KeyboardEvent)=>{
    const index=keys.findIndex(([,code])=>code===event.code);if(index<0)return;
    event.preventDefault();if(event.type==='keydown'&&(event.repeat||event.isComposing||event.altKey||event.ctrlKey||event.metaKey))return;
    receive(normalized(event,keys[index]![0],-index-1,event.type==='keydown'?'down':'up'));
  };
  for(const type of ['pointerdown','pointerup','pointercancel','pointermove'])window.addEventListener(type,pointer as EventListener,{passive:false});
  for(const type of ['keydown','keyup'])window.addEventListener(type,keyboard as EventListener);
  return ()=>{
    for(const type of ['pointerdown','pointerup','pointercancel','pointermove'])window.removeEventListener(type,pointer as EventListener);
    for(const type of ['keydown','keyup'])window.removeEventListener(type,keyboard as EventListener);
  };
}
export function preventTaskGestures(element:HTMLElement){
  const suppress=(event:Event)=>event.preventDefault();
  for(const type of ['contextmenu','selectstart','dragstart'])element.addEventListener(type,suppress);
  return ()=>{for(const type of ['contextmenu','selectstart','dragstart'])element.removeEventListener(type,suppress);};
}
export function showResponse(buttons:HTMLButtonElement[],choice:string|null){
  for(const b of buttons)b.setAttribute('aria-pressed',String(b.textContent===choice));
}

```


=== FILE src/web/prepare.ts (complete source; may continue in next chunk) ===
```
import {openDB,deleteDB} from 'idb';
import {downloadOriginal,DOWNLOAD_POLICY} from './asset-download.js';
import type {LabSession} from '../shared/lab-contract.js';
import {worstAuditPayload,type Group,type Protocol} from '../shared/protocol.js';
export async function refreshProbe(protocol:Protocol){
  const times:number[]=[];await new Promise<void>(resolve=>{let prior:number|null=null;const tick=(t:number)=>{if(prior!==null)times.push(t-prior);prior=t;if(times.length<30)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
  const sorted=[...times].sort((a,b)=>a-b),frame=sorted[Math.floor(sorted.length/2)]!;
  if(1000/frame<protocol.budget.refresh_min_hz||1000/frame>protocol.budget.refresh_max_hz||Math.max(...times)>protocol.budget.long_frame_ms)throw new Error('此设备的显示节奏未满足任务要求，请更换设备或联系研究者。');
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
  const infos=group.trials.filter(t=>t.asset_id).map(t=>session.frozen.assets.find(a=>a.asset_id===t.asset_id)!);if(infos.some(a=>!a))throw new Error('任务图片不完整，请联系研究者。');
  const unique=[...new Map(infos.map(a=>[a.hash,a])).values()];const estimated=unique.reduce((n,a)=>n+a.width*a.height*4,0),originalBytes=unique.reduce((n,a)=>n+a.bytes,0);
  if(estimated>session.frozen.protocol.budget.max_decoded_bytes)throw new Error('任务图片超出此问卷允许的内存用量，请联系研究者。');
  const bitmaps=new Map<string,ImageBitmap>(),controller=new AbortController(),started=performance.now();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(()=>controller.abort(new Error('本组准备超过 20 分钟，请检查网络或联系研究者。')),DOWNLOAD_POLICY.maximum_ms);
  let received=0;
  try{
    // Serial download + decode bounds compressed working memory to one image and
    // avoids doubling every participant's competing stream on a shared 1–5 Mbps link.
    for(const info of unique){
      controller.signal.throwIfAborted();const prior=received;
      const report=(bytes:number)=>status(`正在下载图片 ${Math.min(99,Math.floor((prior+bytes)/Math.max(1,originalBytes)*100))}%`);
      report(0);const data=await downloadOriginal(`/api/participate/sessions/${session.session_id}/assets/${info.asset_id}`,info.bytes,controller.signal,report,undefined,headers);
      const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');if(h!==info.hash)throw new Error('图片完整性校验未通过，请重新准备任务。');
      controller.signal.throwIfAborted();
      const bitmap=await createImageBitmap(new Blob([data],{type:`image/${info.format}`}));
      if(controller.signal.aborted||bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();controller.signal.throwIfAborted();throw new Error('图片尺寸与问卷配置不符，请联系研究者。');}
      bitmaps.set(info.hash,bitmap);received+=info.bytes;
    }
    controller.signal.throwIfAborted();status('图片已准备，正在检查设备…');
    const byAsset=new Map(infos.map(a=>[a.asset_id,bitmaps.get(a.hash)!]));
    return {byAsset,hashes:Object.fromEntries(infos.map(a=>[a.asset_id,a.hash])),decoded_bytes:estimated,
      download:{original_bytes:originalBytes,downloaded_bytes:received,unique_images:unique.length,elapsed_ms:performance.now()-started,policy:'serial-stall60s-total20m-v1'},
      release:()=>{for(const image of bitmaps.values())image.close();bitmaps.clear();}};
  }catch(error){controller.abort(error);for(const image of bitmaps.values())image.close();throw error;}
  finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
}

```


=== FILE src/web/asset-download.ts (complete source; may continue in next chunk) ===
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
    throw new Error('图片大小配置无效，请联系研究者。');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const total = setTimeout(() => controller.abort(new Error('图片下载超时，请检查网络后重新准备。')), policy.total_ms);
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
      if (received + part.value.byteLength > expectedBytes) throw new Error('图片大小与问卷配置不符，请联系研究者。');
      bytes.set(part.value, received); received += part.value.byteLength;
      activity(); progress(received);
    }
    if (received !== expectedBytes) throw new Error('图片未完整下载，请重新准备任务。');
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


=== FILE src/web/preparation-gate.ts (complete source; may continue in next chunk) ===
```
import {request,uid} from './dom.js';
import type {ParticipantAPI} from './participant-api.js';
import {RequestError} from './request-error.js';
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
    if(result.status!=='READY')throw new RequestError('PREPARATION_CAPACITY_FULL',409);
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


=== FILE src/web/task-liveness.ts (complete source; may continue in next chunk) ===
```
import type {ParticipantAPI} from './participant-api.js';
import {TASK_ACTIVITY_POLICY as policy} from '../shared/task-policy.js';
// Actions stay local. A tiny control request renews the task lease at most once
// per minute; transient network failures do not block the UI or lose evidence.
export function taskLiveness(api:ParticipantAPI,interrupt:(reason:string)=>void){
  const events=document;
  let last=performance.now(),lastAck=last,closed=false,inFlight=false;
  const activity=(event:Event)=>{if(event.isTrusted)last=performance.now();};
  const types=['pointerdown','pointermove','pointerup','keydown','input'];
  for(const type of types)events.addEventListener(type,activity,{capture:true,passive:true});
  const stop=()=>{
    if(closed)return;
    closed=true;clearInterval(check);clearInterval(renew);
    for(const type of types)events.removeEventListener(type,activity,true);
  };
  const fail=(reason:string)=>{if(closed)return;stop();interrupt(reason);};
  const check=setInterval(()=>{
    if(performance.now()-last>=policy.idle_timeout_ms)fail('USER_