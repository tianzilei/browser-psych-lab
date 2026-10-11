import './participant.css';
import './compat.js';
import {applyParticipantBackground} from './participant-theme.js';
import {lockParticipantViewport} from './viewport.js';
import {el,button,uid} from './dom.js';
import {ParticipantAPI} from './participant-api.js';
import {cancelAdmission} from './session-gate.js';
import {mountEnding} from './ending-page.js';
import {recordInteractions} from './interaction-recorder.js';
import {downloadEstimate,downloadSize} from '../shared/download-estimate.js';
import type {Answer} from '../shared/protocol.js';
const version=new URLSearchParams(location.search).get('version')??'';
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
const writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();sessionStorage.setItem(`lab-writer-${version}`,writer);let api:ParticipantAPI|null=null,owned=false,busy=false;
let admissionController:AbortController|undefined;
let disposePage:(()=>void)|undefined;
let recorder:ReturnType<typeof recordInteractions>|undefined,question_id:string|undefined;
lockParticipantViewport();
function recovery(error:unknown){
  recorder?.stop();recorder=undefined;
  disposePage?.();disposePage=undefined;void api?.stopAdmission();
  status.textContent=error instanceof Error?error.message:'保存尚未完成，答案仍保留在本机。';
  const retry=button(admissionController?.signal.aborted?'稍后重试':'重试保存与核对',()=>action(restore));
  const back=button('返回当前题目',()=>action(restore));
  const actions=el('div',undefined,'recovery-actions');actions.append(retry,back);content.replaceChildren(actions);
}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;title.title=s.frozen.protocol.title;
  if(s.state==='COMPLETED'){await api.sync();status.textContent='研究已完成，数据已保存。';disposePage=mountEnding(content,s.frozen.protocol.ending);return;}
  if(s.state==='TERMINATED'){status.textContent='此会话已终止。正在补传已保存记录。';await api.reconcile();status.textContent='此会话已终止。已保存记录已补传核对，原始数据保留。或者删除此前答卷以重新回答。';const again=button('删除此前答卷以重新回答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}));content.replaceChildren(again,el('p','重新回答会创建新答卷，旧答卷保留并与新答卷关联。'));return;}
  if(!owned){status.textContent='此会话已在其他页面打开。此页只读。';content.replaceChildren();return;}
  if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){if(s.task_activity){status.textContent='任务已中断，正在核对并补传保存记录。';await api.terminate('UNKNOWN_RUN');await api.sync();await restore();return;}status.textContent='检测到未关闭的图片运行。恢复只能关闭未知运行并保留数据。';content.replaceChildren(button('确认旧运行已中断并终止',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
  admissionController=new AbortController();const controller=admissionController;
  status.textContent='正在检查作答名额…';content.replaceChildren(button('取消进入',()=>cancelAdmission(controller)));
  await api.enter(controller.signal,text=>status.textContent=text,error=>{controller.abort(error);disposePage?.();disposePage=undefined;status.textContent='作答名额暂不可用，建议30分钟后再进行答题。已保存的记录保留。';content.replaceChildren(button('稍后重试',()=>action(restore)));});
  await api.claim();recorder=recordInteractions(document.querySelector('main')!,()=>({page_id:api!.session.frozen.protocol.pages[api!.session.page_index]?.id,question_id}),batch=>api!.ledger.interaction(batch),recovery);const m=await api.ledger.state();for(const [scope,p]of Object.entries(m.pending))if(!p.seal)await api.seal(scope);
  await api.refresh();const page=api.session.frozen.protocol.pages[api.session.page_index];
  if(page){status.textContent=`${api.session.frozen.protocol.mode==='TEST_ONLY'?'测试数据 · ':''}第 ${api.session.page_index+1} 页`;const mount=el('div');mount.className='survey-mount';content.replaceChildren(mount);
    const {mountPage}=await import('./survey-page.js');const local=(await api.ledger.state()).page_values[page.id]??{};
    disposePage=mountPage(mount,page,api.session.answers,local,(name,answer,data)=>{try{api!.admission?.check();}catch{return;}void api!.ledger.append(page.id,'PAGE_REVISION',{question_id:name,answer},undefined,data).catch(error=>{disposePage?.();status.textContent=`本地保存失败：${(error as Error).message}`;content.replaceChildren(button('重试核对',()=>action(restore)));});},data=>{void action(async()=>{api!.admission?.check();recorder?.stop();recorder=undefined;disposePage?.();status.textContent='本页已提交，正在保存与封存…';content.replaceChildren();await api!.ledger.append(page.id,'PAGE_SNAPSHOT',{answers:data},[...api!.session.path,page.id]);await api!.seal(page.id);await restore();});},{key:`lab-step-${version}-${page.id}`,title:api.session.frozen.protocol.title,screen:id=>{question_id=id;recorder?.screen();}});return;
  }
  if(api.session.group_index<api.session.frozen.protocol.groups.length){const bytes=downloadEstimate(s.frozen,s.group_index);status.textContent=bytes?`本次测试预计下载约 ${downloadSize(bytes)} 数据。`:'接下来进行测试。';content.replaceChildren(button('点击下载测试',()=>{const base=import.meta.env.DEV?'/':`/runners/${api!.session.frozen.runner_hash}/`;location.href=`${base}run.html?version=${version}`;}));return;}
  recorder?.stop();recorder=undefined;await api.stopAdmission();await api.complete();status.textContent='研究已完成，数据已保存。';disposePage=mountEnding(content,api.session.frozen.protocol.ending);
}
window.addEventListener('online',()=>{if(owned)void action(restore);});
window.addEventListener('pagehide',()=>{recorder?.stop();admissionController?.abort(new Error('页面已关闭。'));if(owned&&api?.session.state==='ACTIVE'&&api.session.permit?.state!=='ISSUED')void fetch(api.path('release'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:uid(),...api.fence()}),keepalive:true});});
if(!version||!navigator.locks||!crypto.subtle){status.textContent=!navigator.locks?'当前浏览器无法保证单页面作答，请使用支持 Web Locks 的浏览器和 HTTPS 链接。':'参与链接或浏览器能力不完整，无法开始。';}
else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;await action(restore);if(lock)await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>{owned=false;api?.ledger.db.close();resolve();},{once:true}));});
