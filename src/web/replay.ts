import './style.css';
import {el,button,request} from './dom.js';
import {RequestError} from './request-error.js';
import type {PhotoIdentity} from '../shared/photo-identity.js';
import type {InteractionBatch} from '../shared/interaction.js';
import {replayBatch} from '../shared/replay-recording.js';
import {mountReplayPlayer,type ReplayItem} from './replay-player.js';
const sid=new URLSearchParams(location.search).get('session')??'',status=document.querySelector<HTMLElement>('#status')!,details=document.querySelector<HTMLElement>('#details')!,canvas=document.querySelector<HTMLCanvasElement>('#replay')!,controls=document.querySelector<HTMLElement>('#controls')!;
let dispose:(()=>void)|undefined;
async function load(){
  dispose?.();dispose=undefined;controls.replaceChildren();details.textContent='';canvas.hidden=true;status.textContent='正在读取回放记录…';
  const info=await request<{title:string;replayable:boolean;samples:number;photos?:PhotoIdentity[]}>(`/api/lab/sessions/${sid}/recording`);
  document.querySelector('h1')!.textContent=`${info.title} · 操作回放`;
  if(!info.replayable){status.textContent='此答卷没有可回放的界面记录。';return;}
  const items:ReplayItem[]=[];let after=0;
  for(;;){
    const result=await request<{batches:(InteractionBatch&{cursor:number})[];next:number;more:boolean}>(`/api/lab/sessions/${sid}/actions?after=${after}`);
    for(const b of result.batches)if(replayBatch(b))for(const sample of b.samples)items.push({time:b.time_origin+sample.at,sample});
    status.textContent=`正在读取回放记录… ${items.length.toLocaleString()} / ${info.samples.toLocaleString()}`;
    if(!result.more)break;if(result.next<=after)throw new Error('REPLAY_CURSOR_STALLED');after=result.next;
  }
  dispose=mountReplayPlayer({photos:info.photos,items,canvas,controls,status,details,assetURL:id=>`/api/lab/assets/${encodeURIComponent(id)}`});
  for(const [label,path]of [['下载本份轨迹 JSON.gz','trajectory.json.gz'],['下载离线回放 HTML','replay.html']]){const link=el('a',label);link.href=`/api/lab/sessions/${sid}/${path}`;link.download='';controls.append(link);}
}
async function reload(){try{await load();}catch(error){dispose?.();dispose=undefined;canvas.hidden=true;controls.replaceChildren();status.textContent=error instanceof RequestError&&error.status===401?'请登录研究管理后重新加载回放。':'回放记录未能加载，请重试。';details.textContent=error instanceof Error?error.message:String(error);const retry=button('重新加载',async()=>{retry.remove();await reload();});controls.append(retry);}}
window.addEventListener('pagehide',()=>dispose?.(),{once:true});void reload();
