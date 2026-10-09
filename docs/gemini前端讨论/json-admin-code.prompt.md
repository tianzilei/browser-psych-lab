请中文审查实际 JSON 管理端/编译器/协变量采样，指出真实功能问题及最小补丁，结尾 JSON_ADMIN_CODE_REVIEW_COMPLETE。用户内容只用JSONfile，不要网页内容编辑，按钮上传/修改/删除/开放/隐藏+模拟。严格parse/unknownfields/只有personal text，scale每刻度labels映射整数，不改变历史冻结hash。上传时先clientcompile以placeholderassetIDs模拟，再createhiddenstudy+ZIPuploads+serverimport freeze newversion；API研究修订冲突拒绝，旧版本有数据始终保留。协变量无需权限无地理相机mic传感器，采UA/hints/系统/屏幕/viewport/DPR/locale/network/hardware/storage/battery/graphics只读头不绘制指纹，每version一次计时前采。图像task运行时不采样请求资源；不会“收集所有系统信息”，不支持值explicitstatus/null。请重点上传失败重试后重复study/packagename、client数据是否有限开销，以及有哪些关键可采字段遗漏。本轮所有设计用户明确使用Gemini bridge。
import './style.css';
import './admin.css';
import {el,button,field,select,uid,request} from './dom.js';
import {compileQuestionnaire,parseQuestionnaireText,questionnaireTemplate,type ImageReference} from '../shared/questionnaire-json.js';
import type {Protocol} from '../shared/protocol.js';
const app=document.querySelector<HTMLDivElement>('#app')!,message=document.querySelector<HTMLParagraphElement>('#message')!;
let csrf='',busy=false;
const api=<T>(url:string,data?:unknown)=>request<T>(url,data,csrf);
const errors:Record<string,string>={PERSONAL_INPUT_ONLY:'只有个人信息题允许文字输入。',ORIENTATION_REQUIRED:'JSON 必须设置 orientation 为 portrait 或 landscape。',SCALE_LABELS_REQUIRED:'请为量表的每个刻度设置 labels 文本。',INVALID_SCALE_LABELS:'量表 labels 必须逐一对应所有刻度，首尾与两端文字一致。',IMAGE_PACKAGE_REFERENCE_MISSING:'JSON 引用的 ZIP 或图片路径不存在。',PACKAGE_NAME_EXISTS:'同名 ZIP 已存在；修改图片请换一个压缩包名称。',DRAFT_REVISION_CONFLICT:'问卷已被修改，请刷新后重新上传。'};
function describe(error:unknown){const text=error instanceof Error?error.message:String(error),code=text.split('：')[0]!;return errors[code]?`${errors[code]} ${text}`:text;}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;message.textContent='正在处理…';try{await fn();message.textContent='';}catch(error){message.textContent=describe(error);}finally{busy=false;}}
function download(name:string,content:unknown){const url=URL.createObjectURL(new Blob([typeof content==='string'?content:JSON.stringify(content,null,2)],{type:'application/json'})),link=el('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function simulate(protocol:Protocol){const overlay=el('div',undefined,'simulation-overlay'),frame=el('iframe');frame.title='模拟问卷';frame.src='/simulate.html';frame.onload=()=>frame.contentWindow?.postMessage({type:'lab-simulation',protocol},location.origin);overlay.append(button('关闭模拟',()=>overlay.remove()),frame);document.body.append(overlay);}
function login(){app.replaceChildren();const section=el('section'),password=field('密码','','password'),role=select('角色',[{value:'researcher',label:'研究者'},{value:'maintainer',label:'维护者'}],'researcher');password.input.autocomplete='current-password';section.append(el('h2','登录'),role.box,password.box,button('登录',()=>action(async()=>{const result=await api<{csrf:string}>('/api/auth/login',{password:password.input.value,role:role.input.value});csrf=result.csrf;await list();})));app.append(section);}
interface Study {study_id:string;title:string;revision:number;admission:string;version_id:string|null}
interface Draft extends Study {draft:Protocol;source:string|null}
function fileField(label:string,accept:string){const box=el('label'),input=el('input');input.type='file';input.accept=accept;box.append(el('span',label),input);return {box,input};}
async function uploadForm(study?:Study){
  const panel=el('section'),json=fileField('问卷 JSON','.json,application/json'),zip=fileField('图片 ZIP（可选，可多选）','.zip,application/zip'),summary=el('p'),validation=el('p');zip.input.multiple=true;validation.setAttribute('role','alert');
  let source='',protocol:Protocol|undefined;
  const preview=button('生成模拟问卷',()=>{if(protocol)simulate(protocol);});preview.disabled=true;
  const upload=button(study?'替换 JSON 并生成新版本':'上传并生成版本',()=>action(async()=>{
    if(!protocol||!source)throw new Error('请先选择并校验 JSON。');
    const s=study??await api<Study>('/api/lab/studies',{request_id:uid()});
    // ZIP files are uploaded before resolving references. Existing packages stay immutable.
    for(const file of Array.from(zip.input.files??[])){
      if(file.size>8*1024*1024)throw new Error('每个 ZIP 不能超过 8 MiB。');
      const response=await fetch(`/api/lab/studies/${s.study_id}/package`,{method:'POST',headers:{'Content-Type':'application/zip','X-CSRF-Token':csrf,'X-Request-Id':uid(),'X-File-Name':encodeURIComponent(file.name)},body:file});
      const result=await response.json() as {code?:string};if(!response.ok)throw new Error(result.code??'ZIP_UPLOAD_FAILED');
    }
    await api(`/api/lab/studies/${s.study_id}/import`,{request_id:uid(),revision:s.revision,source});await list();
  }));upload.disabled=true;
  json.input.onchange=()=>{preview.disabled=upload.disabled=true;protocol=undefined;source='';validation.textContent='';summary.textContent='';void(async()=>{try{const file=json.input.files?.[0];if(!file)return;if(file.size>512*1024)throw new Error('JSON 文件不能超过 512 KiB。');source=await file.text();const references=new Map<string,string>();protocol=compileQuestionnaire(parseQuestionnaireText(source),(ref:ImageReference)=>{const key=`${ref.package}/${ref.path}`;if(!references.has(key))references.set(key,`preview-image-${references.size}`);return references.get(key)!;});summary.textContent=`语法与内容校验通过 · ${protocol.pages.reduce((n,p)=>n+p.questions.length,0)} 题 · ${protocol.groups.length} 图片组 · ${protocol.layout.orientation==='portrait'?'竖屏':'横屏'}`;validation.textContent=references.size?'图片路径将在上传时与 ZIP 核对。模拟前未上传的图片显示占位提示。':'';preview.disabled=upload.disabled=false;}catch(error){validation.textContent=describe(error);}})();};
  panel.append(el('h2',study?`修改：${study.title}`:'上传问卷'),json.box,zip.box,summary,validation,preview,upload,button('取消',()=>panel.remove(),'secondary'));app.prepend(panel);
}
async function list(){const {studies}=await api<{studies:Study[]}>('/api/lab/studies');app.replaceChildren();const nav=el('nav');nav.append(button('上传 JSON',()=>uploadForm()),button('下载 JSON 模板',()=>download('questionnaire.json',questionnaireTemplate())),button('退出',()=>action(async()=>{await api('/api/auth/logout',{});login();})));app.append(nav,el('h2','问卷'));
  if(!studies.length)app.append(el('p','上传 JSON 后可模拟、开放和分享问卷。'));
  for(const s of studies){const card=el('section'),controls=el('div',undefined,'toolbar');card.append(el('h3',s.title),el('p',`版本修订 ${s.revision} · ${s.admission==='OPEN'?'开放':'隐藏'}`));
    controls.append(button('修改 JSON',()=>uploadForm(s)),button('下载 JSON',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);download('questionnaire.json',d.source??JSON.stringify(d.draft,null,2));})),button('模拟问卷',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);simulate(d.draft);})),button(s.admission==='OPEN'?'隐藏':'开放',()=>action(async()=>{if(!s.version_id)throw new Error('请先上传有效 JSON 生成版本。');await api(`/api/lab/studies/${s.study_id}/admission`,{request_id:uid(),paused:s.admission==='OPEN'});await list();})),button('删除',()=>action(async()=>{await api(`/api/lab/studies/${s.study_id}/delete`,{request_id:uid()});await list();}),'secondary'));
    if(s.version_id){const link=el('a','参与链接');link.href=`/participate.html?version=${s.version_id}`;link.target='_blank';link.rel='noopener';controls.append(link);}card.append(controls);app.append(card);
  }
}
void action(async()=>{try{const me=await api<{csrf:string}>('/api/auth/me');csrf=me.csrf;await list();}catch{login();}});
import {ContractError,object,id} from './contract.js';
import {parseProtocol,sampleProtocol,validateQuestionnaire,type Protocol} from './protocol.js';

