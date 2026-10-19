import {el} from './dom.js';
import {ui} from './participant-ui.js';
import type {Rating} from '../shared/protocol.js';
import type {RunRecord} from '../shared/lab-contract.js';
import {numericKeys} from './numeric-keypad.js';

function axis(prompt:string,labels:string[],index:string){
  const axis=el('div',undefined,`${index==='familiarity'?'familiarity-axis':'rating-axis'} axis-control`),ends=el('div',undefined,'axis-ends');
  axis.style.visibility='hidden';ends.append(el('span',`1 · ${labels[0]??''}`),el('span',`${labels.length} · ${labels.at(-1)??''}`));
  const track=el('div',undefined,'axis-track'),range=el('input',undefined,'axis-input');range.type='range';range.min='1';range.max=String(labels.length);range.step='1';range.value=String(Math.ceil(labels.length/2));range.dataset.answered='false';range.setAttribute('aria-label',prompt);range.setAttribute('aria-valuetext','尚未作答');
  const ticks=el('div',undefined,'rating-ticks');ticks.setAttribute('aria-hidden','true');for(let i=0;i<labels.length;i++)ticks.append(el('span',String(i+1)));track.append(range);
  const bottom=el('div',undefined,'axis-bottom'),output=el('output',ui.scaleHint);output.id=`rating-value-${index}`;output.setAttribute('aria-live','off');range.setAttribute('aria-describedby',output.id);bottom.append(output);axis.append(ends,track,ticks,bottom);return {axis,range};
}
export function ratingControls(rating:Rating,footer:HTMLElement){
  const prompts=rating.items??[rating.prompt],controls=el('div',undefined,'rating-controls'),heading=el('p',prompts[0]);heading.id='rating-prompt';
  const axes=prompts.map((prompt,i)=>axis(prompt,rating.labels,String(i))),familiarity=rating.familiarity?axis(rating.familiarity.prompt,rating.familiarity.labels,'familiarity'):null;
  controls.style.visibility='hidden';controls.append(heading,...axes.map(a=>a.axis));if(familiarity)controls.append(familiarity.axis);
  const age=rating.age_prompt?el('input',undefined,'rating-age'):null,ageRow=age?el('div',undefined,'rating-age-row'):null;
  if(age&&ageRow){ageRow.style.visibility='hidden';age.type='text';age.readOnly=true;age.inputMode='none';age.pattern='[0-9]{1,3}';age.placeholder='使用下方数字键盘';age.setAttribute('aria-label',rating.age_prompt!);
    const hint=el('span',`${rating.age_min??0}–${rating.age_max??120} 岁`,'rating-age-hint'),entry=el('div',undefined,'rating-age-entry');hint.id='rating-age-hint';age.setAttribute('aria-describedby',hint.id);entry.append(age,hint);
    const keypad=el('div',undefined,'rating-age-keypad');keypad.setAttribute('role','group');keypad.setAttribute('aria-label','年龄数字键盘');
    const enter=(key:string)=>{if(keypad.inert)return;const deleting=key==='Backspace'||key==='Clear',value=key==='Clear'?'':key==='Backspace'?age.value.slice(0,-1):age.value.length<3?age.value+key:age.value;if(value===age.value)return;age.value=value;age.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:deleting?'deleteContentBackward':'insertText',data:deleting?null:key}));};
    numericKeys(keypad,enter);
    age.onkeydown=event=>{if(/^[0-9]$/.test(event.key)||event.key==='Backspace'){event.preventDefault();enter(event.key);}};ageRow.append(entry,keypad);controls.append(ageRow);
  }
  const submit=el('button',undefined,'primary');submit.type='button';submit.style.visibility='hidden';submit.disabled=true;footer.append(submit);
  return {controls,heading,axes:axes.map(a=>a.axis),ranges:axes.map(a=>a.range),familiarity,age,ageRow,submit};
}
export type RatingControls=ReturnType<typeof ratingControls>;
type Question={kind:'rating'|'familiarity'|'age';prompt:string;item:number;labels?:string[];range?:HTMLInputElement;axis?:HTMLElement};
/** Formal and simulated ratings share question order, validation and input handling. */
export function mountRatingQuestions(rating:Rating,panel:RatingControls,callbacks:{
  record:(record:Pick<RunRecord,'type'|'item'|'value'>)=>Promise<unknown>;
  familiarity:(value:number)=>Promise<unknown>;complete:(values:number[])=>void;
  screen:()=>void;fail:(error:unknown)=>void;
}){
  const core=(rating.items??[rating.prompt]).map((prompt,item):Question=>({kind:'rating',prompt,item,labels:rating.labels,range:panel.ranges[item]!,axis:panel.axes[item]!})),questions=[...core];
  if(rating.familiarity&&panel.familiarity){const q:Question={kind:'familiarity',prompt:rating.familiarity.prompt,item:core.length,labels:rating.familiarity.labels,...panel.familiarity};questions.splice(rating.familiarity.position==='before-age'?questions.length:0,0,q);}
  if(rating.age_prompt)questions.push({kind:'age',prompt:rating.age_prompt,item:core.length});
  let index=0,selected:number|null=null,answers:number[]=[],active=false,busy=false,generation=0;
  const endDrags:(()=>void)[]=[],current=()=>questions[index]!,ranges=[...panel.ranges,...panel.familiarity?[panel.familiarity.range]:[]],allAxes=[...panel.axes,...panel.familiarity?[panel.familiarity.axis]:[]];
  const validAge=()=>!!panel.age&&/^\d{1,3}$/.test(panel.age.value)&&Number(panel.age.value)>=(rating.age_min??0)&&Number(panel.age.value)<=(rating.age_max??120);
  function disable(){for(const end of endDrags)end();for(const range of ranges)range.disabled=true;panel.submit.disabled=true;if(panel.ageRow)panel.ageRow.inert=true;}
  function render(){disable();selected=null;for(const a of allAxes)a.style.visibility='hidden';if(panel.ageRow)panel.ageRow.style.visibility='hidden';const q=current();
    panel.heading.textContent=q.prompt;panel.submit.textContent=index===questions.length-1?ui.submitRating:ui.nextQuestion;
    if(q.range){q.axis!.style.visibility='visible';q.range.disabled=false;q.range.value=String(Math.ceil(Number(q.range.max)/2));q.range.dataset.answered='false';q.range.setAttribute('aria-valuetext','尚未作答');q.axis!.querySelector('output')!.textContent=ui.scaleHint;q.axis!.querySelectorAll('.rating-ticks span').forEach(e=>(e as HTMLElement).dataset.selected='false');}
    if(q.kind==='age'&&panel.ageRow){panel.ageRow.style.visibility='visible';panel.ageRow.inert=false;panel.age!.value='';panel.age!.dispatchEvent(new Event('input'));}callbacks.screen();
  }
  function choose(range:HTMLInputElement,value:number){if(!active||busy||range.disabled||current().range!==range||selected===value)return;selected=value;range.dataset.answered='true';const q=current(),label=q.labels![value-1]??'';range.setAttribute('aria-valuetext',`${value}：${label}`);q.axis!.querySelector('output')!.textContent=`已选择：${value} · ${label}`;q.axis!.querySelectorAll('.rating-ticks span').forEach((e,i)=>(e as HTMLElement).dataset.selected=String(i===value-1));
    void callbacks.record({type:q.kind==='familiarity'?'RATING_FAMILIARITY_CHANGE':'RATING_CHANGE',...(q.kind==='rating'?{item:q.item}:{}),value}).catch(callbacks.fail);panel.submit.disabled=false;
  }
  for(const range of ranges){let pointer:number|null=null;const available=()=>active&&!busy&&!range.disabled&&current().range===range;
    const end=()=>{const old=pointer;pointer=null;if(old!==null&&range.hasPointerCapture(old))range.releasePointerCapture(old);};endDrags.push(end);
    const update=(x:number)=>{if(!available())return;const r=range.getBoundingClientRect(),v=1+Math.round(Math.max(0,Math.min(1,(x-r.left-11)/Math.max(1,r.width-22)))*(Number(range.max)-1));range.value=String(v);choose(range,v);};
    range.onpointerdown=e=>{if(!available()||!e.isPrimary||e.button!==0||pointer!==null)return;e.preventDefault();pointer=e.pointerId;range.setPointerCapture(pointer);update(e.clientX);};range.onpointermove=e=>{if(pointer===e.pointerId&&available()){e.preventDefault();update(e.clientX);}};range.onpointerup=e=>{if(pointer===e.pointerId){update(e.clientX);end();}};range.onpointercancel=e=>{if(pointer===e.pointerId)end();};range.onlostpointercapture=e=>{if(pointer===e.pointerId)pointer=null;};
    range.onkeydown=e=>{if(available()&&!e.isComposing&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&['Enter',' '].includes(e.key)){e.preventDefault();choose(range,Number(range.value));}};range.oninput=range.onchange=()=>choose(range,Number(range.value));
  }
  if(panel.age)panel.age.oninput=()=>{const valid=validAge();panel.submit.disabled=!active||busy||current().kind!=='age'||!valid;panel.age!.setAttribute('aria-invalid',String(!!panel.age!.value&&!valid));const hint=panel.ageRow!.querySelector('.rating-age-hint')!;hint.textContent=panel.age!.value&&!valid?`请输入 ${rating.age_min??0}–${rating.age_max??120} 岁`:`${rating.age_min??0}–${rating.age_max??120} 岁`;};
  panel.submit.onclick=async event=>{if(!active||busy||panel.submit.disabled)return;const q=current(),token=generation;busy=true;disable();try{
    if(q.kind==='familiarity'){if(selected===null)return;await callbacks.familiarity(selected);}else if(q.kind==='age'){if(!validAge())return;answers[q.item]=Number(panel.age!.value);}else{if(selected===null)return;answers[q.item]=selected;}
    if(!active||token!==generation)return;
    if(index===questions.length-1){active=false;callbacks.complete([...answers]);return;}
    index++;busy=false;render();if(event.detail===0)(current().range??panel.age)?.focus({preventScroll:true});
  }catch(e){callbacks.fail(e);}finally{if(token===generation)busy=false;}};
  disable();return {
    start(){generation++;active=true;busy=false;index=0;answers=[];panel.controls.style.visibility='visible';panel.controls.style.opacity='1';panel.controls.style.pointerEvents='auto';panel.submit.style.visibility='visible';render();},
    hide(){generation++;active=false;busy=false;disable();panel.controls.style.visibility='hidden';panel.controls.style.opacity='0';panel.controls.style.pointerEvents='none';panel.submit.style.visibility='hidden';},
    stop(){generation++;active=false;disable();},
    context:()=>({item:current().item,phase:current().kind,question_id:current().kind==='rating'?`impression-${current().item+1}`:current().kind==='age'?'estimated-age':'familiarity'}),typing:()=>active&&current().kind==='age'&&document.activeElement===panel.age
  };
}
