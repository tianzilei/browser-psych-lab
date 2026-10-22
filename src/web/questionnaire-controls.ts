import {answerMissing,inputMatchRegex,inputMatchMessage,type Answer,type Question} from '../shared/protocol.js';
import {el} from './dom.js';
import {numericKeypad,usesNumericKeypad} from './numeric-keypad.js';

export function choiceButton(q:Question,label:string,selected:boolean){
  const button=el('button',undefined,'choice-button'),marker=el('span',undefined,'choice-marker');
  marker.setAttribute('aria-hidden','true');button.type='button';button.dataset.choice=label;button.dataset.choiceType=q.type;
  button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(selected));
  button.append(marker,el('span',label,'choice-label'));return button;
}

/** Button groups move focus only. Native radio groups retain browser behavior. */
export function choiceKeyboard(event:KeyboardEvent,group:HTMLElement){
  if(event.isComposing||event.altKey||event.ctrlKey||event.metaKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const buttons=Array.from(group.querySelectorAll<HTMLButtonElement>('.choice-button:not(:disabled)'));
  const old=buttons.indexOf(document.activeElement as HTMLButtonElement);if(old<0)return;
  event.preventDefault();
  const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(old+(event.key==='ArrowUp'||event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
  buttons[index]!.focus({preventScroll:true});
}

export function questionValidation(q:Question,answer:Answer|undefined){
  if(q.required&&answerMissing(q,answer))return q.type==='text'?'请填写答案后继续。':q.type==='scales'?'请完成每项评分后继续。':q.type==='scale'?'请选择评分后继续。':'请选择答案后继续。';
  if(q.type==='text'&&typeof answer==='string'){
    if(answer.length>q.max_length!)return `最多 ${q.max_length} 个字符。`;
    if(!answerMissing(q,answer)&&q.input_match&&!inputMatchRegex(q.input_match).test(answer))return inputMatchMessage(q.input_match);
  }
  return '';
}

const presetHelp:Record<string,string>={digits:'请输入数字。',integer:'请输入整数。',decimal:'请输入数字（可含小数）。',letters:'请输入字母。',alphanumeric:'请输入字母或数字。',chinese:'请输入中文。',phone_cn:'请输入 11 位手机号。',email:'请输入邮箱地址。'};
function fieldHelp(q:Question){
  const match=q.input_match;if(!match)return `最多 ${q.max_length} 个字符。`;
  if(match.message)return match.message;
  return match.kind==='preset'?presetHelp[match.preset]??`最多 ${q.max_length} 个字符。`:`最多 ${q.max_length} 个字符。`;
}
export function personalField(q:Question,input:HTMLInputElement){
  const element=el('div',undefined,'personal-field'),help=el('p',fieldHelp(q),'input-help'),error=el('p',undefined,'input-error');
  input.id=`personal-input-${q.id}`;input.setAttribute('aria-label',q.title);
  help.id=`input-help-${q.id}`;error.id=`input-error-${q.id}`;error.setAttribute('role','alert');error.hidden=true;
  input.setAttribute('aria-describedby',`${help.id} ${error.id}`);
  const phone=usesNumericKeypad(q);element.dataset.keypad=String(phone);
  element.append(help,phone?numericKeypad(input,q.max_length!,'手机号数字键盘'):input,error);
  function showError(message:string){
    input.setAttribute('aria-invalid',String(!!message));error.textContent=message;error.hidden=!message;
  }
  function liveError(attempted:boolean){
    const value=input.value,invalidPhone=phone&&!!value&&(!/^1[0-9]*$/.test(value)||value.length>=11);
    showError(attempted||invalidPhone?questionValidation(q,value):'');
  }
  return {element,input,phone,showError,liveError};
}
export type PersonalField=ReturnType<typeof personalField>;
