全项目设计讨论，传输段 38，源码主题：页面交互和管理（源包 13/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/web/admin.css L1–L4

```
.simulation-overlay { position: fixed; inset: 0; z-index: 10; background: #202020; display: grid; grid-template-rows: 48px minmax(0,1fr); padding: 8px; gap: 8px; }
.simulation-overlay > button { justify-self: end; }
.simulation-overlay iframe { width: 100%; height: 100%; min-height: 0; border: 0; }

```

### src/web/admin.html L1–L3

```
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>研究管理 · Browser Psych Lab</title></head>
<body><main class="wide"><header><a class="eyebrow" href="/">BROWSER PSYCH LAB</a><h1>研究管理</h1><p id="message" role="status" aria-live="polite"></p></header><div id="app"></div></main><script type="module" src="/admin.ts"></script></body></html>

```

### src/web/admin.ts L1–L67

```
import './style.css';
import './admin.css';
import {el,button,field,uid,request} from './dom.js';
import {compileQuestionnaire,parseQuestionnaireText,questionnaireTemplate,type ImageReference} from '../shared/questionnaire-json.js';
import type {Protocol} from '../shared/protocol.js';
const app=document.querySelector<HTMLDivElement>('#app')!,message=document.querySelector<HTMLParagraphElement>('#message')!;
let csrf='',busy=false;
const api=<T>(url:string,data?:unknown)=>request<T>(url,data,csrf);
const errors:Record<string,string>={INVALID_LOGIN:'密码不正确，请重新输入。',PERSONAL_INPUT_ONLY:'只有个人信息题允许文字输入。',ORIENTATION_REQUIRED:'JSON 必须设置 orientation 为 portrait 或 landscape。',SCALE_LABELS_REQUIRED:'请为量表的每个刻度设置 labels 文本。',INVALID_SCALE_LABELS:'量表 labels 必须逐一对应所有刻度，首尾与两端文字一致。',IMAGE_PACKAGE_REFERENCE_MISSING:'JSON 引用的 ZIP 或图片路径不存在。',PACKAGE_NAME_EXISTS:'同名 ZIP 已存在；修改图片请换一个压缩包名称。',DRAFT_REVISION_CONFLICT:'问卷已被修改，请刷新后重新上传。'};
function describe(error:unknown){const text=error instanceof Error?error.message:String(error),code=text.split('：')[0]!;if(code==='INVALID_LOGIN')return errors[code]!;return errors[code]?`${errors[code]} ${text}`:text;}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;message.textContent='正在处理…';try{await fn();message.textContent='';}catch(error){message.textContent=describe(error);}finally{busy=false;}}
function download(name:string,content:unknown){const url=URL.createObjectURL(new Blob([typeof content==='string'?content:JSON.stringify(content,null,2)],{type:'application/json'})),link=el('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportData(study:Study,downloads:HTMLElement){
  const key=`lab-export-${study.study_id}`;let pending:{request_id:string;job_id:string;study_id:string}|undefined;
  try{pending=JSON.parse(sessionStorage.getItem(key)??'null')??undefined;}catch{sessionStorage.removeItem(key);}
  const job=pending?await api<{state:string;kind?:string;study_id?:string}>(`/api/lab/jobs/${pending.job_id}`).catch(error=>{if(error instanceof Error&&error.message==='JOB_NOT_FOUND')return {state:'UNKNOWN'};throw error;}):{state:'NEW'};
  if(job.state==='FAILED')pending=undefined;
  if(job.state==='RECOVERY_REQUIRED')throw new Error('导出未完成，请通过维护流程核查作业后重新下载。');
  pending??={request_id:uid(),job_id:uid(),study_id:study.study_id};sessionStorage.setItem(key,JSON.stringify(pending));
  if(job.state!=='READY')await api('/api/lab/jobs/export',pending);
  sessionStorage.removeItem(key);downloads.replaceChildren();
  const csv=el('a','下载 CSV'),manifest=el('a','下载导出说明');csv.href=`/api/lab/jobs/${pending.job_id}/data.csv`;manifest.href=`/api/lab/jobs/${pending.job_id}/manifest.json`;csv.download='data.csv';manifest.download='manifest.json';downloads.append(csv,manifest);csv.click();
}
function simulate(protocol:Protocol){const overlay=el('div',undefined,'simulation-overlay'),frame=el('iframe');frame.title='模拟问卷';frame.src='/simulate.html';frame.onload=()=>frame.contentWindow?.postMessage({type:'lab-simulation',protocol},location.origin);overlay.append(button('关闭模拟',()=>overlay.remove()),frame);document.body.append(overlay);}
function login(){
  app.replaceChildren();const section=el('section'),form=el('form'),password=field('密码','','password'),submit=el('button','登录');
  password.input.name='password';password.input.autocomplete='current-password';password.input.enterKeyHint='go';password.input.required=true;password.input.maxLength=256;password.input.autofocus=true;submit.type='submit';
  form.addEventListener('submit',event=>{event.preventDefault();if(busy)return;submit.disabled=true;
    void action(async()=>{const result=await api<{csrf:string}>('/api/auth/login',{password:password.input.value});csrf=result.csrf;await list();}).finally(()=>{submit.disabled=false;});
  });
  form.append(password.box,submit);section.append(el('h2','登录'),form);app.append(section);
}
interface Study {study_id:string;title:string;revision:number;admission:string;version_id:string|null}
interface Draft extends Study {draft:Protocol;source:string|null}
function fileField(label:string,accept:string){const box=el('label'),input=el('input');input.type='file';input.accept=accept;box.append(el('span',label),input);return {box,input};}
async function uploadForm(study?:Study){
  const panel=el('section'),json=fileField('问卷 JSON','.json,application/json'),zip=fileField('图片 ZIP（可选，可多选）','.zip,application/zip'),summary=el('p'),validation=el('p');zip.input.multiple=true;validation.setAttribute('role','alert');
  let source='',protocol:Protocol|undefined,targetStudy=study;const createId=uid(),packageIds=new Map<string,string>(),importIds=new Map<string,string>();
  const preview=button('生成模拟问卷',()=>{if(protocol)simulate(protocol);});preview.disabled=true;
  const upload=button(study?'替换 JSON 并生成新版本':'上传并生成版本',()=>action(async()=>{
    if(!protocol||!source)throw new Error('请先选择并校验 JSON。');
    const s=targetStudy??await api<Study>('/api/lab/studies',{request_id:createId});targetStudy=s;
    // ZIP files are uploaded before resolving references. Existing packages stay immutable.
    for(const file of Array.from(zip.input.files??[])){
      if(file.size>8*1024*1024)throw new Error('每个 ZIP 不能超过 8 MiB。');
      const bytes=await file.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''),key=`${file.name}/${hash}`;
      if(!packageIds.has(key))packageIds.set(key,uid());
      const response=await fetch(`/api/lab/studies/${s.study_id}/package`,{method:'POST',headers:{'Content-Type':'application/zip','X-CSRF-Token':csrf,'X-Request-Id':packageIds.get(key)!,'X-File-Name':encodeURIComponent(file.name)},body:bytes});
      const result=await response.json() as {code?:string;details?:unknown};if(!response.ok){if(result.code==='INVALID_IMAGE_PACKAGE')packageIds.delete(key);throw new Error(`${result.code??'ZIP_UPLOAD_FAILED'}${result.details?`：${JSON.stringify(result.details)}`:''}`);}
    }
    if(!importIds.has(source))importIds.set(source,uid());
    await api(`/api/lab/studies/${s.study_id}/import`,{request_id:importIds.get(source)!,revision:s.revision,source});await list();
  }));upload.disabled=true;
  json.input.onchange=()=>{preview.disabled=upload.disabled=true;protocol=undefined;source='';validation.textContent='';summary.textContent='';void(async()=>{try{const file=json.input.files?.[0];if(!file)return;if(file.size>512*1024)throw new Error('JSON 文件不能超过 512 KiB。');source=await file.text();const references=new Map<string,string>();protocol=compileQuestionnaire(parseQuestionnaireText(source),(ref:ImageReference)=>{const key=`${ref.package}/${ref.path}`;if(!references.has(key))references.set(key,`preview-image-${references.size}`);return references.get(key)!;});summary.textContent=`语法与内容校验通过 · ${protocol.pages.reduce((n,p)=>n+p.questions.length,0)} 题 · ${protocol.groups.length} 图片组 · ${protocol.layout.orientation==='portrait'?'竖屏':'横屏'}`;validation.textContent=references.size?'图片路径将在上传时与 ZIP 核对。模拟前未上传的图片显示占位提示。':'';preview.disabled=upload.disabled=false;}catch(error){validation.textContent=describe(error);}})();};
  panel.append(el('h2',study?`修改：${study.title}`:'上传问卷'),json.box,zip.box,summary,validation,preview,upload,button('取消',()=>panel.remove(),'secondary'));app.prepend(panel);
}
async function list(){const {studies}=await api<{studies:Study[]}>('/api/lab/studies');app.replaceChildren();const nav=el('nav');nav.append(button('上传 JSON',()=>uploadForm()),button('下载 JSON 模板',()=>download('questionnaire.json',questionnaireTemplate())),button('退出',()=>action(async()=>{await api('/api/auth/logout',{});login();})));app.append(nav,el('h2','问卷'));
  if(!studies.length)app.append(el('p','上传 JSON 后可模拟、开放和分享问卷。'));
  for(const s of studies){const card=el('section'),controls=el('div',undefined,'toolbar'),downloads=el('div',undefined,'toolbar');card.append(el('h3',s.title),el('p',`版本修订 ${s.revision} · ${s.admission==='OPEN'?'开放':'隐藏'}`));
    controls.append(button('修改 JSON',()=>uploadForm(s)),button('下载 JSON',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);download('questionnaire.json',d.source??JSON.stringify(d.draft,null,2));})),button('模拟问卷',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);simulate(d.draft);})),button(s.admission==='OPEN'?'隐藏':'开放',()=>action(async()=>{if(!s.version_id)throw new Error('请先上传有效 JSON 生成版本。');await api(`/api/lab/studies/${s.study_id}/admission`,{request_id:uid(),paused:s.admission==='OPEN'});await list();})),button('删除',()=>action(async()=>{await api(`/api/lab/studies/${s.study_id}/delete`,{request_id:uid()});await list();}),'secondary'));
    controls.append(button('下载数据',()=>action(()=>exportData(s,downloads))));
    controls.append(button('查看答卷与回放',()=>action(async()=>{const result=await api<{sessions:{session_id:string;state:string}[]}>(`/api/lab/studies/${s.study_id}/sessions?limit=100`);downloads.replaceChildren();for(const session of result.sessions){const link=el('a',`${session.state} · ${session.session_id.slice(0,8)} · 回放`);link.href=`/replay.html?session=${session.session_id}`;link.target='_blank';link.rel='noopener';downloads.append(link);}})));
    if(s.version_id){const link=el('a','参与链接');link.href=`/participate.html?version=${s.version_id}`;link.target='_blank';link.rel='noopener';controls.append(link);}card.append(controls,downloads);app.append(card);
  }
}
void action(async()=>{try{const me=await api<{csrf:string}>('/api/auth/me');csrf=me.csrf;await list();}catch{login();}});

```

