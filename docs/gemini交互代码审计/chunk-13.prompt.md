当前交互源码第 13 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_13。
ivate last=-Infinity;private origin:number|undefined;private closed=false;private intent:string|null=null;
  private earliest:number;
  readonly changes:{instance_id:string;item:number;value:number;at:number}[]=[];
  constructor(readonly plan:GroupPlan){
    if(!plan.rating||plan.repeats!==0||plan.choices.length!==plan.rating.labels.length)throw new Error('INVALID_RATING_PLAN');
    this.scheduler=new Scheduler(plan.roots,0,plan.start,plan.seed,plan.budget);this.earliest=plan.start;
  }
  apply(r:RunRecord){
    if(!Number.isFinite(r.at)||r.at<this.last||r.at<0||this.closed)throw new Error('INVALID_RATING_TRACE');this.last=r.at;
    if(r.clock_origin!==undefined){if(!Number.isFinite(r.clock_origin)||r.clock_origin<0||(this.origin!==undefined&&this.origin!==r.clock_origin))throw new Error('GROUP_CLOCK_ORIGIN_CHANGED');this.origin=r.clock_origin;}
    else if(this.plan.budget.environment_id!=='TEST_ONLY')throw new Error('MISSING_GROUP_CLOCK_DOMAIN');
    const s=this.scheduler,e=s.queue[0],id=e?.candidate.instance_id,root=this.plan.roots.find(t=>t.root_id===e?.candidate.root_id),result=id?this.results.get(id):undefined;
    if(r.type==='ABORT'){s.interrupt(false);this.closed=true;return;}
    if(s.state!=='RUNNING')throw new Error('RATING_NOT_RUNNING');
    if(r.type==='CLOSING'){
      if(s.queue.length||r.unresolved!==false||this.results.size!==this.plan.roots.length)throw new Error('RATING_INCOMPLETE');
      s.state='GROUP_CLOSING';this.closed=true;return;
    }
    if(!e||r.instance_id!==id)throw new Error('RATING_TRIAL_ORDER_MISMATCH');
    if(r.type==='RATING_INTENT'){
      if(this.intent||result)throw new Error('DUPLICATE_RATING_INTENT');this.intent=id!;s.executions.set(id!,'STAGED');return;
    }
    if(r.type==='ONSET'||r.type==='RATING'){
      if(typeof r.draw_time!=='number'||!Number.isFinite(r.draw_time)||r.draw_time<r.at||r.draw_time-r.at>this.plan.budget.activate_ms)throw new Error('INVALID_DRAW_OBSERVATION');
      if(typeof r.raf_time!=='number'||!Number.isFinite(r.raf_time)||r.raf_time>r.at+1||r.at-r.raf_time>this.plan.budget.long_frame_ms)throw new Error('INVALID_FRAME_OBSERVATION');
    }
    if(r.type==='ONSET'){
      if(this.intent!==id||result||r.at<this.earliest)throw new Error('INVALID_RATING_ONSET');
      this.intent=null;s.observed.push(root!.root_id);s.executions.set(id!,'ONSET_OBSERVED');
      this.results.set(id!,{instance_id:id!,root_id:root!.root_id,number:1,onset:r.draw_time!,clear:null,end:null,answer:null,input_time:null,correct:null,rt_ms:null,software_quality:'SOFTWARE_ONLY',actual_gap:null,...(root!.asset_id?{asset_id:root!.asset_id}:{}),...(root!.category?{category:root!.category}:{})});return;
    }
    if(r.type==='RATING_CHANGE'){
      const item=r.item??0,count=this.plan.rating!.items?.length??1;
      if(!result||result.clear!==null||!Number.isInteger(item)||item<0||item>=count||!Number.isInteger(r.value)||r.value!<1||r.value!>this.plan.choices.length||r.at<result.onset)throw new Error('INVALID_RATING_CHANGE');
      this.changes.push({instance_id:id!,item,value:r.value!,at:r.at});return;
    }
    if(r.type==='RATING'){
      const coreCount=this.plan.rating!.items?.length??1,count=coreCount+(this.plan.rating!.age_prompt?1:0),values=r.values??(r.value===undefined?undefined:[r.value]);
      if(!result||result.clear!==null||!values||values.length!==count||values.slice(0,coreCount).some(v=>!Number.isInteger(v)||v<1||v>this.plan.choices.length)||(this.plan.rating!.age_prompt!==undefined&&(values.at(-1)!<this.plan.rating!.age_min!||values.at(-1)!>this.plan.rating!.age_max!||!Number.isInteger(values.at(-1))))||typeof r.input_time!=='number'||!Number.isFinite(r.input_time)||r.input_time<result.onset||r.input_time>r.at)throw new Error('INVALID_RATING_ANSWER');
      const prior=this.changes.filter(c=>c.instance_id===id);
      if(prior.length)for(let i=0;i<coreCount;i++){const last=prior.filter(c=>c.item===i).at(-1);if(!last||last.value!==values[i]||last.at>r.input_time)throw new Error('RATING_SELECTION_MISMATCH');}
      result.ratings=[...values];result.rating=values[0]!;result.rating_label=this.plan.rating!.labels[values[0]!-1]!;result.rating_labels=values.slice(0,coreCount).map(v=>this.plan.rating!.labels[v-1]!);result.answer=JSON.stringify(values);result.input_time=r.input_time;
      result.rt_ms=r.input_time-result.onset;result.submit_rt_ms=result.rt_ms;
      if(prior.length)result.first_rt_ms=Math.min(...prior.map(c=>c.at))-result.onset;
      result.rating_item_times=Array.from({length:coreCount},(_,item)=>{const changes=prior.filter(c=>c.item===item);return {item,first_rt_ms:changes[0]?changes[0].at-result.onset:null,last_rt_ms:changes.at(-1)?changes.at(-1)!.at-result.onset:null,changes:changes.filter((c,i)=>i>0&&c.value!==changes[i-1]!.value).length};});
      result.change_count=prior.filter((c,i)=>i>0&&c.value!==prior[i-1]!.value).length;
      result.clear=r.draw_time!;s.executions.set(id!,'WINDOW_CLOSED');return;
    }
    if(r.type==='END'){
      if(!result||result.clear===null||result.end!==null||r.at<result.clear+root!.isi_ms)throw new Error('RATING_ISI_TOO_SHORT');
      result.end=r.at;result.isi_ms=r.at-result.clear;s.executions.set(id!,'ENDED_OBSERVED');s.queue.shift();this.earliest=r.at;return;
    }
    throw new Error('INVALID_RATING_RECORD');
  }
  finish(){if(this.scheduler.state!=='GROUP_CLOSING')throw new Error('GROUP_NOT_NORMALLY_CLOSED');return [...this.results.values()];}
}