export interface ImageReference {package:string;path:string}
export function packageName(v:unknown):string {
  if(typeof v!=='string'||v.length>100||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*\.zip$/.test(v))throw new ContractError('INVALID_PACKAGE_NAME');return v;
}
export function imagePath(v:unknown):string {
  if(typeof v!=='string'||v.length>200||v.split('/').some(p=>!p||p==='.'||p==='..'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p))||! /\.(png|jpe?g|webp)$/i.test(v))throw new ContractError('INVALID_IMAGE_PATH');return v;
}
export function parseQuestionnaireText(source:string):unknown {
  if(new TextEncoder().encode(source).length>512*1024)throw new Error('JSON 文件不能超过 512 KiB。');
  try{return JSON.parse(source.replace(/^\uFEFF/,''));}catch(error){throw new Error(`JSON 语法错误：${error instanceof Error?error.message:String(error)}`);}
}
export function compileQuestionnaire(value:unknown,resolveImage:(ref:ImageReference)=>string=()=>{throw new ContractError('IMAGE_PACKAGE_REQUIRED');},strict=true):Protocol {
  const input=object(value);
  if(input.schema==='study-v1'){const p=parseProtocol(input);validateQuestionnaire(p,strict);return p;}
  const allowed=['schema','title','mode','background','orientation','pages','groups','variants','layout','budget'];
  if(input.schema!=='questionnaire-v1'||Object.keys(input).some(k=>!allowed.includes(k)))throw new ContractError('UNKNOWN_QUESTIONNAIRE_FIELD');
  if(!['portrait','landscape'].includes(String(input.orientation)))throw new ContractError('ORIENTATION_REQUIRED');
  const base=sampleProtocol(),groups=input.groups??[];
  if(!Array.isArray(groups))throw new ContractError('INVALID_PROTOCOL_LIST');
  const compiled=groups.map(v=>{const g=object(v);if(!Array.isArray(g.trials))throw new ContractError('INVALID_PROTOCOL_LIST');
    return {...g,id:g.id,trials:g.trials.map(v=>{const t=object(v);if(!t.image)return t;
      if(t.asset_id!==undefined)throw new ContractError('AMBIGUOUS_IMAGE_REFERENCE');
      const image=object(t.image);if(Object.keys(image).some(k=>!['package','path'].includes(k)))throw new ContractError('INVALID_IMAGE_REFERENCE');
      const {image:_,...rest}=t;return {...rest,asset_id:resolveImage({package:packageName(image.package),path:imagePath(image.path)})};})};});
  const pages=input.pages;
  if(!Array.isArray(pages))throw new ContractError('INVALID_PROTOCOL_LIST');
  const normalized=pages.map(v=>{const page=object(v);if(!Array.isArray(page.questions))throw new ContractError('INVALID_PROTOCOL_LIST');
    return {...page,title:page.title??'',instruction:page.instruction??'',questions:page.questions.map(v=>{
      const q=object(v);if(q.type!=='scale')return {...q,required:q.required??true};
      if(!Array.isArray(q.labels)||q.labels.length<2||q.labels.length>21)throw new ContractError('SCALE_LABELS_REQUIRED');
      const min=q.min??1;if(typeof min!=='number')throw new ContractError('INVALID_PROTOCOL_NUMBER');
      return {...q,required:q.required??true,min,max:q.max??min+q.labels.length-1,min_label:q.min_label??q.labels[0],max_label:q.max_label??q.labels.at(-1)};
    })};});
  const layout=input.layout===undefined?{}:object(input.layout);
  if(layout.background!==undefined||layout.orientation!==undefined)throw new ContractError('AMBIGUOUS_LAYOUT');
  const p=parseProtocol({schema:'study-v1',title:input.title,mode:input.mode??'TEST_ONLY',pages:normalized,groups:compiled,
    variants:input.variants??[{id:'standard',weight:1,group_order:compiled.map(g=>id(g.id)),trial_order:Object.fromEntries(compiled.map(g=>[g.id,g.trials.map(t=>id(t.root_id))]))}],
    layout:{...base.layout,...layout,background:input.background??'#e5e5e5',orientation:input.orientation},budget:{...base.budget,...(input.budget===undefined?{}:object(input.budget))}});
  validateQuestionnaire(p,strict);return p;
}
export function questionnaireTemplate(){return {schema:'questionnaire-v1',title:'移动端模拟问卷',background:'#e5e5e5',orientation:'portrait',pages:[{id:'survey',instruction:'请选择最符合你的答案。',questions:[
  {id:'experience',type:'scale',title:'这次操作是否方便？',labels:['非常不方便','不方便','一般','方便','非常方便']},
  {id:'device',type:'single',title:'你正在使用哪种设备？',required:true,choices:['手机','平板','电脑']},
  {id:'nickname',type:'text',title:'模拟昵称（选填）',required:false,input_purpose:'personal',max_length:20}
]}]};}
type ExtendedNavigator=Navigator&{deviceMemory?:number;globalPrivacyControl?:boolean;connection?:{effectiveType?:string;type?:string;downlink?:number;downlinkMax?:number;rtt?:number;saveData?:boolean};
  userAgentData?:{brands:unknown;mobile:boolean;platform:string;getHighEntropyValues:(keys:string[])=>Promise<unknown>};getBattery?:()=>Promise<{charging:boolean;level:number;chargingTime:number;dischargingTime:number}>};
