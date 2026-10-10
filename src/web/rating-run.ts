import {el,button} from './dom.js';
import {RunReplay} from '../shared/run-replay.js';
import type {GroupPlan,RunRecord} from '../shared/lab-contract.js';
import type {ParticipantAPI} from './participant-api.js';
export function ratingControls(prompts:string[],labels:string[],buttons:HTMLButtonElement[],footer:HTMLElement,agePrompt?:string){
  const controls=el('div',undefined,'rating-controls'),choices=el('div',undefined,'response-buttons'),ends=el('div',undefined,'axis-ends');
  const heading=el('p',prompts[0]);heading.id='rating-prompt';choices.setAttribute('role','group');choices.setAttribute('aria-labelledby',heading.id);
  choices.style.setProperty('--response-columns','4');
  for(const [i,b] of buttons.entries()){b.setAttribute('aria-label',`评分 ${i+1}：${labels[i]}`);b.setAttribute('aria-pressed','false');}
  choices.append(...buttons);ends.append(el('span',`1 · ${labels[0]}`),el('span',`${labels.length} · ${labels.at(-1)}`));controls.append(heading,choices,ends);
  const age=agePrompt?document.createElement('input'):null;if(age){const prompt=agePrompt!;age.type='number';age.min='0';age.max='120';age.step='1';age.placeholder=prompt;age.setAttribute('aria-label',prompt);age.hidden=true;age.className='rating-age';controls.append(age);}
  const submit=button(prompts.length>1?'下一题':'提交评分',()=>{});submit.hidden=true;submit.disabled=true;footer.append(submit);
  return {controls,submit,heading,prompts,age};
}
export async function runRating(plan:GroupPlan,a:ParticipantAPI,canvas:HTMLCanvasElement,buttons:HTMLButtonElement[],submit:HTMLButtonElement,heading:HTMLElement,age:HTMLInputElement|null,images:Map<string,ImageBitmap>,ctx:CanvasRenderingContext2D,status:HTMLElement,geometry:()=>NonNullable<GroupPlan['geometry']>,release:()=>void,returnToPage:()=>void,content:HTMLElement){
  const replay=new RunReplay(plan),origin=performance.now(),now=()=>performance.now()-origin;
  const items=plan.rating?.items?.length??1;const total=items+(age?1:0);let question=0;let index=0,phase:'waiting'|'rating'|'isi'|'closing'='waiting',intentReady=false,selected:number|null=null,answers:number[]=[];let submission:{values:number[];at:number}|null=null,frame=0,lastFrame=0,stopped=false,clearAt=0,answerSaved=false;
  const instance=()=>`${plan.roots[index]!.root_id}:1`;
  const persist=(r:RunRecord)=>a.ledger.append(plan.scope,'GROUP_RECORD',{record:r});
  const emit=(r:RunRecord)=>{r.clock_origin=origin;replay.apply(r);return persist(r);};
  const blank=()=>{ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);canvas.style.visibility='hidden';};
  const visible=(show:boolean)=>{const controls=buttons[0]?.closest<HTMLElement>('.rating-controls');if(controls)controls.style.visibility=show?'visible':'hidden';submit.style.visibility=show?'visible':'hidden';};
  const disable=()=>{for(const b of buttons)b.disabled=true;submit.disabled=true;};
  async function intent(){
    intentReady=false;await emit({type:'RATING_INTENT',at:now(),instance_id:instance()});if(!stopped)intentReady=true;
  }
  function remove(){document.body.classList.remove('running');window.removeEventListener('resize',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('pagehide',hidden);window.visualViewport?.removeEventListener('resize',visualChange);window.visualViewport?.removeEventListener('scroll',visualChange);}
  async function stop(error:unknown){
    if(stopped)return;stopped=true;cancelAnimationFrame(frame);blank();disable();remove();
    await persist({type:'ABORT',at:now(),clock_origin:origin,reason:String(error).slice(0,150)}).catch(()=>{});
    status.textContent='任务已中断，正在保存已有评分。';await a.terminate('SOFTWARE_RUN_INTERRUPTED',{reason:String(error).slice(0,150)}).catch(()=>{});await a.sync().catch(()=>{});release();document.body.classList.remove('runner-layout');content.replaceChildren(button('返回核对保存记录',returnToPage));
  }
  const change=()=>{if(document.visibilityState!=='visible'||JSON.stringify(geometry())!==JSON.stringify(plan.geometry))void stop('VISIBILITY_OR_GEOMETRY_CHANGED');};
  const visualChange=()=>void stop('VISUAL_VIEWPORT_CHANGED'),hidden=()=>void stop('PAGE_HIDDEN_OR_CLOSED');
  window.addEventListener('resize',change);document.addEventListener('visibilitychange',change);window.addEventListener('pagehide',hidden);window.visualViewport?.addEventListener('resize',visualChange);window.visualViewport?.addEventListener('scroll',visualChange);
  for(const [i,b] of buttons.entries())b.onclick=()=>{
    if(phase!=='rating'||submission||stopped)return;selected=i+1;void emit({type:'RATING_CHANGE',at:now(),instance_id:instance(),item:question,value:selected}).catch(stop);for(const [j,node] of buttons.entries())node.setAttribute('aria-pressed',String(j===i));submit.disabled=false;status.textContent=`第 ${index+1}/${plan.roots.length} 张 · ${plan.rating!.items?.[question]??plan.rating!.prompt} · 已选 ${selected}：${plan.rating!.labels[i]}`;
  };
  submit.onclick=()=>{
    if(phase!=='rating'||submission||stopped)return;if(question===items){const value=Number(age?.value);if(!Number.isInteger(value)||value<0||value>120){status.textContent='请输入 0–120 之间的整数年龄';return;}answers[question]=value;}else{if(selected===null)return;answers[question]=selected;}if(question<total-1){question++;selected=null;for(const b of buttons){b.disabled=false;b.setAttribute('aria-pressed','false');}if(age)age.hidden=question!==items;submit.disabled=question===items;heading.textContent=question===items?(plan.rating!.age_prompt??'年龄'):plan.rating!.items?.[question]??plan.rating!.prompt;submit.textContent=question===total-1?'提交评分':'下一题';status.textContent=`第 ${index+1}/${plan.roots.length} 张 · ${heading.textContent}`;return;}submission={values:[...answers],at:now()};disable();
  };
  async function finish(){
    phase='closing';disable();remove();
    try{await emit({type:'CLOSING',at:now(),unresolved:false});replay.finish();await a.ledger.drain();await a.ledger.closeScope(plan.scope,[...a.session.path,plan.group_id]);status.textContent='评分已完成，正在保存与核对…';await a.seal(plan.scope);await a.sync();release();returnToPage();}
    catch(error){if((await a.ledger.state()).pending[plan.scope]){release();document.body.classList.remove('runner-layout');status.textContent='评分已完成，保存与封存待重试。';content.replaceChildren(button('重试保存与核对',async()=>{try{await a.seal(plan.scope);await a.sync();returnToPage();}catch(e){status.textContent=String(e);}}));}else await stop(error);}
  }
  function tick(raf:number){
    if(stopped||phase==='closing')return;const at=now();
    try{
      if(lastFrame&&at-lastFrame>plan.budget.long_frame_ms)throw new Error('LONG_FRAME');lastFrame=at;
      if(phase==='waiting'&&intentReady&&at>=plan.start){
        const root=plan.roots[index]!,image=images.get(root.asset_id!)!;if(!image)throw new Error('RATING_IMAGE_NOT_PREPARED');
        ctx.fillStyle=a.session.frozen.protocol.layout.background;ctx.fillRect(0,0,canvas.width,canvas.height);const scale=Math.min(canvas.width/image.width,canvas.height/image.height),w=image.width*scale,h=image.height*scale;ctx.drawImage(image,(canvas.width-w)/2,(canvas.height-h)/2,w,h);canvas.style.visibility='visible';
        void emit({type:'ONSET',at,draw_time:now(),raf_time:raf-origin,instance_id:instance()}).catch(stop);phase='rating';visible(true);question=0;answers=[];selected=null;submission=null;if(age){age.hidden=true;age.value='';}for(const b of buttons){b.disabled=false;b.setAttribute('aria-pressed','false');}submit.disabled=true;submit.textContent=items>1?'下一题':'提交评分';heading.textContent=plan.rating!.items?.[0]??plan.rating!.prompt;status.textContent=`第 ${index+1}/${plan.roots.length} 张 · ${plan.rating!.items?.[0]??plan.rating!.prompt}`;
      }else if(phase==='rating'&&submission){
        blank();visible(false);clearAt=now();const answer=submission;phase='isi';answerSaved=false;disable();status.textContent='评分已记录，请等待下一张。';
        void emit({type:'RATING',at,draw_time:clearAt,raf_time:raf-origin,input_time:answer.at,instance_id:instance(),values:answer.values}).then(()=>{answerSaved=true;}).catch(stop);
      }else if(phase==='isi'&&answerSaved&&at>=clearAt+plan.roots[index]!.isi_ms){
        void emit({type:'END',at,instance_id:instance()}).catch(stop);index++;
        if(index===plan.roots.length){void finish();return;}
        phase='waiting';void intent().catch(stop);
      }
    }catch(error){void stop(error);return;}frame=requestAnimationFrame(tick);
  }
  document.body.classList.add('running');submit.hidden=false;disable();blank();visible(false);await intent();if(!stopped)frame=requestAnimationFrame(tick);
}

