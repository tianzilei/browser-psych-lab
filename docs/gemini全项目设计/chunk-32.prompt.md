全项目设计讨论，传输段 32，源码主题：本地账本与参加者生命周期（源包 11/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;await action(restore);if(lock)await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>{owned=false;api?.ledger.db.close();resolve();},{once:true}));});

```

### src/web/session-gate.ts L1–L25

```
import {request,uid} from './dom.js';
import type {ParticipantAPI} from './participant-api.js';
import type {SessionAdmissionStatus} from '../shared/lab-contract.js';
export const capacityMessage='当前作答人数较多，建议30分钟后再进行答题。已保存的答卷保留。';
export function cancelAdmission(controller:AbortController){const error=new Error('已取消进入，可稍后再进行答题。');error.name='SESSION_WAIT_CANCELED';controller.abort(error);}
export async function awaitSessionAdmission(api:ParticipantAPI,signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){
  const nonce=uid(),url=api.path('admission'),body=(action:string)=>({action,ticket_id:nonce,...api.fence()});
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>=Promise.resolve(),failure:unknown;
  const abort=()=>{stopped=true;clearTimeout(timer);};
  const hidden=()=>abort();
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',hidden,{once:true});
  const stop=async()=>{stopped=true;clearTimeout(timer);signal.removeEventListener('abort',abort);window.removeEventListener('pagehide',hidden);await pending;};
  try{
    let sent=performance.now(),result=await request<SessionAdmissionStatus>(url,body('join'),undefined,signal);
    if(result.status!=='ACTIVE')throw new Error(capacityMessage);signal.throwIfAborted();let deadline=sent+result.lease_remaining_ms;
    const renew=()=>{timer=setTimeout(()=>{pending=(async()=>{
      try{const sent=performance.now(),next=await request<SessionAdmissionStatus>(url,body('touch'),undefined,signal);
        if(next.status!=='ACTIVE')throw new Error(capacityMessage);deadline=sent+next.lease_remaining_ms;}
      catch(error){failure=error;if(!stopped&&!signal.aborted)onLost(error);}
      finally{if(!stopped&&!signal.aborted&&!failure)renew();}
    })();},60000);};renew();
    return {stop,check:()=>{signal.throwIfAborted();if(failure)throw failure;if(performance.now()>=deadline)throw new Error(capacityMessage);}};
  }catch(error){await stop();if(signal.reason instanceof Error&&signal.reason.name==='SESSION_WAIT_CANCELED')await request(url,body('leave')).catch(()=>{});throw error;}
}

```

### src/web/task-liveness.ts L1–L19

```
import type {ParticipantAPI} from './participant-api.js';
// Actions stay local. A tiny control request renews the task lease at most once
// per minute; transient network failures do not block the UI or lose evidence.
export function taskLiveness(api:ParticipantAPI,interrupt:(reason:string)=>void){
  const events=document;
  let last=performance.now(),lastAck=last,closed=false,inFlight=false;
  const activity=(event:Event)=>{if(event.isTrusted)last=performance.now();};
  const types=['pointerdown','pointermove','pointerup','keydown','input'];
  for(const type of types)events.addEventListener(type,activity,{capture:true,passive:true});
  const check=setInterval(()=>{if(performance.now()-last>=120000)interrupt('USER_IDLE_TIMEOUT');else if(performance.now()-lastAck>=300000)interrupt('CONNECTION_TIMEOUT');},1000);
  const renew=setInterval(()=>{if(closed||inFlight||performance.now()-last>=120000)return;inFlight=true;
    void fetch(api.path('activity'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(api.fence()),signal:AbortSignal.timeout(10000)}).then(async response=>{
      if(response.ok){const value=await response.json() as {status:string};if(value.status==='ACTIVE')lastAck=performance.now();else interrupt('SERVER_TASK_TERMINATED');}
      else if([401,409].includes(response.status))interrupt('SERVER_TASK_TERMINATED');
    }).catch(()=>{}).finally(()=>{inFlight=false;});
  },60000);
  return ()=>{closed=true;clearInterval(check);clearInterval(renew);for(const type of types)events.removeEventListener(type,activity,true);};
}

