import {el,button} from './dom.js';
import type {Question} from '../shared/protocol.js';
// Keep the production phone keypad in both participant and simulation pages.
export function usesNumericKeypad(q:Question){return q.type==='text'&&((q.input_match?.kind==='preset'&&q.input_match.preset==='phone_cn')||(q.input_match?.kind==='regex'&&q.input_match.pattern==='1[0-9]{10}'));}
const mounted=new WeakMap<HTMLInputElement,HTMLElement>();
export function numericKeys(keypad:HTMLElement,enter:(key:string)=>void){
  for(const digit of ['1','2','3','4','5','6','7','8','9','0'])keypad.append(button(digit,()=>enter(digit)));
  keypad.append(button('删除',()=>enter('Backspace')),button('清空',()=>enter('Clear'),'numeric-keypad-clear'));
}
export function numericKeypad(input:HTMLInputElement,maxLength:number,label:string){
  const existing=mounted.get(input);if(existing)return existing;
  input.readOnly=true;input.inputMode='none';const wrapper=el('div',undefined,'survey-text-control'),keypad=el('div',undefined,'numeric-keypad');keypad.setAttribute('role','group');keypad.setAttribute('aria-label',label);
  const enter=(key:string)=>{const deleting=key==='Backspace'||key==='Clear',value=key==='Clear'?'':key==='Backspace'?input.value.slice(0,-1):input.value.length<maxLength?input.value+key:input.value;if(value===input.value)return;input.value=value;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:deleting?'deleteContentBackward':'insertText',data:deleting?null:key}));input.focus({preventScroll:true});};
  numericKeys(keypad,enter);input.addEventListener('keydown',e=>{if(/^[0-9]$/.test(e.key)||e.key==='Backspace'){e.preventDefault();enter(e.key);}});wrapper.append(input,keypad);mounted.set(input,wrapper);return wrapper;
}
