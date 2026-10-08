import {openDB,deleteDB} from 'idb';
import {downloadOriginal,DOWNLOAD_POLICY} from './asset-download.js';
import type {LabSession} from '../shared/lab-contract.js';
import {worstAuditPayload,type Group,type Protocol} from '../shared/protocol.js';
export async function refreshProbe(protocol:Protocol){
  const times:number[]=[];await new Promise<void>(resolve=>{let prior:number|null=null;const tick=(t:number)=>{if(prior!==null)times.push(t-prior);prior=t;if(times.length<30)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
  const sorted=[...times].sort((a,b)=>a-b),frame=sorted[Math.floor(sorted.length/2)]!;
  if(1000/frame<protocol.budget.refresh_min_hz||1000/frame>protocol.budget.refresh_max_hz||Math.max(...times)>protocol.budget.long_frame_ms)throw new Error('当前刷新节奏不符合该版本预算。');
  return {frame_ms:frame,observed_intervals:times};
}
export async function storageProbe(group:Group,protocol:Protocol){const name=`bpl-storage-probe-${crypto.randomUUID()}`,db=await openDB(name,1,{upgrade(db){db.createObjectStore('events');db.createObjectStore('outbox');db.createObjectStore('meta');}});const samples:number[]=[];
  try{const payload=worstAuditPayload(group,protocol.budget.draw_budget);await db.put('meta',{head:null,sequence:0},'state');for(let i=0;i<10;i++){const start=performance.now();for(let j=0;j<4;j++){
    const meta=await db.get('meta','state');const event={event_id:crypto.randomUUID(),previous:meta.head,sequence:meta.sequence,clock_epoch:crypto.randomUUID(),writer_id:crypto.randomUUID(),protocol_hash:'f'.repeat(64),payload};const raw=JSON.stringify(event),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
    const tx=db.transaction(['events','outbox','meta'],'readwrite',{durability:'strict'});const row={event_id:event.event_id,hash,raw};await tx.objectStore('meta').get('state');await tx.objectStore('events').put(row,'latest');await tx.objectStore('outbox').put(row,'latest');await tx.objectStore('meta').put({head:{event_id:event.event_id,hash},sequence:meta.sequence+1},'state');await tx.done;
  }samples.push(performance.now()-start);}return {commit_ms:Math.max(...samples),samples,path:'four-full-envelope-meta-events-outbox-strict-v1',audit_bytes:new TextEncoder().encode(JSON.stringify(payload)).length};}
  finally{db.close();await deleteDB(name);}
}
export async function prepareImages(session:LabSession,group:Group,status:(text:string)=>void,signal?:AbortSignal,headers:Record<string,string>={}){
  const infos=group.trials.map(t=>session.frozen.assets.find(a=>a.asset_id===t.asset_id)!);if(infos.some(a=>!a))throw new Error('冻结资源清单不完整。');
  const unique=[...new Map(infos.map(a=>[a.hash,a])).values()];const estimated=unique.reduce((n,a)=>n+a.width*a.height*4,0),originalBytes=unique.reduce((n,a)=>n+a.bytes,0);
  if(estimated>session.frozen.protocol.budget.max_decoded_bytes)throw new Error('图片解码预算不足。');
  const bitmaps=new Map<string,ImageBitmap>(),controller=new AbortController(),started=performance.now();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(()=>controller.abort(new Error('本组准备超过 20 分钟，请检查网络或联系研究者。')),DOWNLOAD_POLICY.maximum_ms);
  let received=0,completed=0;
  try{
    // Serial download + decode bounds compressed working memory to one image and
    // avoids doubling every participant's competing stream on a shared 1–5 Mbps link.
    for(const info of unique){
      controller.signal.throwIfAborted();const prior=received;
      const report=(bytes:number)=>status(`准备图片 ${completed}/${unique.length} · ${((prior+bytes)/1024/1024).toFixed(2)}/${(originalBytes/1024/1024).toFixed(2)} MiB`);
      report(0);const data=await downloadOriginal(`/api/participate/sessions/${session.session_id}/assets/${info.asset_id}`,info.bytes,controller.signal,report,undefined,headers);
      const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');if(h!==info.hash)throw new Error('图片摘要不匹配。');
      controller.signal.throwIfAborted();
      const bitmap=await createImageBitmap(new Blob([data],{type:`image/${info.format}`}));
      if(controller.signal.aborted||bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();controller.signal.throwIfAborted();throw new Error('图片尺寸与冻结清单不符。');}
      bitmaps.set(info.hash,bitmap);received+=info.bytes;completed++;
    }
    controller.signal.throwIfAborted();status(`全部 ${unique.length} 张图片已准备。`);
    const byAsset=new Map(infos.map(a=>[a.asset_id,bitmaps.get(a.hash)!]));
    return {byAsset,hashes:Object.fromEntries(infos.map(a=>[a.asset_id,a.hash])),decoded_bytes:estimated,
      download:{original_bytes:originalBytes,downloaded_bytes:received,unique_images:unique.length,elapsed_ms:performance.now()-started,policy:'serial-stall60s-total20m-v1'},
      release:()=>{for(const image of bitmaps.values())image.close();bitmaps.clear();}};
  }catch(error){controller.abort(error);for(const image of bitmaps.values())image.close();throw error;}
  finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
}
