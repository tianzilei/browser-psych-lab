import {mountReplayPlayer,type ReplayItem} from './replay-player.js';
import {replayBatch} from '../shared/replay-recording.js';
interface Evidence {hash:string;raw_utf8:string;canonical:number}
const status=document.querySelector<HTMLElement>('#status')!,canvas=document.querySelector<HTMLCanvasElement>('#replay')!,controls=document.querySelector<HTMLElement>('#controls')!,details=document.querySelector<HTMLElement>('#details')!;
async function load(){
  if(!globalThis.DecompressionStream||!globalThis.crypto?.subtle)throw new Error('请使用支持离线解压和 SHA-256 的新版 Chrome、Edge、Safari 或 Firefox。');
  const encoded=document.querySelector('#recording-data')!.textContent!.trim(),packed=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const payload=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as {schema:string;session_id:string;study_title:string;events:Evidence[];embedded_assets?:Record<string,{data_url:string;hash:string}>};
  if(payload.schema!=='session-trajectory-v1'||!Array.isArray(payload.events)||payload.events.length>100000)throw new Error('回放文件格式不正确。');
  document.querySelector('h1')!.textContent=`${payload.study_title} · 离线操作回放`;document.querySelector('#session')!.textContent=`答卷 ${payload.session_id}`;
  const items:ReplayItem[]=[],encoder=new TextEncoder();let checked=0;
  for(const event of payload.events){
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(event.raw_utf8))),b=>b.toString(16).padStart(2,'0')).join('');
    if(digest!==event.hash)throw new Error('原始轨迹哈希校验失败。');
    if(event.canonical){const e=JSON.parse(event.raw_utf8) as {payload?:{interaction?:unknown}},batch=e.payload?.interaction;if(replayBatch(batch))for(const sample of batch.samples)items.push({time:batch.time_origin+sample.at,sample});}
    if(++checked%32===0)status.textContent=`正在验证原始记录… ${checked} / ${payload.events.length}`;
  }
  const assets=payload.embedded_assets??{};
  for(const asset of Object.values(assets)){
    if(!/^data:image\/(png|jpeg|webp);base64,/.test(asset.data_url))throw new Error('图片格式不正确。');
    const bytes=Uint8Array.from(atob(asset.data_url.slice(asset.data_url.indexOf(',')+1)),c=>c.charCodeAt(0));
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(digest!==asset.hash)throw new Error('回放图片哈希校验失败。');
  }
  mountReplayPlayer({items,canvas,controls,status,details,assetURL:id=>assets[id]?.data_url??''});
}
void load().catch(error=>{canvas.hidden=true;status.textContent='离线回放未能打开。';details.textContent=error instanceof Error?error.message:String(error);});
