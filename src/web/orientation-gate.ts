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
let gate:Promise<void>|undefined,requiredOrientation:Orientation|null=null;
export async function requireOrientation(version:string){await(gate??=initialize(version).catch(error=>{gate=undefined;throw error;}));if(requiredOrientation)await waitForOrientation(requiredOrientation);}
function waitForOrientation(required:Orientation){return new Promise<void>(resolve=>{
  const check=()=>{if(currentOrientation()!==required)return;window.removeEventListener('resize',check);window.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);resolve();};
  window.addEventListener('resize',check);window.addEventListener('orientationchange',check);screen.orientation?.addEventListener('change',check);check();
});}
async function initialize(version:string){
  const meta=await request<{title:string;background:string;orientation:Orientation|null}>(`/api/participate/versions/${version}/metadata`);
  applyParticipantBackground(meta.background);
  const title=document.querySelector<HTMLElement>('#title');if(title){title.textContent=meta.title;title.title=meta.title;}
  requiredOrientation=meta.orientation;
  if(!meta.orientation)return; // Historical frozen protocols keep their original behavior.
  await watchOrientation(meta.orientation).passed;
}
export function watchOrientation(required:Orientation){
  const overlay=el('div',undefined,'orientation-gate');overlay.id='orientation-gate';overlay.setAttribute('role','alert');
  const icon=el('div',undefined,'orientation-device');icon.dataset.orientation=required;icon.setAttribute('aria-hidden','true');
  overlay.append(icon,el('p',required==='portrait'?'请将设备调整为竖屏':'请将设备调整为横屏'),el('span','方向正确后自动继续'));
  document.body.append(overlay);const main=document.querySelector('main');
  let dispose=()=>{};
  const passed=new Promise<void>(resolve=>{
    const check=()=>{const valid=currentOrientation()===required;overlay.hidden=valid;if(main)main.inert=!valid;if(valid)resolve();};
    window.addEventListener('resize',check);window.addEventListener('orientationchange',check);screen.orientation?.addEventListener('change',check);
    dispose=()=>{window.removeEventListener('resize',check);window.removeEventListener('orientationchange',check);screen.orientation?.removeEventListener('change',check);window.removeEventListener('pagehide',dispose);overlay.remove();if(main)main.inert=false;};
    window.addEventListener('pagehide',dispose,{once:true});check();
  });
  return {passed,dispose};
}
