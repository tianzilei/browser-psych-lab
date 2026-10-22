import {taskLiveness} from './task-liveness.js';
import {recordInteractions} from './interaction-recorder.js';
import {el,button} from './dom.js';
import {RunReplay} from '../shared/run-replay.js';
import type {GroupPlan,RunRecord} from '../shared/lab-contract.js';
import type {ParticipantAPI} from './participant-api.js';
import {ui,participantError,errorDetails,interruptionMessage} from './participant-ui.js';
import {mountRatingQuestions,type RatingControls} from './rating-questions.js';
import {photoIdentity} from '../shared/photo-identity.js';
export {ratingControls} from './rating-questions.js';

export async function runRating(plan:GroupPlan,a:ParticipantAPI,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],panel:RatingControls,images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D,status:HTMLElement,geometry:()=>NonNullable<GroupPlan['geometry']>,release:()=>void,returnToPage:()=>void,content:HTMLElement){
  const replay=new RunReplay(plan),origin=performance.now(),now=()=>performance.now()-origin,rating=plan.rating!,legacy=!!rating.familiarity&&rating.familiarity.position!=='before-age';
  let index=0,phase:'waiting'|'answering'|'transitioning'|'isi'|'closing'='waiting',intentReady=false,submission:{values:number[];at:number}|null=null,frame=0,lastFrame=0,stopped=false,clearAt=0,answerSaved=false;
  const assets=new Map(a.session.frozen.assets.map(asset=>[asset.asset_id,asset])),photo=()=>photoIdentity(plan,index,assets);
  const instance=()=>`${plan.roots[index]!.root_id}:1`,persist=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:r}),emit=(r:RunRecord)=>{if(r.instance_id)Object.assign(r,photo());r.clock_origin=origin;replay.apply(r);return persist(r);};
  const blank=()=>{ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);canvas.style.visibility='hidden';};
  let recorder:ReturnType<typeof recordInteractions>;
  const questions=mountRatingQuestions(rating,panel,{
    record:r=>emit({...r,at:now(),instance_id:instance()}),
    familiarity:async value=>{const at=now();await emit({type:'RATING_FAMILIARITY',at,input_time:at,instance_id:instance(),value});if(legacy)await showPhoto(performance.now());},
    complete:values=>{submission={values,at:now()};},screen:()=>recorder?.screen(),fail:error=>{void stop(error);}
  });
  recorder=recordInteractions(document.querySelector('main')!,()=>({...photo(),...(phase==='answering'?questions.context():{phase}),stimulus_visible:canvas.style.visibility==='visible'}),batch=>a.ledger.interaction(batch),error=>{void stop(error);},a.session.frozen.protocol.record_interactions!==false);
  const stopLiveness=taskLiveness(a,reason=>{void stop(reason);});
  async function intent(){intentReady=false;await emit({type:'RATING_INTENT',at:now(),instance_id:instance()});if(!stopped)intentReady=true;}
  function remove(){stopLiveness();const saved=recorder.stop();questions.stop();document.body.classList.remove('running');window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',hidden);window.visualViewport?.removeEventListener('resize',visualChange);window.visualViewport?.removeEventListener('scroll',visualChange);return saved;}
  async function stop(error:unknown){if(stopped)return;stopped=true;cancelAnimationFrame(frame);blank();questions.hide();remove();await persist({type:'ABORT',at:now(),clock_origin:origin,reason:String(error).slice(0,150)}).catch(()=>{});const explanation=interruptionMessage(error);status.textContent=`${explanation}正在保存已有记录…`;try{await a.terminate('SOFTWARE_RUN_INTERRUPTED',{reason:String(error).slice(0,150)});await a.sync();status.textContent=`${explanation}已有记录已保存。`;}catch{status.textContent=`${explanation}保存尚未确认，请返回问卷重试保存。`;}release();document.body.classList.remove('runner-layout','rating-layout');const actions=el('div',undefined,'recovery-actions');actions.append(button(ui.returnSurvey,returnToPage,'primary'),errorDetails(error));content.replaceChildren(actions);}
  const change=()=>{if(questions.typing()&&document.visibilityState==='visible')return;if(document.visibilityState!=='visible'||JSON.stringify(geometry())!==JSON.stringify(plan.geometry))void stop('VISIBILITY_OR_GEOMETRY_CHANGED');},visualChange=()=>{if(!questions.typing())void stop('VISUAL_VIEWPORT_CHANGED');},hidden=()=>void stop('PAGE_HIDDEN_OR_CLOSED');
  window.addEventListener('resize',change);document.addEventListener('visibilitychange',change);window.addEventListener('pagehide',hidden);window.visualViewport?.addEventListener('resize',visualChange);window.visualViewport?.addEventListener('scroll',visualChange);
  async function showPhoto(raf:number){phase='transitioning';const root=plan.roots[index]!,image=images.get(root.asset_id!)!;if(!image)throw new Error('RATING_IMAGE_NOT_PREPARED');ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);const scale=Math.min(canvas.width/image.width,canvas.height/image.height),w=image.width*scale,h=image.height*scale;ctx.drawImage(image,(canvas.width-w)/2,(canvas.height-h)/2,w,h);canvas.style.visibility='visible';const at=now();await emit({type:'ONSET',at,draw_time:at,raf_time:raf-origin,instance_id:instance()});if(stopped)return;phase='answering';submission=null;status.textContent=`第 ${index+1}/${plan.roots.length} 张`;if(!legacy)questions.start();recorder.screen();}
  async function finish(){phase='closing';try{await remove();await emit({type:'CLOSING',at:now(),unresolved:false});replay.finish();await a.ledger.drain();await a.ledger.closeScope(plan.scope,[...a.session.path,plan.group_id]);status.textContent='作答已结束，正在确认剩余记录，请暂勿关闭页面。';await a.seal(plan.scope);await a.sync();release();returnToPage();}catch(error){if((await a.ledger.state()).pending[plan.scope]){release();document.body.classList.remove('runner-layout','rating-layout');status.textContent='本组已结束，保存尚未完成。';const actions=el('div',undefined,'recovery-actions');actions.append(button(ui.retrySave,async()=>{try{await a.seal(plan.scope);await a.sync();returnToPage();}catch(e){status.textContent=participantError(e);}},'primary'),errorDetails(error));content.replaceChildren(actions);}else await stop(error);}}
  function tick(raf:number){if(stopped||phase==='closing')return;const at=now();try{if(lastFrame&&at-lastFrame>plan.budget.long_frame_ms)throw new Error('LONG_FRAME');lastFrame=at;
    if(phase==='waiting'&&intentReady&&at>=plan.start){phase='answering';submission=null;if(legacy){status.textContent=`第 ${index+1}/${plan.roots.length} 张：熟悉度`;questions.start();}else void showPhoto(raf).catch(stop);}
    else if(phase==='answering'&&submission){blank();questions.hide();clearAt=now();const answer=submission;phase='isi';answerSaved=false;status.textContent=index+1<plan.roots.length?'请等待下一张。':'本张作答完成，请稍候。';recorder.screen();void emit({type:'RATING',at,draw_time:clearAt,raf_time:raf-origin,input_time:answer.at,instance_id:instance(),values:answer.values}).then(()=>{answerSaved=true;}).catch(stop);}
    else if(phase==='isi'&&answerSaved&&at>=clearAt+plan.roots[index]!.isi_ms){void emit({type:'END',at,instance_id:instance()}).catch(stop);index++;if(index===plan.roots.length){void finish();return;}phase='waiting';void intent().catch(stop);}
  }catch(error){void stop(error);return;}frame=requestAnimationFrame(tick);}
  document.body.classList.add('running');for(const b of buttons)b.disabled=true;questions.hide();blank();await intent();if(!stopped)frame=requestAnimationFrame(tick);
}
