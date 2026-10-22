import {evaluate,copyAnswer,axisAnswers,answerMissing,inputMatchRegex,inputMatchMessage,type Page,type Answer,type Question} from '../shared/protocol.js';
import {el} from './dom.js';
import {scaleInput} from './scale-input.js';
import {usesNumericKeypad} from './numeric-keypad.js';
import {choiceButton,choiceKeyboard,personalField,questionValidation,type PersonalField} from './questionnaire-controls.js';

type Answers=Record<string,Answer>;
interface Options {
  offset:number;total:number;start?:string|undefined;history?:string[]|undefined;introduction?:string|undefined;last:boolean;
  readonly?:boolean;
  cursor:(question_id:string,history:string[])=>Promise<void>;error:(error:unknown)=>void;
  screen?:((question_id:string|undefined)=>void)|undefined;
}
/** A viewport page never straddles an immutable storage segment. */
export function mountAdaptivePage(element:HTMLDivElement,page:Page,previous:Answers,values:Answers,
  revision:(name:string,answer:Answer,data:Answers)=>Promise<unknown>,complete:(data:Answers)=>Promise<void>,options:Options){
  const answers:Answers=structuredClone(values),cards=new Map<number,HTMLElement>(),fields=new Map<string,PersonalField>(),attempted=new Set<string>();
  const form=el('form',undefined,'adaptive-questionnaire'),top=el('div',undefined,'question-meta');
  form.noValidate=true;
  const progress=el('p',undefined,'question-progress'),message=el('p',undefined,'question-error');
  message.setAttribute('role','alert');top.append(progress,message);
  const screen=el('div',undefined,'adaptive-screen'),grid=el('div',undefined,'adaptive-grid');
  screen.append(grid);
  const nav=el('div',undefined,'question-nav'),back=el('button','上一页'),next=el('button',undefined,'primary');
  back.type=next.type='button';nav.append(back,next);form.append(top,screen,nav);element.replaceChildren(form);
  let visible:number[]=[],shown:number[]=[],history:number[]=[];
  let start=page.questions.findIndex(q=>q.id===options.start),intro=!!options.introduction&&start<0;
  let disposed=false,busy=false,composing=false,frame=0;
  let writes:Promise<unknown>=Promise.resolve();
  const snapshot=()=>structuredClone(answers);
  function visibility(){
    const effective={...previous};visible=[];
    page.questions.forEach((q,i)=>{const show=evaluate(q.condition,effective);if(show)visible.push(i);effective[q.id]=show?answers[q.id]??null:null;});
  }
  visibility();if(!visible.includes(start))start=visible[0]??0;
  history=(options.history??[]).map(id=>page.questions.findIndex(q=>q.id===id)).filter(i=>visible.includes(i)&&i<start);
  function save(q:Question,answer:Answer){
    if(disposed||busy||options.readonly||JSON.stringify(answers[q.id])===JSON.stringify(answer))return;
    const before=visible.join();answers[q.id]=copyAnswer(answer);message.textContent='';
    cards.get(page.questions.indexOf(q))?.classList.remove('adaptive-invalid');
    writes=revision(q.id,copyAnswer(answer),snapshot());void writes.catch(options.error);
    visibility();if(before!==visible.join()&&!composing)requestLayout();
    navigation();
  }
  function card(index:number){
    const cached=cards.get(index);if(cached)return cached;
    const q=page.questions[index]!,node=el('section',undefined,'adaptive-card'),heading=q.type==='text'?el('label',q.title,'adaptive-title'):el('p',q.title,'adaptive-title');
    node.dataset.questionId=q.id;node.dataset.questionIndex=String(index);node.setAttribute('role','group');
    heading.id=`adaptive-title-${q.id}`;node.setAttribute('aria-labelledby',heading.id);node.tabIndex=-1;
    node.append(el('p',`第 ${options.offset+index+1} 题 · ${q.required?'必答':'可选'}${q.type==='multi'?' · 可多选':''}`,'adaptive-item-meta'),heading);
    if(q.type==='text'){
      const input=el('input');input.type='text';input.name=q.id;input.maxLength=q.max_length!;input.autocomplete='off';input.enterKeyHint='done';
      input.value=typeof answers[q.id]==='string'?answers[q.id] as string:'';input.setAttribute('aria-label',q.title);
      if(q.input_match){input.title=inputMatchMessage(q.input_match);if(q.input_match.kind==='preset'||!q.input_match.flags)input.pattern=inputMatchRegex(q.input_match).source;}
      const update=()=>{save(q,input.value);if(!composing)fields.get(q.id)?.liveError(attempted.has(q.id));navigation();};
      input.addEventListener('input',update);input.addEventListener('change',update);
      input.addEventListener('compositionstart',()=>{composing=true;});
      input.addEventListener('compositionend',()=>{composing=false;update();visibility();});
      const field=personalField(q,input);fields.set(q.id,field);if(heading instanceof HTMLLabelElement)heading.htmlFor=input.id;
      input.addEventListener('blur',requestLayout);node.append(field.element);
    }else if(q.type==='scale')node.append(scaleInput(q,answers[q.id],value=>save(q,value)));
    else if(q.type==='scales')for(const axis of q.axes!){
      const control=scaleInput({...axis,id:`${q.id}-${axis.id}`,required:q.required},axisAnswers(answers[q.id])[axis.id],value=>{
        const data=Object.fromEntries(q.axes!.map(a=>[a.id,axisAnswers(answers[q.id])[a.id]??null]));data[axis.id]=value;save(q,data);
      });control.prepend(el('p',axis.title,'axis-title'));node.append(control);
    }else{
      const choices=el('div',undefined,'adaptive-choices'),selected=(label:string)=>q.type==='multi'?Array.isArray(answers[q.id])&&(answers[q.id] as string[]).includes(label):answers[q.id]===label;
      choices.dataset.longChoices=String(q.choices!.some(label=>label.length>24||label.includes('\n')));choices.setAttribute('role','group');choices.setAttribute('aria-labelledby',heading.id);
      choices.addEventListener('keydown',event=>choiceKeyboard(event,choices));
      for(const label of q.choices!){
        const choice=choiceButton(q,label,selected(label));
        choice.addEventListener('click',()=>{save(q,q.type==='multi'?q.choices!.filter(c=>c===label?!selected(c):selected(c)):selected(label)&&!q.required?null:label);
          for(const b of choices.querySelectorAll<HTMLButtonElement>('button'))b.setAttribute('aria-pressed',String(selected(b.dataset.choice!)));
        });choices.append(choice);
      }node.append(choices);
    }
    if(options.readonly)for(const control of node.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button'))control.disabled=true;
    cards.set(index,node);return node;
  }
  function navigation(){
    back.hidden=intro||!history.length;nav.classList.toggle('single-action',back.hidden);
    next.textContent=intro?'开始作答':shown.at(-1)===visible.at(-1)&&options.last?'完成问卷':'下一页';
    back.disabled=busy;next.disabled=busy||shown.some(i=>{const q=page.questions[i]!;return usesNumericKeypad(q)&&!!questionValidation(q,answers[q.id]);});
    form.setAttribute('aria-busy',String(busy));
  }
  function layout(){
    if(disposed)return;
    form.style.setProperty('--survey-top',`${element.getBoundingClientRect().top}px`);
    if(intro){
      const text=el('div',options.introduction,'adaptive-introduction');text.tabIndex=-1;
      grid.replaceChildren(text);progress.textContent='作答说明';shown=[];navigation();return;
    }
    if(!visible.includes(start))start=visible.find(i=>i>=start)??visible.at(-1)??0;
    // Reserve the progress row before measuring. On first render an empty
    // row otherwise gives the grid extra space that disappears after packing.
    progress.textContent=`第 ${options.offset+start+1} / ${options.total} 题`;
    const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
    grid.replaceChildren();shown=[];
    // Measure real wrapped question/control geometry. At least one complete
    // card remains scrollable on very small screens or unusually long items.
    for(const i of visible.filter(i=>i>=start)){
      const q=page.questions[i]!;
      if(shown.length&&q.type==='text')break;
      const node=card(i);grid.append(node);
      const style=getComputedStyle(screen),available=screen.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      if(shown.length&&grid.getBoundingClientRect().height>available+1){node.remove();break;}
      shown.push(i);if(q.type==='text')break;
    }
    const first=shown[0]??start,last=shown.at(-1)??first;
    if(shown.some(i=>page.questions[i]!.type==='text'))message.removeAttribute('role');else message.setAttribute('role','alert');
    progress.textContent=`第 ${options.offset+first+1}${last===first?'':`–${options.offset+last+1}`} / ${options.total} 题`;
    navigation();if(focused&&grid.contains(focused))focused.focus({preventScroll:true});options.screen?.(page.questions[first]?.id);
  }
  function requestLayout(){
    if(frame||disposed)return;
    frame=requestAnimationFrame(()=>{frame=0;
      // Preserve the active input and its screen during IME/soft-keyboard resize.
      if(composing||grid.contains(document.activeElement)&&document.activeElement instanceof HTMLInputElement&&document.activeElement.type==='text')return;
      layout();
    });
  }
  async function show(index:number){
    await writes;await options.cursor(page.questions[index]?.id??'',history.map(i=>page.questions[i]!.id));
    start=index;message.textContent='';layout();screen.scrollTop=0;cards.get(start)?.focus({preventScroll:true});
  }
  function validate(index:number){
    const q=page.questions[index]!,answer=answers[q.id];attempted.add(q.id);
    const error=q.type!=='text'&&q.required&&answerMissing(q,answer)?'请完成本页所有必答题后继续。':questionValidation(q,answer);
    const node=card(index);
    if(q.type==='text'){fields.get(q.id)!.showError(error);message.textContent='';message.removeAttribute('role');}
    else{message.setAttribute('role','alert');message.textContent=error;}
    if(!error){node.classList.remove('adaptive-invalid');return true;}
    node.classList.add('adaptive-invalid');
    node.scrollIntoView({block:'nearest'});node.focus({preventScroll:true});return false;
  }
  async function forward(){
    if(intro){intro=false;await show(visible[0]??0);return;}
    for(const i of shown)if(!validate(i))return;
    await writes;visibility();
    const nextIndex=visible.find(i=>i>(shown.at(-1)??-1));
    if(nextIndex!==undefined){history.push(start);await show(nextIndex);return;}
    const invalid=visible.find(i=>!validate(i));
    if(invalid!==undefined){await show(invalid);validate(invalid);return;}
    // Waiting here covers local durable commits only. Network saving is a
    // separate controller and never blocks moving to the next storage segment.
    await complete(snapshot());
  }
  async function navigate(action:()=>Promise<void>){
    if(busy||disposed||composing)return;busy=true;navigation();
    try{await action();}catch(error){options.error(error);}finally{busy=false;if(!disposed)navigation();}
  }
  next.addEventListener('click',()=>void navigate(forward));
  back.addEventListener('click',()=>void navigate(async()=>{const index=history.pop();if(index!==undefined)await show(index);}));
  form.addEventListener('submit',event=>{event.preventDefault();void navigate(forward);});
  const observer=new ResizeObserver(requestLayout);observer.observe(screen);
  layout();requestLayout();
  return()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);};
}
