请中文审查实际代码，指出真实功能错误和最小补丁，结束 JSON_ORIENTATION_CODE_REVIEW_COMPLETE。需求：固定零滚动问卷，方向符合后才createSession/下载图片，软键盘不能误判方向。metadata失败允许retry。Ledger.environment记录每version一次采样 durable pending，API.sync后hash核对，原始answers另外独立outbox。iframe模拟JSON只postMessage原origin校验parent，绝不建真实session。旧无orientation冻结版本兼容。图片run resize就立即terminate，这是已有设计不改时间语义。重点方向逻辑、metadata失败缓存、Promise错误/模拟旋转处理；随后审查其他部分。
import {request,el} from './dom.js';
import {applyParticipantBackground} from './participant-theme.js';
type Orientation='portrait'|'landscape';
let last:Orientation|undefined,lastWidth=0;
export function currentOrientation():Orientation {
  const width=document.documentElement.clientWidth||innerWidth,height=document.documentElement.clientHeight||innerHeight;
  const typing=document.activeElement instanceof HTMLInputElement&&document.activeElement.type!=='range'||document.activeElement instanceof HTMLTextAreaElement;
  // A keyboard can shrink the layout viewport. Preserve orientation while its width is unchanged.
  if(typing&&last&&Math.abs(width-lastWidth)<2)return last;
  lastWidth=width;return last=width>height?'landscape':'portrait';
}
let gate:Promise<void>|undefined;
export function requireOrientation(version:string){return gate??=initialize(version);}
async function initialize(version:string){
  const meta=await request<{title:string;background:string;orientation:Orientation|null}>(`/api/participate/versions/${version}/metadata`);
  applyParticipantBackground(meta.background);
  if(!meta.orientation)return; // Historical frozen protocols keep their original behavior.
  const overlay=el('div',undefined,'orientation-gate');overlay.id='orientation-gate';overlay.setAttribute('role','alert');
  const icon=el('div',undefined,'orientation-device');icon.dataset.orientation=meta.orientation;icon.setAttribute('aria-hidden','true');
  overlay.append(icon,el('p',meta.orientation==='portrait'?'请将设备调整为竖屏':'请将设备调整为横屏'),el('span','方向正确后自动继续'));
  document.body.append(overlay);const main=document.querySelector('main');
  await new Promise<void>(resolve=>{
    const check=()=>{const valid=currentOrientation()===meta.orientation;overlay.hidden=valid;if(main)main.inert=!valid;if(valid)resolve();};
    window.addEventListener('resize',check);window.addEventListener('orientationchange',check);screen.orientation?.addEventListener('change',check);
    window.addEventListener('pagehide',()=>{window.removeEventListener('resize',check);window.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);},{once:true});check();
  });
}
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
  async sync(){await this.ledger.drain();const environment=(await this.ledger.state()).environment;if(environment&&!environment.received){const result=await request<{hash:string;status:string}>(this.path('covariates'),{request_id:environment.request_id,sample_id:environment.sample_id,raw:environment.raw});if(result.status!=='PERSISTED'||result.hash!==await sha256(environment.raw))throw new Error('环境记录接管凭证不匹配。');await this.ledger.environment();}for(;;){const events=await this.ledger.batch();if(!events.length)break;const result=await request<{receipts:Receipt[]}>(this.path('ingest'),{batch_id:crypto.randomUUID(),events:events.map(({event_id,hash,raw})=>({event_id,hash,raw}))});
    if(result.receipts.length!==events.length||events.some(e=>!result.receipts.some(r=>r.event_id===e.event_id&&r.hash===e.hash)))throw new Error('接管凭证不匹配。');await this.ledger.acknowledge(result.receipts);}
  }
  async seal(scope:string){await this.sync();const state=await this.ledger.state(),pending=state.pending[scope]!;
    const seal=pending.seal??await request<Seal>(this.path('seal'),{request_id:pending.request_id,...this.fence(),manifest:pending.manifest});
    if(seal.status!=='SEALED')throw new Error('数据仍有未核对位置，不能继续。');await this.ledger.seal(scope,seal);await this.refresh();return seal;
  }
  async complete(){await this.sync();await this.refresh();const m=await this.ledger.state();const result=await request<{status:string}>(this.path('finalize'),{request_id:m.finalize_id,...this.fence(),seal_ids:this.session.seals.map(s=>s.seal_id)});if(result.status!=='COMPLETED')throw new Error('会话仍有未确认的位置。');await this.refresh();}
  async terminate(reason:string,evidence:unknown={}){return request<LabSession>(this.path('terminate'),await this.ledger.termination(reason,evidence));}
  async reconcile(){await this.sync();const m=await this.ledger.state();for(const scope of Object.keys(m.heads)){const report=await request<{status:string;cleanup_allowed:boolean}>(this.path('reconcile'),await this.ledger.reconciliation(scope,this.session.path));if(report.status!=='RECONCILED'||report.cleanup_allowed!==false)throw new Error('RECONCILIATION_MISMATCH');}}
  static async open(version:string,writer:string){const orientation=requireOrientation(version),ledger=await Ledger.open(version,writer),m=await ledger.state();
    if(!m.environment){const {collectEnvironment}=await import('./environment.js');await ledger.environment(JSON.stringify(await collectEnvironment()));}
    await orientation;const initial=await request<LabSession>('/api/participate/sessions',{request_id:m.request_id,version_id:version,credential:m.credential});const api=new ParticipantAPI(ledger,initial);await api.refresh();return api;}
}
import './participant.css';
import {lockParticipantViewport} from './viewport.js';
import {applyParticipantBackground} from './participant-theme.js';
import {currentOrientation} from './orientation-gate.js';
import {mountPage} from './survey-page.js';
import {parseProtocol,evaluate,type Protocol,type Answer} from '../shared/protocol.js';
import {el,button} from './dom.js';
lockParticipantViewport();
const title=document.querySelector<HTMLHeadingElement>('#title')!,status=document.querySelector<HTMLParagraphElement>('#status')!,content=document.querySelector<HTMLDivElement>('#content')!;
let p:Protocol|undefined,index=0,answers:Record<string,Answer>={},values:Record<string,Record<string,Answer>>={},dispose:(()=>void)|undefined;
function render(){if(!p)return;dispose?.();applyParticipantBackground(p.layout.background);title.textContent=p.title;status.textContent='模拟问卷 · 不提交数据';
  if(p.layout.orientation&&currentOrientation()!==p.layout.orientation){content.replaceChildren(el('p',p.layout.orientation==='portrait'?'请将设备调整为竖屏':'请将设备调整为横屏'));return;}
  while(p.pages[index]&&!evaluate(p.pages[index]!.condition,answers))index++;
  const page=p.pages[index];if(page){const mount=el('div',undefined,'survey-mount');content.replaceChildren(mount);dispose=mountPage(mount,page,answers,values[page.id]??{},(_name,_answer,data)=>{values[page.id]=data;},data=>{Object.assign(answers,data);index++;render();},{key:`simulation-${crypto.randomUUID()}`,title:p.title});return;}
  content.replaceChildren();for(const group of p.groups){const section=el('div');section.append(el('p',group.title));
    const trial=group.trials[0];if(trial&&!trial.asset_id.startsWith('preview-image-')){const image=el('img');image.src=`/api/lab/assets/${trial.asset_id}`;image.alt='模拟图片';image.style.cssText='width:100%;max-height:45dvh;object-fit:contain';section.append(image);}else section.append(el('p','上传 ZIP 后可查看图片。'));
    for(const choice of group.choices)section.append(button(choice,()=>{status.textContent=`模拟选择：${choice}`;}));content.append(section);
    break;
  }content.append(button('重新模拟',()=>{index=0;answers={};values={};render();}));if(!p.groups.length)status.textContent='模拟完成 · 不提交数据';
}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='lab-simulation')return;try{p=parseProtocol(event.data.protocol);index=0;answers={};values={};render();}catch{status.textContent='模拟 JSON 无效。';}});
window.addEventListener('resize',()=>{if(p&&!document.querySelector('.questionnaire'))render();});