const bounded=async(fn:()=>Promise<unknown>,ms=250)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([fn().then(value=>({status:'available',value}),()=>({status:'blocked-or-error',value:null})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout',value:null}),ms);})]);}catch{return {status:'blocked-or-error',value:null};}finally{clearTimeout(timer);}};
const optional=(fn:(()=>Promise<unknown>)|undefined)=>fn?bounded(fn):Promise.resolve({status:'unsupported',value:null});
const finite=(v:number|undefined)=>v!==undefined&&Number.isFinite(v)?v:null;
function inference(ua:string){
  const browser=ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/);
  const os=ua.match(/(Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|CrOS|Linux)/);
  return {source:'user-agent-heuristic',browser:browser?`${({Edg:'Edge',OPR:'Opera',Version:'Safari'} as Record<string,string>)[browser[1]!]??browser[1]} ${browser[2]}`:'unknown',os:os?.[0]??'unknown',device:/Mobile|Android|iPhone|iPad/.test(ua)?'mobile-or-tablet':'desktop-or-unknown'};
}
export async function collectEnvironment(){
  const n=navigator as ExtendedNavigator,v=visualViewport,match=(q:string)=>matchMedia(q).matches;
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  let graphics:unknown={status:'unsupported',value:null};
  try{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl');if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');graphics={status:ext?'available':'masked',value:{vendor:gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL??gl.VENDOR),renderer:gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),version:gl.getParameter(gl.VERSION),shading_language:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),max_texture_size:gl.getParameter(gl.MAX_TEXTURE_SIZE)}};gl.getExtension('WEBGL_lose_context')?.loseContext();}}catch{graphics={status:'blocked-or-error',value:null};}
  const data={schema:'environment-v1',sampled_at:new Date().toISOString(),time_origin:performance.timeOrigin,sampled_performance_ms:performance.now(),
    user_agent:n.userAgent,user_agent_inferred:inference(n.userAgent),client_hints_low:n.userAgentData?{brands:n.userAgentData.brands,mobile:n.userAgentData.mobile,platform:n.userAgentData.platform}:null,
    platform:n.platform,vendor:n.vendor,app_version:n.appVersion,language:n.language,languages:[...n.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timezone_offset_minutes:new Date().getTimezoneOffset(),
    hardware:{logical_processors:n.hardwareConcurrency??null,device_memory_gb:n.deviceMemory??null,max_touch_points:n.maxTouchPoints},
    screen:{width:screen.width,height:screen.height,available_width:screen.availWidth,available_height:screen.availHeight,color_depth:screen.colorDepth,pixel_depth:screen.pixelDepth,orientation_type:screen.orientation?.type??null,orientation_angle:screen.orientation?.angle??null},
    viewport:{width:innerWidth,height:innerHeight,document_width:document.documentElement.clientWidth,document_height:document.documentElement.clientHeight,dpr:devicePixelRatio,visual:v?{width:v.width,height:v.height,offset_left:v.offsetLeft,offset_top:v.offsetTop,scale:v.scale}:null},
    preferences:Object.fromEntries(['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)','(prefers-contrast: more)','(prefers-contrast: less)','(forced-colors: active)','(pointer: coarse)','(pointer: fine)','(hover: hover)','(any-pointer: coarse)','(any-hover: hover)','(inverted-colors: inverted)','(display-mode: standalone)'].map(q=>[q,match(q)])),
    network:{online:n.onLine,connection:n.connection?{type:n.connection.type??null,effective_type:n.connection.effectiveType??null,downlink_mbps:finite(n.connection.downlink),downlink_max_mbps:finite(n.connection.downlinkMax),rtt_ms:finite(n.connection.rtt),save_data:n.connection.saveData??null}:null},
    security:{secure_context:isSecureContext,cross_origin_isolated:crossOriginIsolated,cookie_enabled:n.cookieEnabled,do_not_track:n.doNotTrack??null,global_privacy_control:n.globalPrivacyControl??null,visibility:document.visibilityState},
    capabilities:{indexed_db:!!window.indexedDB,locks:!!n.locks,crypto:!!crypto.subtle,canvas:!!window.HTMLCanvasElement,create_image_bitmap:!!window.createImageBitmap,visual_viewport:!!v,pointer_event:!!window.PointerEvent,offscreen_canvas:typeof OffscreenCanvas!=='undefined',service_worker:'serviceWorker' in n,webgl:(graphics as {status:string}).status},
    navigation:nav?{type:nav.type,redirect_count:nav.redirectCount,next_hop_protocol:nav.nextHopProtocol,dom_interactive_ms:nav.domInteractive,response_end_ms:nav.responseEnd,transfer_bytes:nav.transferSize}:null,
    referrer_origin:(()=>{try{return document.referrer?new URL(document.referrer).origin:null;}catch{return null;}})(),graphics};
  const [hints,storage,persisted,battery]=await Promise.all([
    optional(n.userAgentData?()=>n.userAgentData!.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']):undefined),
    optional(n.storage?.estimate?()=>n.storage.estimate():undefined),optional(n.storage?.persisted?()=>n.storage.persisted():undefined),
    optional(n.getBattery?async()=>{const b=await n.getBattery!();return {charging:b.charging,level:b.level,charging_time_seconds:finite(b.chargingTime),discharging_time_seconds:finite(b.dischargingTime)};}:undefined)
  ]);
  return {...data,client_hints_high:hints,storage_estimate:storage,storage_persisted:persisted,battery};
}
