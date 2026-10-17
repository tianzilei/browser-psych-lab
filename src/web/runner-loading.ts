import type {ParticipantAPI} from './participant-api.js';
import {preparationAttempt} from './preparation-report.js';
import {el,button} from './dom.js';
export async function loadRunner(api:ParticipantAPI,status:HTMLElement,content:HTMLElement){
  // The browser lock and ledger key survive a reanswer's protocol upgrade.
  const base=import.meta.env.DEV?'/':`/runners/${api.session.frozen.runner_hash}/`,url=`${base}run.html?version=${encodeURIComponent(api.ledger.version)}`;
  const report=preparationAttempt(api,'runner-loading'),controller=new AbortController(),start=performance.now();
  let message='正在加载试验程序',finished=false;
  const show=()=>status.textContent=`${message} · 已等待 ${Math.floor((performance.now()-start)/1000)} 秒${performance.now()-start>=10000?'。网络较慢，请保持页面打开。':'…'}`;
  const cancel=button('取消准备',()=>controller.abort(new DOMException('已取消准备','AbortError')));
  content.replaceChildren(el('p','正在准备试验，加载完成后会自动进入图片下载。','support-text'),cancel);show();
  const timer=setInterval(show,1000),timeout=setTimeout(()=>controller.abort(new DOMException('试验程序加载超时，请重试。','TimeoutError')),45000);
  const hidden=()=>controller.abort(new DOMException('页面已关闭','AbortError'));window.addEventListener('pagehide',hidden,{once:true});
  try{
    if(!import.meta.env.DEV){
      const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error(`试验程序加载失败 (${response.status})`);
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');report.stage('html');
      const prefix=new URL(base,location.origin),resources=[...new Set([...doc.querySelectorAll('script[src],link[rel="modulepreload"][href],link[rel="stylesheet"][href]')].map(node=>new URL(node.getAttribute('src')??node.getAttribute('href')!,prefix).href))];
      if(resources.length>64||resources.some(raw=>{const u=new URL(raw);return u.origin!==prefix.origin||!u.pathname.startsWith(prefix.pathname+'assets/');}))throw new Error('试验程序资源清单无效。');
      // Warm the immutable module/CSS cache while this visible page remains on screen.
      let next=0,done=0;await Promise.all(Array.from({length:Math.min(3,resources.length)},async()=>{
        while(next<resources.length){const resource=resources[next++]!,r=await fetch(resource,{signal:controller.signal});if(!r.ok)throw new Error(`试验程序资源加载失败 (${r.status})`);await r.arrayBuffer();done++;message=`正在加载试验程序 ${done}/${resources.length}`;show();}
      }));report.stage('resources');
    }
    controller.signal.throwIfAborted();message='试验程序已加载，正在进入准备页面';show();await report.finish('READY');finished=true;location.assign(url);
  }catch(error){controller.abort(error);await report.finish(error instanceof DOMException&&error.name==='AbortError'?'CANCELED':'FAILED',{error:String(error).slice(0,500)}).catch(()=>{});throw error;}
  finally{clearInterval(timer);clearTimeout(timeout);window.removeEventListener('pagehide',hidden);if(!finished)cancel.disabled=true;}
}
