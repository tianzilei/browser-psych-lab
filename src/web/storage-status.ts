import {el,button} from './dom.js';
import type {StorageUsage} from '../shared/storage.js';

const capacity=(bytes:number)=>{
  const units=['B','KiB','MiB','GiB','TiB'];let value=bytes,index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++;}
  return `${value.toFixed(index?1:0)} ${units[index]}`;
};

export function mountStorageStatus(root:HTMLElement,read:(signal:AbortSignal)=>Promise<{storage:StorageUsage|null}>){
  const card=el('section',undefined,'storage-card'),heading=el('div',undefined,'storage-heading');
  const percent=el('strong','—','storage-percent'),meter=el('meter'),detail=el('p','正在读取存储用量…','storage-detail'),status=el('p',undefined,'muted storage-update');
  meter.min=0;meter.max=100;meter.hidden=true;meter.setAttribute('aria-label','服务器存储使用率');status.setAttribute('role','status');
  let disposed=false,fetching=false,suspended=false,last:StorageUsage|undefined,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined;
  const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN');
  const refreshButton=button('刷新存储',refresh,'secondary');
  heading.append(el('h2','服务器存储'),percent,refreshButton);
  card.append(heading,meter,detail,el('p','统计数据所在磁盘的全部占用，包含系统文件、问卷和同盘备份。','muted'),status);root.replaceChildren(card);
  function schedule(){clearTimeout(timer);if(!disposed&&!suspended&&document.visibilityState==='visible')timer=setTimeout(()=>{void refresh();},60000);}
  async function refresh(){
    if(disposed||suspended||fetching||document.visibilityState!=='visible')return;
    clearTimeout(timer);fetching=true;refreshButton.disabled=true;controller=new AbortController();
    try{
      const {storage}=await read(controller.signal);if(disposed)return;
      if(!storage||![storage.total_bytes,storage.used_bytes,storage.available_bytes,storage.used_percent,storage.sampled_at].every(Number.isFinite)
        ||storage.total_bytes<=0||storage.used_bytes<0||storage.available_bytes<0||storage.used_percent<0||storage.used_percent>100)throw new Error('STORAGE_UNAVAILABLE');
      last=storage;percent.textContent=`${storage.used_percent.toFixed(1)}%`;meter.value=storage.used_percent;meter.hidden=false;
      detail.textContent=`已用 ${capacity(storage.used_bytes)} / 总量 ${capacity(storage.total_bytes)} · 可用 ${capacity(storage.available_bytes)}`;
      status.textContent=`更新于 ${time(storage.sampled_at)} · 每分钟自动更新`;
    }catch{
      if(disposed)return;
      if(!last)detail.textContent='暂时无法读取存储用量。';
      status.textContent=last?`更新失败，显示 ${time(last.sampled_at)} 的用量。可点击刷新存储重试。`:'读取失败，可点击刷新存储重试。';
    }finally{fetching=false;if(!disposed){refreshButton.disabled=false;schedule();}}
  }
  function visibility(){
    if(document.visibilityState!=='visible'){clearTimeout(timer);return;}
    if(!last||Date.now()-last.sampled_at>=60000)void refresh();else schedule();
  }
  const hide=()=>{suspended=true;clearTimeout(timer);},show=()=>{suspended=false;visibility();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);void refresh();
  return ()=>{disposed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);root.replaceChildren();};
}
