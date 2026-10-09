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
    if(s.version_id){const link=el('a','参与链接');link.href=`/participate.html?version=${s.version_id}`;link.target='_blank';link.rel='noopener';controls.append(link);}card.append(controls,downloads);app.append(card);
  }
}
void action(async()=>{try{const me=await api<{csrf:string}>('/api/auth/me');csrf=me.csrf;await list();}catch{login();}});