### src/web/compat.ts L1–L30

```
// Compatibility layer for local HTTP testing on iOS browsers. Production HTTPS
// deployments continue to use the native Web Crypto and Web Locks APIs.
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sha256(data: ArrayBuffer): ArrayBuffer {
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const input=new Uint8Array(data), bit=input.length*8, len=((input.length+9+63)>>6)<<6, bytes=new Uint8Array(len);bytes.set(input);bytes[input.length]=128;
  const view=new DataView(bytes.buffer);view.setUint32(len-4,bit>>>0);view.setUint32(len-8,Math.floor(bit/0x100000000));
  let a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  const ro=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for(let off=0;off<len;off+=64){const w=new Uint32Array(64);for(let i=0;i<16;i++)w[i]=view.getUint32(off+i*4);for(let i=16;i<64;i++){const s0=ro(w[i-15]!,7)^ro(w[i-15]!,18)^(w[i-15]!>>>3),s1=ro(w[i-2]!,17)^ro(w[i-2]!,19)^(w[i-2]!>>>10);w[i]=(w[i-16]!+s0+w[i-7]!+s1)>>>0;}let A=a,B=b,C=c,D=d,E=e,F=f,G=g,H=h;for(let i=0;i<64;i++){const S1=ro(E,6)^ro(E,11)^ro(E,25),ch=(E&F)^(~E&G),t1=(H+S1+ch+k[i]!+w[i]!)>>>0,S0=ro(A,2)^ro(A,13)^ro(A,22),maj=(A&B)^(A&C)^(B&C),t2=(S0+maj)>>>0;H=G;G=F;F=E;E=(D+t1)>>>0;D=C;C=B;B=A;A=(t1+t2)>>>0;}a=(a+A)>>>0;b=(b+B)>>>0;c=(c+C)>>>0;d=(d+D)>>>0;e=(e+E)>>>0;f=(f+F)>>>0;g=(g+G)>>>0;h=(h+H)>>>0;}
  const out=new ArrayBuffer(32),o=new DataView(out);[a,b,c,d,e,f,g,h].forEach((v,i)=>o.setUint32(i*4,v));return out;
}
if (!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:uuid, configurable:true});
if (!crypto.subtle) {
  const digest = async (_algorithm: string, data: BufferSource) => {
    const name = typeof _algorithm === 'string' ? _algorithm : (_algorithm as Algorithm).name;
    if (name.toUpperCase() !== 'SHA-256') throw new DOMException('Only SHA-256 is supported.', 'NotSupportedError');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return sha256(bytes.slice().buffer);
  };
  Object.defineProperty(crypto, 'subtle', { value: { digest }, configurable: true });
}
// Web Locks cannot be emulated by granting every caller a lock. The participant
// entry points require the native API; LAN testing must use the HTTPS preview.

```

### src/web/consent-page.ts L1–L27

```
import type {Protocol} from '../shared/protocol.js';
import {el,button} from './dom.js';
import {TextPager} from './text-pager.js';
