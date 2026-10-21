import './page-gestures.js';
import './style.css';
import './admin.css';
import {el,button,field,uid,request} from './dom.js';
import {RequestError} from './request-error.js';
import {compileQuestionnaire,parseQuestionnaireText,questionnaireTemplate,type ImageReference} from '../shared/questionnaire-json.js';
import type {Protocol} from '../shared/protocol.js';
import {mountStorageStatus} from './storage-status.js';
import {downloadName} from '../shared/download-name.js';
const app=document.querySelector<HTMLDivElement>('#app')!,message=document.querySelector<HTMLParagraphElement>('#message')!;
const storageRoot=document.querySelector<HTMLDivElement>('#storage-status')!;
let stopStorage:(()=>void)|undefined;
let csrf='',busy=false;
const api=<T>(url:string,data?:unknown)=>request<T>(url,data,csrf);
const errors:Record<string,string>={INVALID_QUESTIONNAIRE_JSON:'问卷 JSON 无法解析，请检查语法与编码。',PAGE_SNAPSHOT_BUDGET_EXCEEDED:'本段答案的最大字节数超过保存上限，请使用 adaptive 自动分段，或减少同段长文本题目。',QUESTIONNAIRE_SEGMENT_ID_TOO_LONG:'自动分段后的页面 id 超过 100 字符，请缩短原页面 id，为自动段号预留长度。',INVALID_QUESTIONNAIRE_LAYOUT:'questionnaire_layout 必须为 single 或 adaptive。',INVALID_RECORD_INTERACTIONS:'JSON 顶层 record_interactions 必须为 true 或 false（不能加引号）。',INVALID_LOGIN:'密码不正确，请重新输入。',PERSONAL_INPUT_ONLY:'只有个人信息题允许文字输入。',ORIENTATION_REQUIRED:'JSON 必须设置 orientation 为 portrait 或 landscape。',SCALE_LABELS_REQUIRED:'请为量表的每个刻度设置 labels 文本。',INVALID_SCALE_LABELS:'量表 labels 必须逐一对应所有刻度，首尾与两端文字一致。',IMAGE_PACKAGE_REFERENCE_MISSING:'JSON 引用的 ZIP 或图片路径不存在。',PACKAGE_NAME_EXISTS:'同名 ZIP 已存在；修改图片请换一个压缩包名称。',DRAFT_REVISION_CONFLICT:'问卷已被修改，请刷新列表后重试。未保存的名称仍保留在输入框中。',STUDY_ORDER_CONFLICT:'列表顺序或问卷数量已变化，请刷新列表后重新调整。',INVALID_STUDY_TITLE:'问卷名称需包含 1–200 个字符。',VERSION_REQUIRED:'请先上传有效 JSON 生成版本，再公开问卷。'};
const sessionStates:Record<string,string>={CREATED:'尚未作答',ACTIVE:'作答中',FINALIZING:'正在完成',COMPLETED:'已完成',TERMINATED:'已中断'};
function describe(error:unknown){const text=error instanceof Error?error.message:String(error),code=text.split('：')[0]!;if(code==='INVALID_LOGIN')return errors[code]!;if(error instanceof TypeError&&/fetch|network|load/i.test(text))return '暂时无法连接服务器，请检查网络后重试。';if(error instanceof Error&&error.name==='TimeoutError')return '服务器响应超时，请重试。';if(error instanceof RequestError&&error.status===401)return '登录已过期，请重新登录。';if(errors[code])return `${errors[code]} ${text}`;return error instanceof RequestError?`请求未完成，请检查配置或重试。错误详情：${text}`:text;}
async function action(fn:()=>Promise<void>,success='',feedback?:HTMLElement){if(busy)return;busy=true;app.setAttribute('aria-busy','true');const buttons=Array.from(app.querySelectorAll('button')).map(node=>({node,disabled:node.disabled}));for(const {node}of buttons)node.disabled=true;message.textContent='正在处理…';if(feedback)feedback.textContent='正在处理…';try{await fn();message.textContent=success;if(feedback)feedback.textContent=success;}catch(error){message.textContent=describe(error);if(feedback)feedback.textContent=describe(error);}finally{busy=false;app.removeAttribute('aria-busy');for(const {node,disabled}of buttons)node.disabled=disabled;}}
function download(title:string,content:unknown){const url=URL.createObjectURL(new Blob([typeof content==='string'?content:JSON.stringify(content,null,2)],{type:'application/json'})),link=el('a');link.href=url;link.download=downloadName(title,'json');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
type ExportFile='data.csv'|'answers.csv'|'ratings.csv'|'preparations.csv';
interface ExportJob {state:string;kind?:string;study_id?:string;result?:string}
interface ExportManifest {csv_hash?:string;files?:Partial<Record<ExportFile,unknown>>;answers_layout?:string;preparations_layout?:string;ratings_layout?:string;result_export_revision?:string}
async function exportData(study:Study,downloads:HTMLElement,file:ExportFile='data.csv'){
  const key=`lab-export-${study.study_id}`;let pending:{request_id:string;job_id:string;study_id:string;format?:'all'|'answers'}|undefined;
  try{pending=JSON.parse(sessionStorage.getItem(key)??'null')??undefined;}catch{sessionStorage.removeItem(key);}
  const job:ExportJob=pending?await api<ExportJob>(`/api/lab/jobs/${pending.job_id}`).catch(error=>{if(error instanceof RequestError&&error.code==='JOB_NOT_FOUND')return {state:'UNKNOWN'};throw error;}):{state:'NEW'};
  if(job.kind&&(job.kind!=='EXPORT'||job.study_id!==study.study_id))throw new Error('导出作业与当前问卷不匹配，请刷新后重试。');
  if(job.state==='FAILED')pending=undefined;
  if(job.state==='RECOVERY_REQUIRED')throw new Error('导出未完成，请通过维护流程核查作业后重新下载。');
  const hasFile=(manifest:ExportManifest,name:ExportFile)=>name==='data.csv'?!!manifest.csv_hash:(name==='ratings.csv'?manifest.ratings_layout==='one-photo-per-row-v2':manifest.answers_layout==='one-session-per-row-v1')&&!!manifest.files?.[name];
  if(job.state==='READY'&&(!hasFile(JSON.parse(job.result??'{}') as ExportManifest,file)||JSON.parse(job.result??'{}').result_export_revision!=='photo-identity-v2'))pending=undefined;
  const ready=job.state==='READY'&&pending!==undefined;
  const fresh=()=>({request_id:uid(),job_id:uid(),study_id:study.study_id,format:file==='answers.csv'?'answers' as const:'all' as const});
  pending??=fresh();sessionStorage.setItem(key,JSON.stringify(pending));
  let result=ready?JSON.parse(job.result??'{}') as ExportManifest:(await api<{result:ExportManifest}>('/api/lab/jobs/export',pending)).result;
  // A resumed job can finish a different format chosen before a page reload.
  if(!hasFile(result,file)){pending=fresh();sessionStorage.setItem(key,JSON.stringify(pending));result=(await api<{result:ExportManifest}>('/api/lab/jobs/export',pending)).result;}
  sessionStorage.removeItem(key);downloads.replaceChildren();
  const labels:Record<ExportFile,string>={'data.csv':'下载完整数据 CSV','answers.csv':hasFile(result,'ratings.csv')?'下载受试者信息 CSV':'下载问卷结果 CSV','ratings.csv':'下载问卷结果 CSV（每张照片一行）','preparations.csv':'下载设备与准备记录 CSV'};
  const links=new Map<ExportFile,HTMLAnchorElement>();
  for(const name of Object.keys(labels) as ExportFile[]){if(!hasFile(result,name))continue;const link=el('a',labels[name]);link.href=`/api/lab/jobs/${pending.job_id}/${name}`;link.download='';links.set(name,link);downloads.append(link);}
  const manifest=el('a','下载导出说明');manifest.href=`/api/lab/jobs/${pending.job_id}/manifest.json`;manifest.download='';downloads.append(manifest);links.get(file==='answers.csv'&&links.has('ratings.csv')?'ratings.csv':file)!.click();
}
function simulate(protocol:Protocol){const overlay=el('div',undefined,'simulation-overlay'),frame=el('iframe');frame.title='模拟问卷';frame.src='/simulate.html';frame.onload=()=>frame.contentWindow?.postMessage({type:'lab-simulation',protocol},location.origin);overlay.append(button('关闭模拟',()=>overlay.remove()),frame);document.body.append(overlay);}
function login(){
  stopStorage?.();stopStorage=undefined;storageRoot.hidden=true;
  app.replaceChildren();const section=el('section'),form=el('form'),password=field('密码','','password'),submit=el('button','登录');
  password.input.name='password';password.input.autocomplete='current-password';password.input.enterKeyHint='go';password.input.required=true;password.input.maxLength=256;password.input.autofocus=true;submit.type='submit';
  form.addEventListener('submit',event=>{event.preventDefault();if(busy)return;submit.disabled=true;
    void action(async()=>{const result=await api<{csrf:string}>('/api/auth/login',{password:password.input.value});csrf=result.csrf;await list();}).finally(()=>{submit.disabled=false;});
  });
  form.append(password.box,submit);section.append(el('h2','登录'),form);app.append(section);
}
interface Study {study_id:string;title:string;revision:number;admission:string;version_id:string|null;protocol_title?:string|null;replayable_sessions:number}
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
      const result=await response.json() as {code?:string;details?:unknown};if(!response.ok){if(result.code==='INVALID_IMAGE_PACKAGE')packageIds.delete(key);throw new RequestError(result.code??'ZIP_UPLOAD_FAILED',response.status,result.details);}
    }
    if(!importIds.has(source))importIds.set(source,uid());
    await api(`/api/lab/studies/${s.study_id}/import`,{request_id:importIds.get(source)!,revision:s.revision,source});await list();
  }));upload.disabled=true;
  json.input.onchange=()=>{preview.disabled=upload.disabled=true;protocol=undefined;source='';validation.textContent='';summary.textContent='';void(async()=>{try{const file=json.input.files?.[0];if(!file)return;if(file.size>512*1024)throw new Error('JSON 文件不能超过 512 KiB。');source=await file.text();const references=new Map<string,string>();protocol=compileQuestionnaire(parseQuestionnaireText(source),(ref:ImageReference)=>{const key=`${ref.package}/${ref.path}`;if(!references.has(key))references.set(key,`preview-image-${references.size}`);return references.get(key)!;});summary.textContent=`语法与内容校验通过 · ${protocol.pages.reduce((n,p)=>n+p.questions.length,0)} 题 · ${protocol.groups.length} 任务组 · ${protocol.layout.orientation==='portrait'?'竖屏':protocol.layout.orientation==='landscape'?'横屏':'方向自动适配'} · ${protocol.questionnaire_layout==='adaptive'?'自适应多题 / 自动保存':'逐题作答'} · 操作轨迹${protocol.record_interactions===false?'关闭':'开启'}`;validation.textContent=references.size?'图片路径将在上传时与 ZIP 核对。模拟前未上传的图片显示占位提示。':'';preview.disabled=upload.disabled=false;}catch(error){validation.textContent=describe(error);}})();};
  panel.append(el('h2',study?`修改：${study.title}`:'上传问卷'),json.box,zip.box,summary,validation,preview,upload,button('取消',()=>panel.remove(),'secondary'));app.prepend(panel);
}
function renameForm(study:Study,card:HTMLElement,feedback:HTMLElement){
  const old=card.querySelector<HTMLFormElement>('.rename-form');if(old){old.querySelector('input')?.focus();return;}
  const form=el('form',undefined,'rename-form'),name=field('问卷名称',study.title),submit=el('button','保存名称'),controls=el('div',undefined,'toolbar');
  name.input.required=true;name.input.maxLength=200;submit.type='submit';const requests=new Map<string,string>();
  form.addEventListener('submit',event=>{event.preventDefault();const title=name.input.value.trim();if(!title){name.input.setCustomValidity('请输入问卷名称。');name.input.reportValidity();return;}
    const key=`${study.revision}/${title}`;if(!requests.has(key))requests.set(key,uid());void action(async()=>{await api(`/api/lab/studies/${study.study_id}/rename`,{request_id:requests.get(key)!,revision:study.revision,title});await list();},'问卷名称已保存。',feedback);
  });
  name.input.addEventListener('input',()=>name.input.setCustomValidity(''));
  controls.append(submit,button('刷新问卷信息',()=>action(async()=>{const current=await api<Draft>(`/api/lab/studies/${study.study_id}`);study.revision=current.revision;study.title=current.title;},'已刷新问卷信息，输入中的名称已保留，可重新保存。',feedback),'secondary'),button('取消改名',()=>form.remove(),'secondary'));
  form.append(name.box,el('p','修改管理页和公开列表中的名称。作答页面标题和历史版本保持发布时的原名；修改作答内容请替换 JSON。','muted'),controls);card.querySelector('.study-heading')!.after(form);name.input.focus();
}
interface SessionSummary {session_id:string;state:string;created_at:number;recording_samples:number;recording_screens:number}
async function sessions(study:Study,panel:HTMLElement,offset=0){
  const result=await api<{sessions:SessionSummary[]}>(`/api/lab/studies/${study.study_id}/sessions?replayable=true&limit=100&offset=${offset}`);if(!offset)panel.replaceChildren(el('h4','答卷与回放'));
  panel.querySelector('.load-sessions')?.remove();
  if(!result.sessions.length&&!offset)panel.append(el('p','暂无可回放答卷，问卷结果仍可通过 CSV 导出。','muted'));
  for(const session of result.sessions){const row=el('div',undefined,'recording-row'),link=el('a',`${sessionStates[session.state]??session.state} · ${session.session_id.slice(0,8)} · ${new Date(session.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · 回放`,'session-link');link.title=session.session_id;link.href=`/replay.html?session=${session.session_id}`;link.target='_blank';link.rel='noopener';const download=el('a','下载本份轨迹 JSON.gz');download.href=`/api/lab/sessions/${session.session_id}/trajectory.json.gz`;download.download='';const html=el('a','下载离线回放 HTML');html.href=`/api/lab/sessions/${session.session_id}/replay.html`;html.download='';row.append(link,el('p',`${session.recording_samples.toLocaleString()} 条记录 · ${session.recording_screens.toLocaleString()} 个界面快照`,'muted'),download,document.createTextNode(' · '),html);panel.append(row);}
  if(result.sessions.length===100)panel.append(button('加载更多答卷',()=>action(()=>sessions(study,panel,offset+100)), 'secondary load-sessions'));
}
async function list(focusId?:string){
  const {studies}=await api<{studies:Study[]}>('/api/lab/studies');
  if(!stopStorage){storageRoot.hidden=false;stopStorage=mountStorageStatus(storageRoot,signal=>request('/api/lab/operations',undefined,csrf,signal));}
  app.replaceChildren();const nav=el('nav');
  nav.append(button('上传 JSON',()=>uploadForm()),button('下载 JSON 模板',()=>{const template=questionnaireTemplate();download(template.title,template);},'secondary'),button('刷新列表',()=>action(()=>list()),'secondary'),button('退出登录',()=>action(async()=>{await api('/api/auth/logout',{});login();}),'secondary'));app.append(nav,el('h2','问卷'),el('p','上移、下移会同时调整公开列表的顺序。隐藏后停止接收新答卷，已有答卷仍可继续。','muted'));
  if(!studies.length)app.append(el('p','上传 JSON 后可模拟、公开和分享问卷。'));
  const expected=studies.map(study=>study.study_id);
  for(const [index,s]of studies.entries()){
    const card=el('section',undefined,'study-card'),heading=el('div',undefined,'study-heading'),management=el('div',undefined,'study-controls'),exports=el('div',undefined,'study-controls'),downloads=el('div',undefined,'export-links'),sessionPanel=el('div',undefined,'session-panel'),feedback=el('p',undefined,'card-feedback');
    card.dataset.studyId=s.study_id;feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    const title=el('h3',s.title),status=el('span',s.admission==='OPEN'?'公开中':'已隐藏',`study-status ${s.admission==='OPEN'?'is-open':''}`);title.tabIndex=-1;heading.append(title,status);
    card.append(heading,el('p',`列表第 ${index+1} 位 · 修订 ${s.revision} · ${s.version_id?'已有发布版本':'待上传 JSON'}`,'muted'));
    if(s.protocol_title&&s.protocol_title!==s.title)card.append(el('p',`作答页面标题：${s.protocol_title}`,'muted'));
    const move=(direction:number)=>action(async()=>{const order=[...expected],target=index+direction;[order[index],order[target]]=[order[target]!,order[index]!];await api('/api/lab/studies/reorder',{request_id:uid(),expected_order:expected,order});await list(s.study_id);},'列表顺序已保存。',feedback);
    const up=button('上移',()=>move(-1),'secondary'),down=button('下移',()=>move(1),'secondary');up.disabled=index===0;down.disabled=index===studies.length-1;
    const visibility=button(s.admission==='OPEN'?'隐藏问卷':'公开问卷',()=>action(async()=>{await api(`/api/lab/studies/${s.study_id}/admission`,{request_id:uid(),paused:s.admission==='OPEN'});await list(s.study_id);},s.admission==='OPEN'?'问卷已隐藏。':'问卷已公开。',feedback));visibility.disabled=!s.version_id;
    management.append(button('修改名称',()=>renameForm(s,card,feedback),'secondary'),up,down,visibility);
    exports.append(button('导出问卷结果',()=>action(()=>exportData(s,downloads,'answers.csv'),'结果快照已生成，可从下方链接再次下载。',feedback)),button('下载数据',()=>action(()=>exportData(s,downloads),'完整数据快照已生成。',feedback),'secondary'),...(s.replayable_sessions>0?[button(`查看答卷与回放（${s.replayable_sessions}）`,()=>action(()=>sessions(s,sessionPanel),'',feedback),'secondary')]:[]));
    const details=el('details'),advanced=el('div',undefined,'toolbar');details.append(el('summary','问卷文件与模拟'));
    advanced.append(button('修改 JSON',()=>uploadForm(s),'secondary'),button('下载 JSON',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);download(d.title,d.source??JSON.stringify(d.draft,null,2));}),'secondary'),button('模拟问卷',()=>action(async()=>{const d=await api<Draft>(`/api/lab/studies/${s.study_id}`);simulate(d.draft);}),'secondary'));
    details.append(advanced);
    if(s.version_id){const link=el('a','参与链接');link.href=`/participate.html?version=${s.version_id}`;link.target='_blank';link.rel='noopener';card.append(link);}
    card.append(management,exports,el('p','照片评分任务的问卷结果按每位受试者对每张照片一行导出，标注照片编号、文件名和类别，包含五项印象、熟悉度和年龄；受试者信息另表提供。普通问卷每份答卷一行。时间使用北京时间（UTC+8）。完整数据含原始证据、协变量和同意记录。','muted'),feedback,downloads,sessionPanel,details);app.append(card);
    if(s.study_id===focusId)title.focus({preventScroll:true});
  }
}
void action(async()=>{try{const me=await api<{csrf:string}>('/api/auth/me');csrf=me.csrf;await list();}catch{login();}});
