全项目设计讨论，传输段 31，源码主题：本地账本与参加者生命周期（源包 11/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  acknowledge(receipts:Receipt[]){return this.serialized(async()=>{const tx=this.db.transaction(['events','outbox'],'readwrite',{durability:'strict'});try{for(const r of receipts){const e=await tx.objectStore('events').get(r.event_id);if(!e||e.hash!==r.hash||e.scope!==r.scope||r.custody!=='PERSISTED'||!r.receipt_id||!['ACCEPTED','RECEIVED_PENDING','QUARANTINED'].includes(r.disposition))throw new Error('CUSTODY_MISMATCH');e.receipt=r;await tx.objectStore('events').put(e);await tx.objectStore('outbox').delete(e.event_id);}await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}});}
  seal(scope:string,seal:Seal){return this.serialized(async()=>{const m=await this.state();const p=m.pending[scope];if(!p||seal.status!=='SEALED'||seal.algorithm!=='exact-set-and-chain-v1'||manifestText(seal.manifest)!==manifestText(p.manifest)||seal.manifest_hash!==await sha256(manifestText(p.manifest)))throw new Error('SEAL_MISMATCH');
    const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const latest=(await tx.store.get(this.version))!;latest.pending[scope]!.seal=seal;await tx.store.put(latest,this.version);await tx.done;});}
  async drain(){await this.chain;if(this.failure)throw this.failure;}
  interaction(batch:import('../shared/interaction.js').InteractionBatch){const scope=`d-ui-${this.clock}-${Math.floor(this.diagnosticCount++/4000)}`;return this.append(scope,'INPUT_DIAGNOSTIC',{interaction:batch});}
  termination(reason:string,evidence:unknown){return this.serialized(async()=>{const m=await this.state();m.termination??={request_id:crypto.randomUUID(),reason,evidence};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;return m.termination;});}
  reconciliation(scope:string,path:string[]){return this.serialized(async()=>{const m=await this.state(),head=m.heads[scope]!,key=`${scope}-${head.sequence}`;m.reconciliations??={};
    if(!m.reconciliations[key]){const events=(await this.db.getAllFromIndex('events','scope',scope)).filter(e=>e.session_id===m.session!.session_id).sort((a,b)=>a.sequence-b.sequence);m.reconciliations[key]={request_id:crypto.randomUUID(),manifest:{manifest_id:crypto.randomUUID(),scope,events:events.map(({event_id,hash})=>({event_id,hash})),path},unknown:m.pending[scope]?.seal?[]:['unfinished-or-unknown-position']};const tx=this.db.transaction('meta','readwrite',{durability:'strict'});await tx.store.put(m,this.version);await tx.done;}return m.reconciliations[key]!;});}
}

```

### src/web/participant-api.ts L1–L34

```
import {request} from './dom.js';
import {Ledger} from './ledger.js';
import type {LabSession} from '../shared/lab-contract.js';
import type {Receipt,Seal} from '../shared/contract.js';
import {awaitSessionAdmission} from './session-gate.js';
import {requireOrientation} from './orientation-gate.js';
import {sha256} from './local-store.js';
export class ParticipantAPI {
  admission:Awaited<ReturnType<typeof awaitSessionAdmission>>|null=null;
  constructor(readonly ledger:Ledger,public session:LabSession){}
  path(op=''){return `/api/participate/sessions/${this.session.session_id}${op?`/${op}`:''}`;}
  fence(){return {writer_id:this.ledger.writer,writer_epoch:this.session.writer_epoch};}
  async enter(signal:AbortSignal,status:(text:string)=>void,onLost:(error:unknown)=>void){await this.stopAdmission();this.admission=await awaitSessionAdmission(this,signal,status,onLost);}
  async stopAdmission(){const current=this.admission;this.admission=null;await current?.stop();}
  async refresh(){this.session=await request<LabSession>(this.path());await this.ledger.session(this.session);return this.session;}
  async claim(){this.session=await request<LabSession>(this.path('claim'),{request_id:crypto.randomUUID(),writer_id:this.ledger.writer});await this.ledger.session(this.session);}
  async syncEnvironment(){const environment=(await this.ledger.state()).environment;if(environment&&!environment.received){const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:environment.request_id,sample_id:environment.sample_id,raw:environment.raw});if(result.status!=='PERSISTED'||result.hash!==await sha256(environment.raw))throw new Error('环境记录接管凭证不匹配。');await this.ledger.environment();}}
  async sync(){await this.ledger.drain();await this.syncEnvironment();for(;;){const events=await this.ledger.batch();if(!events.length)break;const result=await request<{receipts:Receipt[]}>(this.path('ingest'),{batch_id:crypto.randomUUID(),events:events.map(({event_id,hash,raw})=>({event_id,hash,raw}))});
    if(result.receipts.length!==events.length||events.some(e=>!result.receipts.some(r=>r.event_id===e.event_id&&r.hash===e.hash)))throw new Error('接管凭证不匹配。');await this.ledger.acknowledge(result.receipts);}
  }
  async seal(scope:string){await this.sync();const state=await this.ledger.state(),pending=state.pending[scope]!;
    const seal=pending.seal??await request<Seal>(this.path('seal'),{request_id:pending.request_id,...this.fence(),manifest:pending.manifest});
    if(seal.status!=='SEALED')throw new Error('数据仍有未核对位置，不能继续。');await this.ledger.seal(scope,seal);await this.refresh();return seal;
  }
  async complete(){await this.sync();await this.refresh();const m=await this.ledger.state();const result=await request<{status:string}>(this.path('finalize'),{request_id:m.finalize_id,...this.fence(),seal_ids:this.session.seals.map(s=>s.seal_id)});if(result.status!=='COMPLETED')throw new Error('会话仍有未确认的位置。');await this.refresh();}
  async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
  async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){const report=await request<{status:string;cleanup_allowed:boolean}>(this.path('reconcile'),await this.ledger.reconciliation(scope,this.session.path));if(report.status!=='RECONCILED'||report.cleanup_allowed!==false)throw new Error('RECONCILIATION_MISMATCH');}}
  async reanswer(){await this.reconcile();const data=await this.ledger.reanswerRequest();const result=await request<LabSession>(this.path('reanswer'),data);await this.ledger.restart(result,data.credential);return result;}
  static async open(version:string,writer:string){await requireOrientation(version);const ledger=await Ledger.open(version,writer),m=await ledger.state();
    const {requireConsent}=await import('./consent-gate.js'),consent=await requireConsent(ledger);
    if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
    await requireOrientation(version);const initial=m.session?await request<LabSession>(`/api/participate/sessions/${m.session.session_id}/resume`,{credential:m.credential}):await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential,...(consent?{consent}:{})});const api=new ParticipantAPI(ledger,initial);await api.refresh();await api.syncEnvironment();return api;}
}

```

### src/web/participant.ts L1–L48

```
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