```

### src/web/interaction-recorder.ts L1–L19

```
import type {InteractionBatch,InteractionContext,InteractionSample,InteractionScreen,ScreenNode} from '../shared/interaction.js';
// Separate diagnostic chains preserve every browser-delivered/coalesced drag sample
// without changing answer seals or the experiment scheduler's replay protocol.
export function recordInteractions(root:HTMLElement,context:()=>InteractionContext,save:(batch:InteractionBatch)=>Promise<unknown>,fail:(error:unknown)=>void){
  let samples:InteractionBatch['samples']=[],timer:ReturnType<typeof setTimeout>|undefined,closed=false,pending=Promise.resolve();const listeners:[EventTarget,string,EventListener][]=[];let onset=performance.now(),position='',lastScreen='',bytes=0;
  const box=(e:Element)=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const flush=()=>{clearTimeout(timer);timer=undefined;if(!samples.length)return pending;const batch={schema:'interaction-v1' as const,time_origin:performance.timeOrigin,samples};samples=[];bytes=0;pending=save(batch).then(()=>{}).catch(fail);return pending;};
  const add=(sample:InteractionBatch['samples'][number])=>{if(closed)return;const size=new TextEncoder().encode(JSON.stringify(sample)).length;if(bytes+size>90000)void flush();samples.push(sample);bytes+=size;if(samples.length>=64)void flush();else timer??=setTimeout(()=>{void flush();},100);};
  const identify=(node:Element)=>{if(node.id)return `#${node.id}`;const path:string[]=[];let e:Element|null=node;while(e&&e!==root){path.unshift(`${e.tagName.toLowerCase()}:nth-child(${Array.from(e.parentElement?.children??[]).indexOf(e)+1})`);e=e.parentElement;}return path.join('>');};
  const styles=['color','background-color','border-top-width','border-top-style','border-top-color','border-radius','font-family','font-size','font-weight','line-height','text-align','padding','opacity','white-space'] as const;
  function screen(){if(closed)return;const c=context(),key=JSON.stringify([c.page_id,c.question_id,c.instance_id,c.item,c.phase]);if(key!==position){position=key;onset=performance.now();}const nodes:ScreenNode[]=[];for(const e of root.querySelectorAll<HTMLElement>('*')){const r=box(e),c=getComputedStyle(e);if(!r.width||!r.height||c.visibility!=='visible'||c.display==='none'||e.closest('[style*="opacity: 0"]'))continue;const style=Object.fromEntries(styles.map(k=>[k,c.getPropertyValue(k)]));const node:ScreenNode={...r,tag:e.tagName.toLowerCase(),text:'',style};if(e instanceof HTMLInputElement){node.value=e.value;node.tag=e.type==='range'?'range':'input';node.disabled=e.disabled;node.checked=e.checked;if(e.type==='range'){node.style.min=e.min;node.style.max=e.max;node.style.answered=e.dataset.answered??'false';}}if(e instanceof HTMLButtonElement)node.disabled=e.disabled;if(e instanceof HTMLCanvasElement){node.asset_id=context().asset_id;node.text=context().stimulus_text??'';}nodes.push(node);for(const child of e.childNodes)if(child.nodeType===Node.TEXT_NODE&&child.textContent?.trim()){const range=document.createRange();range.selectNodeContents(child);const rect=range.getBoundingClientRect();nodes.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,tag:'text',text:child.textContent,style});}if(nodes.length>1900)break;}
    const signature=JSON.stringify([context(),innerWidth,innerHeight,scrollX,scrollY,nodes]);if(signature===lastScreen)return;lastScreen=signature;const v=visualViewport;add({type:'screen',at:performance.now(),context:context(),width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scroll_x:scrollX,scroll_y:scrollY,visual_viewport:v?{x:v.offsetLeft,y:v.offsetTop,width:v.width,height:v.height,scale:v.scale}:null,background:getComputedStyle(document.documentElement).backgroundColor,nodes});}
  function event(e:Event){const target=e.target instanceof Element?e.target:root;const pointer=e instanceof PointerEvent;const list=pointer&&e.type==='pointermove'?(e.getCoalescedEvents?.().length?e.getCoalescedEvents():[e]):[e];for(const item of list){const p=item instanceof PointerEvent?item:null,k=item instanceof KeyboardEvent?item:null;const sample:InteractionSample={type:e.type,at:item.timeStamp<=performance.now()+1?item.timeStamp:item.timeStamp-performance.timeOrigin,raw_timestamp:item.timeStamp,context:context(),target:identify(target),box:box(target),x:p?.clientX??null,y:p?.clientY??null,trusted:e.isTrusted,...(p?{pointer_id:p.pointerId,pointer_type:p.pointerType,button:p.button,buttons:p.buttons,pressure:p.pressure}:{}),...(k?{key:k.key,code:k.code}:{}),...(target instanceof HTMLInputElement?{value:target.value}:{}),...(e instanceof InputEvent?{input_type:e.inputType}:{})};sample.rt_ms=Math.max(0,sample.at-onset);add(sample);}if(!['pointermove','pointerrawupdate'].includes(e.type))queueMicrotask(screen);}
  const listen=(target:EventTarget,type:string,handler:EventListener)=>{target.addEventListener(type,handler,{capture:true,passive:true});listeners.push([target,type,handler]);};
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click','keydown','keyup','input','change','focusin','focusout','compositionstart','compositionend'])listen(root,type,event);
  listen(window,'resize',screen);listen(window,'scroll',screen);listen(document,'visibilitychange',screen);screen();
  return {screen,flush,stop:()=>{closed=true;for(const [target,type,handler]of listeners)target.removeEventListener(type,handler,true);void flush();}};
}

