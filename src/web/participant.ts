import './style.css';
import {el,button,uid} from './dom.js';
import {ParticipantAPI} from './participant-api.js';
import {cancelAdmission} from './session-gate.js';
import type {Answer} from '../shared/protocol.js';
const version=new URLSearchParams(location.search).get('version')??'';
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
const writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();sessionStorage.setItem(`lab-writer-${version}`,writer);let api:ParticipantAPI|null=null,owned=false,busy=false;
let admissionController:AbortController|undefined;
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){await api?.stopAdmission();status.textContent=error instanceof Error?error.message:'保存尚未完成，答案仍保留在本机。';content.replaceChildren(button(admissionController?.signal.aborted?'重新排队':'重试保存与核对',()=>action(restore)));}finally{busy=false;}}
async function restore(){if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;title.textContent=s.frozen.protocol.title;
  if(s.state==='COMPLETED'){await api.sync();status.textContent='研究已完成，数据已保存。';content.replaceChildren();return;}
  if(s.state==='TERMINATED'){status.textContent='此会话已终止，不能重新作答。正在补传已保存记录。';await api.reconcile();status.textContent='此会话已终止。已保存记录已补传核对，原始数据保留。';content.replaceChildren();return;}
  if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}
  if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){status.textContent='检测到未关闭的图片运行。恢复只能关闭未知运行并保留数据。';content.replaceChildren(button('确认旧运行已中断并终止',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
  admissionController=new AbortController();const controller=admissionController;
  status.textContent='正在等待参加名额…';content.replaceChildren(button('退出等待',()=>cancelAdmission(controller)));
  await api.enter(controller.signal,text=>status.textContent=text,error=>{controller.abort(error);status.textContent='参加名额暂不可用，已保存的记录保留。';content.replaceChildren(button('重新排队',()=>action(restore)));});
  await api.claim();const m=await api.ledger.state();for(const [scope,p]of Object.entries(m.pending))if(!p.seal)await api.seal(scope);
  await api.refresh();const page=api.session.frozen.protocol.pages[api.session.page_index];
  if(page){status.textContent=`${api.session.frozen.protocol.mode==='TEST_ONLY'?'测试数据 · ':''}第 ${api.session.page_index+1} 页`;const section=el('section'),mount=el('div');section.append(el('h2',page.title),el('p',page.instruction,'instruction'),mount);content.replaceChildren(section);
    const {mountPage}=await import('./survey-page.js');const local=(await api.ledger.state()).page_values[page.id]??{};
    mountPage(mount,page,api.session.answers,local,(name,answer,data)=>{try{api!.admission?.check();}catch{return;}void api!.ledger.append(page.id,'PAGE_REVISION',{question_id:name,answer},undefined,data).catch(error=>{status.textContent=`本地保存失败：${(error as Error).message}`;content.replaceChildren(button('重试核对',()=>action(restore)));});},data=>{void action(async()=>{api!.admission?.check();status.textContent='本页已提交，正在保存与封存…';content.replaceChildren();await api!.ledger.append(page.id,'PAGE_SNAPSHOT',{answers:data},[...api!.session.path,page.id]);await api!.seal(page.id);await restore();});});return;
  }
  if(api.session.group_index<api.session.frozen.protocol.groups.length){status.textContent='问卷已保存，接下来准备图片任务。';content.replaceChildren(button('准备图片任务',()=>{const base=import.meta.env.DEV?'/':`/runners/${api!.session.frozen.runner_hash}/`;location.href=`${base}run.html?version=${version}`;}));return;}
  await api.stopAdmission();await api.complete();status.textContent='研究已完成，数据已保存。';content.replaceChildren();
}
window.addEventListener('online',()=>{if(owned)void action(restore);});
window.addEventListener('pagehide',()=>{admissionController?.abort(new Error('页面已关闭。'));if(owned&&api?.session.state==='ACTIVE'&&api.session.permit?.state!=='ISSUED')void fetch(api.path('release'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:uid(),...api.fence()}),keepalive:true});});
if(!version||!navigator.locks||!crypto.subtle){status.textContent='参与链接或浏览器能力不完整，无法开始。';}
else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;await action(restore);if(lock)await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>{owned=false;api?.ledger.db.close();resolve();},{once:true}));});
