import './page-gestures.js';
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
import {loadRunner} from './runner-loading.js';
import type {Answer} from '../shared/protocol.js';
import {ui,participantError,errorDetails,errorCode,isConnectionFailure,showDuplicateTab} from './participant-ui.js';
const version=new URLSearchParams(location.search).get('version')??'';
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
const writer=sessionStorage.getItem(`lab-writer-${version}`)??uid();sessionStorage.setItem(`lab-writer-${version}`,writer);let api:ParticipantAPI|null=null,owned=false,busy=false;
let admissionController:AbortController|undefined;
let disposePage:(()=>void)|undefined;
let recorder:ReturnType<typeof recordInteractions>|undefined,question_id:string|undefined;
let waitingForRecovery=false,recoverOnOnline=false;
lockParticipantViewport();
function recovery(error:unknown){
  recorder?.stop();recorder=undefined;
  disposePage?.();disposePage=undefined;void api?.stopAdmission();
  waitingForRecovery=true;recoverOnOnline=isConnectionFailure(error);
  status.textContent=participantError(error,api?'save':'enter');
  const capacity=['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(errorCode(error));
  const retry=button(capacity?'稍后重试':!api||admissionController?.signal.aborted?'重新进入':ui.retrySave,()=>action(restore),'primary');
  const actions=el('div',undefined,'recovery-actions');actions.append(retry,errorDetails(error));content.replaceChildren(actions);
}
async function action(fn:()=>Promise<void>){if(busy)return;busy=true;try{await fn();}catch(error){recovery(error);}finally{busy=false;}}async function restore(){waitingForRecovery=false;recoverOnOnline=false;recorder?.stop();recorder=undefined;disposePage?.();disposePage=undefined;if(!owned){showDuplicateTab(status,content);return;}api??=await ParticipantAPI.open(version,writer);await api.stopAdmission();await api.refresh();const s=api.session;applyParticipantBackground(s.frozen.protocol.layout.background);title.textContent=s.frozen.protocol.title;
  if(s.state==='COMPLETED'){await api.sync();status.textContent=ui.completed;disposePage=mountEnding(content,s.frozen.protocol.ending);return;}
  if(s.state==='TERMINATED'){status.textContent='本次作答已中断，正在保存已有记录…';await api.reconcile();status.textContent='本次作答已中断，已有记录已保存。';const again=button('重新作答',()=>action(async()=>{await api!.reanswer();for(const key of Object.keys(sessionStorage))if(key.startsWith(`lab-step-${version}-`))sessionStorage.removeItem(key);location.reload();}),'primary');content.replaceChildren(again,el('p','重新作答将创建新答卷，原答卷及其关联记录会保留。','support-text'));return;}
  if(!owned){showDuplicateTab(status,content);return;}
  if(s.permit?.state==='ISSUED'&&!(await api.ledger.state()).pending[s.permit.scope]){if(s.task_activity){status.textContent='任务已中断，正在保存已有记录…';await api.terminate('UNKNOWN_RUN');await api.sync();await restore();return;}status.textContent='上次任务未正常结束，请先结束该任务并保存已有记录。';content.replaceChildren(button('结束中断的任务',()=>action(async()=>{await api!.terminate('UNKNOWN_RUN');await api!.sync();await restore();})));return;}
  admissionController=new AbortController();const controller=admissionController;
  status.textContent='正在准备问卷…';content.replaceChildren(button(ui.cancel,()=>{cancelAdmission(controller);location.assign('/');}));
  const adaptive=api.session.frozen.protocol.questionnaire_layout==='adaptive';
  const connectionLost=(error:unknown)=>{
    if(adaptive&&(isConnectionFailure(error)||['ADMISSION_EXPIRED','SESSION_CAPACITY_FULL','SESSION_WAITING'].includes(errorCode(error)))){
      status.textContent='连接暂时中断，答案继续保存在本机。';return;
    }
    controller.abort(error);recovery(error);
  };
  await api.enter(controller.signal,text=>status.textContent=text,connectionLost);
  await api.claim();recorder=recordInteractions(document.querySelector('main')!,()=>({page_id:api!.session.frozen.protocol.pages[api!.session.page_index]?.id,question_id}),batch=>api!.ledger.interaction(batch),recovery,api.session.frozen.protocol.record_interactions!==false);
  const m=await api.ledger.state();
  if(adaptive&&(api.session.page_index<api.session.frozen.protocol.pages.length||api.session.frozen.protocol.pages.some(page=>m.pending[page.id]&&!m.pending[page.id]!.seal))){
    const {mountAdaptiveSurvey}=await import('./adaptive-survey.js');
    disposePage=await mountAdaptiveSurvey(content,status,api,{
      error:recovery,screen:id=>{question_id=id;recorder?.screen();},
      reconnect:async()=>{await api!.enter(controller.signal,()=>{},connectionLost);await api!.claim();status.textContent=api!.session.frozen.protocol.mode==='TEST_ONLY'?'测试模式':'';},
      complete:async()=>{recorder?.stop();recorder=undefined;
        if(api!.session.frozen.protocol.groups.length===0){await api!.stopAdmission();await api!.complete();}
        await restore();
      }
    });return;
  }
  for(const [scope,p]of Object.entries(m.pending))if(!p.seal)await api.seal(scope);
  await api.refresh();const page=api.session.frozen.protocol.pages[api.session.page_index];
  if(page){status.textContent=[api.session.frozen.protocol.mode==='TEST_ONLY'?'测试模式':'',api.session.frozen.protocol.pages.length>1?`第 ${api.session.page_index+1}/${api.session.frozen.protocol.pages.length} 页`:''].filter(Boolean).join(' · ');const mount=el('div');mount.className='survey-mount';content.replaceChildren(mount);
    const {mountPage}=await import('./survey-page.js');const local=(await api.ledger.state()).page_values[page.id]??{};
    disposePage=mountPage(mount,page,api.session.answers,local,(name,answer,data)=>{try{api!.admission?.check();}catch(error){recovery(error);return;}void api!.ledger.append(page.id,'PAGE_REVISION',{question_id:name,answer},undefined,data).catch(recovery);},data=>{void action(async()=>{api!.admission?.check();recorder?.stop();recorder=undefined;disposePage?.();status.textContent=ui.saving;content.replaceChildren();await api!.ledger.append(page.id,'PAGE_SNAPSHOT',{answers:data},[...api!.session.path,page.id]);await api!.seal(page.id);await restore();});},{key:`lab-step-${version}-${page.id}`,title:api.session.frozen.protocol.title,screen:id=>{question_id=id;recorder?.screen();}});return;
  }
  if(api.session.group_index<api.session.frozen.protocol.groups.length){const bytes=downloadEstimate(s.frozen,s.group_index);status.textContent=bytes?`接下来进行任务，需下载约 ${downloadSize(bytes)}。`:'接下来进行任务。';content.replaceChildren(button(ui.startTask,()=>action(async()=>{try{await recorder?.stop();recorder=undefined;await loadRunner(api!,status,content);}catch(error){if(error instanceof DOMException&&error.name==='AbortError'){await restore();return;}throw error;}}),'primary'));return;}
  recorder?.stop();recorder=undefined;status.textContent=ui.saving;await api.stopAdmission();await api.complete();status.textContent=ui.completed;disposePage=mountEnding(content,api.session.frozen.protocol.ending);
}
window.addEventListener('online',()=>{if(owned&&waitingForRecovery&&recoverOnOnline)void action(restore);});
window.addEventListener('pagehide',()=>{recorder?.stop();admissionController?.abort(new Error('页面已关闭。'));if(owned&&api?.session.state==='ACTIVE'&&api.session.permit?.state!=='ISSUED')void fetch(api.path('release'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:uid(),...api.fence()}),keepalive:true});});
if(!version||!navigator.locks||!crypto.subtle){status.textContent=!navigator.locks?'当前浏览器无法保证单页面作答，请使用支持 Web Locks 的浏览器和 HTTPS 链接。':'参与链接或浏览器能力不完整，无法开始。';}
else void navigator.locks.request(`lab-version-${version}`,{ifAvailable:true},async lock=>{owned=!!lock;await action(restore);if(lock)await new Promise<void>(resolve=>window.addEventListener('pagehide',()=>{owned=false;api?.ledger.db.close();resolve();},{once:true}));});
