import {wait,overloadDelay} from './wait.js';
import {prepareJsonPost} from './json-transport.js';
import {RequestError} from './request-error.js';
export function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;}
export function button(label:string,action:()=>void|Promise<void>,cls?:string){const b=el('button',label,cls);b.type='button';b.addEventListener('click',()=>{b.disabled=true;void Promise.resolve().then(action).finally(()=>{b.disabled=false;});});return b;}
export function field(label:string,value:string,type='text'){const box=el('label');box.append(el('span',label));const input=el('input');input.type=type;input.value=value;box.append(input);return {box,input};}
export function area(label:string,value:string,rows=3){const box=el('label');box.append(el('span',label));const input=el('textarea');input.value=value;input.rows=rows;box.append(input);return {box,input};}
export function select(label:string,values:{value:string;label:string}[],value:string){const box=el('label');box.append(el('span',label));const input=el('select');for(const v of values){const option=el('option',v.label);option.value=v.value;input.append(option);}input.value=value;box.append(input);return {box,input};}
export function uid(){return crypto.randomUUID();}
export async function request<T>(url:string,data?:unknown,csrf?:string,signal?:AbortSignal):Promise<T>{
  const body=data===undefined?undefined:JSON.stringify(data),started=performance.now();
  const prepared=body===undefined?undefined:await prepareJsonPost(url,body);
  const heavy=/\/seal$|\/api\/lab\/jobs\/(?:backup|export|rebuild)$|\/api\/lab\/jobs\/[^/]+\/recover$|\/api\/lab\/assets\/[^/]+\/delete$/.test(url);
  const budget=heavy?180000:60000,attemptBudget=heavy?150000:15000;
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();const remaining=budget-(performance.now()-started);
    if(remaining<=0)throw new DOMException('Request time budget exceeded','TimeoutError');
    const timeout=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(attemptBudget,remaining))));
    const response=await fetch(url,{...(prepared===undefined?{}:{method:'POST',headers:{...prepared.headers,...(csrf?{'X-CSRF-Token':csrf}:{})},body:prepared.body}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
    // Only explicit overload responses are retried. Reuse the exact serialized
    // request and its request/event identities; an ambiguous timeout surfaces.
    if((response.status===503||response.status===429)&&attempt<7){
      await response.body?.cancel();await wait(Math.min(overloadDelay(response,attempt),Math.max(0,budget-(performance.now()-started))),signal);continue;
    }
    const result=await response.json() as {code?:string;details?:unknown};
    if(!response.ok)throw new RequestError(result.code??'REQUEST_FAILED',response.status,result.details);return result as T;
  }
}