```

### src/web/environment.ts L1–L35

```
type ExtendedNavigator=Navigator&{deviceMemory?:number;globalPrivacyControl?:boolean;connection?:{effectiveType?:string;type?:string;downlink?:number;downlinkMax?:number;rtt?:number;saveData?:boolean};
  userAgentData?:{brands:unknown;mobile:boolean;platform:string;getHighEntropyValues:(keys:string[])=>Promise<unknown>};getBattery?:()=>Promise<{charging:boolean;level:number;chargingTime:number;dischargingTime:number}>};
const bounded=async(fn:()=>Promise<unknown>,ms=250)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([fn().then(value=>({status:'available',value}),()=>({status:'blocked-or-error',value:null})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout',value:null}),ms);})]);}catch{return {status:'blocked-or-error',value:null};}finally{clearTimeout(timer);}};
const optional=(fn:(()=>Promise<unknown>)|undefined)=>fn?bounded(fn):Promise.resolve({status:'unsupported',value:null});
const finite=(v:number|undefined)=>v!==undefined&&Number.isFinite(v)?v:null;
function inference(ua:string){
  const browser=[/(Edg|EdgiOS|EdgA)\/([\d.]+)/,/(OPR)\/([\d.]+)/,/(Firefox|FxiOS)\/([\d.]+)/,/(Chrome|CriOS)\/([\d.]+)/,/(Version)\/([\d.]+)/].map(pattern=>ua.match(pattern)).find(Boolean);
  const os=ua.match(/(Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|CrOS|Linux)/);
  return {source:'user-agent-heuristic',browser:browser?`${({Edg:'Edge',EdgiOS:'Edge',EdgA:'Edge',OPR:'Opera',FxiOS:'Firefox',CriOS:'Chrome',Version:'Safari'} as Record<string,string>)[browser[1]!]??browser[1]} ${browser[2]}`:'unknown',os:os?.[0]??'unknown',device:/Mobile|Android|iPhone|iPad/.test(ua)?'mobile-or-tablet':'desktop-or-unknown'};
}
export async function collectEnvironment(){
  const n=navigator as ExtendedNavigator,v=visualViewport,match=(q:string)=>matchMedia(q).matches;
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  let graphics:unknown={status:'unsupported',value:null};
  try{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl');if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');graphics={status:ext?'available':'masked',value:{vendor:gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL??gl.VENDOR),renderer:gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),version:gl.getParameter(gl.VERSION),shading_language:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),max_texture_size:gl.getParameter(gl.MAX_TEXTURE_SIZE)}};gl.getExtension('WEBGL_lose_context')?.loseContext();}}catch{graphics={status:'blocked-or-error',value:null};}
  const data={schema:'environment-v1',sampled_at:new Date().toISOString(),time_origin:performance.timeOrigin,sampled_performance_ms:performance.now(),
    user_agent:n.userAgent,user_agent_inferred:inference(n.userAgent),client_hints_low:n.userAgentData?{brands:n.userAgentData.brands,mobile:n.userAgentData.mobile,platform:n.userAgentData.platform}:null,
    platform:n.platform,vendor:n.vendor,app_version:n.appVersion,language:n.language,languages:[...(n.languages??[])],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timezone_offset_minutes:new Date().getTimezoneOffset(),
    hardware:{logical_processors:n.hardwareConcurrency??null,device_memory_gb:n.deviceMemory??null,max_touch_points:n.maxTouchPoints},
    screen:{width:screen.width,height:screen.height,available_width:screen.availWidth,available_height:screen.availHeight,color_depth:screen.colorDepth,pixel_depth:screen.pixelDepth,orientation_type:screen.orientation?.type??null,orientation_angle:screen.orientation?.angle??null},
    viewport:{width:innerWidth,height:innerHeight,document_width:document.documentElement.clientWidth,document_height:document.documentElement.clientHeight,dpr:devicePixelRatio,visual:v?{width:v.width,height:v.height,offset_left:v.offsetLeft,offset_top:v.offsetTop,scale:v.scale}:null},
    preferences:Object.fromEntries(['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)','(prefers-contrast: more)','(prefers-contrast: less)','(forced-colors: active)','(pointer: coarse)','(pointer: fine)','(hover: hover)','(any-pointer: coarse)','(any-pointer: fine)','(any-hover: hover)','(inverted-colors: inverted)','(display-mode: standalone)','(dynamic-range: high)','(color-gamut: srgb)','(color-gamut: p3)','(color-gamut: rec2020)'].map(q=>[q,match(q)])),