```


=== FILE src/shared/task-policy.ts (complete source; may continue in next chunk) ===
```
// These values belong to the frozen v1 runner contract. A different timeout
// policy must receive a new identity rather than changing this policy in place.
export const TASK_ACTIVITY_POLICY = Object.freeze({
  id: 'idle120-offline300-v1',
  idle_timeout_ms: 120_000,
  connection_timeout_ms: 300_000,
  renewal_interval_ms: 60_000,
  request_timeout_ms: 10_000,
  client_check_interval_ms: 1_000,
  server_scan_interval_ms: 30_000,
} as const);

```


=== FILE src/web/participant.css (complete source; may continue in next chunk) ===
```
:root {
  --background: #e5e5e5;
  --foreground: #000000;
  --line: #b4b4b4;
  --font-body: -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",system-ui,sans-serif;
  --font-size-body: 16px;
  --font-size-title: 17px;
  --font-size-status: 13px;
  --font-size-question: 18px;
  --font-size-help: 14px;
  --font-size-ending: 15px;
  --line-body: 1.45;
  --line-tight: 1.25;
  --touch-min: 48px;
  --page-inline: max(16px,3vw);
  --safe-bottom: env(safe-area-inset-bottom,0px);
  font: var(--font-size-body)/var(--line-body) var(--font-body);
  color: #000; background: #e5e5e5; color-scheme: light;
}
* { box-sizing: border-box; }
html,body { width: 100%; min-height: 100%; margin: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; }
body { touch-action: manipulation; }
main { width: min(100%, 1100px); min-height: 100dvh; margin: 0 auto; padding: max(16px,env(safe-area-inset-top)) var(--page-inline) calc(16px + var(--safe-bottom)); display: grid; grid-template-rows: auto minmax(0,1fr); gap: 12px; }
header { display: grid; gap: 4px; min-height: 0; }
h1 { font-size: var(--font-size-title); line-height: 1.35; font-weight: 500; margin: 0; overflow-wrap: anywhere; }
#status { font-size: var(--font-size-status); line-height: 1.4; margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
#status:empty { display: none; }
#content { grid-row: 2; min-width: 0; min-height: 0; display: grid; align-content: start; justify-items: stretch; }
#content > button { justify-self: center; }
.recovery-actions { width: min(100%, 520px); justify-self: center; display: grid; gap: 16px; align-self: start; margin-top: 16px; }
.recovery-actions button { width: 100%; }
.error-details { font-size: 13px; }
.error-details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
.error-details pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30dvh; overflow: auto; font-size: 12px; }
.support-text { justify-self: center; width: min(100%,520px); margin-top: 16px; font-size: 14px; }
#content:has(.questionnaire),#content:has(.runner-stage),#content:has(.ending-page),#content:has(.consent-page) { align-content: stretch; }
.survey-mount { min-height: 0; }
p { margin: 0; overflow-wrap: anywhere; }
button { min-width: 0; min-height: var(--touch-min); font: inherit; font-size: 16px; line-height: 1.2; padding: 10px 14px; border: 1px solid currentColor; border-radius: 10px; color: inherit; background: transparent; cursor: pointer; overflow-wrap: anywhere; touch-action: manipulation; }
button:disabled { opacity: .5; cursor: default; }
button.primary { color: var(--background); background: var(--foreground); border-color: var(--foreground); }
button:focus-visible,input:focus-visible,.reading-text:focus-visible,summary:focus-visible { outline: 2px solid var(--foreground); outline-offset: 3px; }
.questionnaire { width: min(100%,900px); height: max(240px,calc(var(--viewport-height,100dvh) - var(--survey-top,100px) - 16px)); min-width: 0; justify-self: center; display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: 12px; }
.question-meta { grid-row: 1; min-height: 0; display: grid; gap: 4px; }
.question-progress,.question-error { font-size: var(--font-size-status); line-height: 1.25; }
.question-error { font-weight: 600; }
.question-error:empty { display: none; }
.question-screen { grid-row: 2; min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(4.5rem,auto) minmax(0,1fr); gap: 12px; }
.question-screen.reading-only { grid-template-rows: minmax(0,1fr) 0; }
.question-screen.selection-question { grid-template-rows: minmax(4.5rem,auto) minmax(0,1fr); }
.question-screen.single-axis-question { grid-template-rows: minmax(4.5rem,5rem) minmax(0,1fr); }
.reading-text { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; min-height: 0; overflow: hidden; }
.selection-question > .reading-text { font-size: var(--font-size-question); }
.answer-area { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0,1fr); gap: 6px; }
.answer-area.choices-grid { grid-template-columns: repeat(var(--choice-columns,1),minmax(0,1fr)); grid-template-rows: repeat(var(--choice-rows,1),minmax(0,1fr)); }
.reading-only .answer-area { padding: 0; }
.choice-button { width: 100%; display: flex; align-items: center; text-align: left; gap: 6px; max-height: 100%; padding: 6px; }
.choice-button::before { content: '○'; flex: none; }
.choice-button[aria-pressed=true] { background: currentColor; }
.choice-button[aria-pressed=true]::before { content: '●'; }
.choice-button[aria-pressed=true] span,.choice-button[aria-pressed=true]::before { color: var(--background); }
.choice-label { display: block; min-width: 0; max-height: 100%; white-space: pre-wrap; overflow: hidden; overflow-wrap: anywhere; }
.axis-control { width: 100%; max-width: 680px; margin-inline: auto; min-width: 0; align-self: center; display: grid; gap: 8px; padding: 1.5rem .75rem; border: 1px solid var(--line); border-radius: 18px; }
.axis-ends { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; font-size: 14px; }
.axis-ends span { overflow-wrap: anywhere; }
.axis-ends span:last-child { text-align: right; }
.axis-track { position: relative; height: 44px; }
.axis-input { appearance: none; -webkit-appearance: none; width: 100%; height: 44px; padding: 0; margin: 0; border: 0; background: transparent; color: inherit; touch-action: none; }
.axis-input:focus-visible { outline: none; }
.axis-control:has(.axis-input:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
.axis-input::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: currentColor; }
.axis-input::-moz-range-track { height: 3px; border-radius: 2px; background: currentColor; }
.axis-input::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 22px; height: 22px; margin-top: -10px; border: 1px solid currentColor; border-radius: 50%; background: currentColor; }
.axis-input::-moz-range-thumb { width: 22px; height: 22px; border: 1px solid currentColor; border-radius: 50%; background: currentColor; }
.axis-input[data-answered=false]::-webkit-slider-thumb { opacity: 0; }
.axis-input[data-answered=false]::-moz-range-thumb { opacity: 0; }
.axis-ticks { position: absolute; inset: 50% 11px auto; display: flex; justify-content: space-between; pointer-events: none; transform: translateY(-50%); }
.axis-ticks span { height: 8px; border-left: 1px solid currentColor; }
.axis-ticks span[data-selected=true] { height: 14px; border-left-width: 2px; }
.axis-bottom { display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; font-size: 14px; }
.axis-bottom button { flex: none; }
.axis-bottom output { overflow-wrap: anywhere; text-align: center; }
.axis-bottom output[data-answered=true] { font-weight: 600; }
.question-screen.multi-axis-question { grid-template-rows: minmax(32px,14%) minmax(0,1fr); }
.axes-grid { grid-template-columns: repeat(var(--axis-columns,1),minmax(0,1fr)); grid-template-rows: repeat(var(--axis-rows,1),minmax(0,1fr)); gap: 6px; }
.axes-grid .axis-control { height: 100%; align-self: stretch; max-width: none; padding: 2px 8px; border-radius: 10px; gap: 0; grid-template-columns: minmax(0,1fr) minmax(0,1fr); grid-template-rows: minmax(16px,1fr) 44px minmax(16px,1fr); grid-template-areas: 'title feedback' 'track track' 'ends ends'; }
.axis-title { grid-area: title; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; align-self: center; }
.axes-grid .axis-track { grid-area: track; }
.axes-grid .axis-ends { grid-area: ends; font-size: 12px; gap: 8px; align-self: center; }
.axes-grid .axis-bottom { grid-area: feedback; font-size: 12px; justify-content: end; gap: 4px; }
.axes-grid .axis-bottom output { text-align: right; }
.axes-grid .axis-control:has(button) { grid-template-rows: