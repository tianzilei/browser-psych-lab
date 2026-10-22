import {el,button} from './dom.js';
import type {StorageUsage,ServerBackup} from '../shared/storage.js';

const capacity=(bytes:number)=>{
  const units=['B','KiB','MiB','GiB','TiB'];let value=bytes,index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++;}
  return `${value.toFixed(index?1:0)} ${units[index]}`;
};

export function mountStorageStatus(root:HTMLElement,read:(signal:AbortSignal)=>Promise<{storage:StorageUsage|null}>,readBackups:(signal:AbortSignal)=>Promise<{backups:ServerBackup[]}>){
  const card=el('section',undefined,'storage-card'),heading=el('div',undefined,'storage-heading');
  const percent=el('strong','—','storage-percent'),meter=el('meter'),detail=el('p','正在读取存储用量…','storage-detail'),status=el('p',undefined,'muted storage-update');
  meter.min=0;meter.max=100;meter.hidden=true;meter.setAttribute('aria-label','服务器存储使用率');status.setAttribute('role','status');
  let disposed=false,fetching=false,suspended=false,last:StorageUsage|undefined,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined,backupController:AbortController|undefined;
  const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN');
  const backupButton=button('下载服务器备份',loadBackups,'secondary'),panel=el('div',undefined,'backup-download-panel'),label=el('label'),choices=el('select'),download=el('a','下载所选备份'),backupStatus=el('p',undefined,'muted');
  panel.hidden=true;download.hidden=true;download.download='';backupStatus.setAttribute('role','status');label.append(el('span','选择已生成的服务器备份'),choices);panel.append(label,download,backupStatus);
  heading.append(el('h2','服务器存储'),percent,backupButton);
  card.append(heading,meter,detail,el('p','统计数据所在磁盘的全部占用，包含系统文件、问卷和同盘备份。','muted'),status,panel);root.replaceChildren(card);
  async function loadBackups(){
    backupController?.abort();backupController=new AbortController();panel.hidden=false;backupStatus.textContent='正在读取已生成的备份…';choices.disabled=true;download.hidden=true;
    try{
      const {backups}=await readBackups(backupController.signal);if(disposed)return;choices.replaceChildren();
      for(const backup of backups){const option=el('option',`${new Date(backup.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · ${capacity(backup.bytes)}`);option.value=backup.url;choices.append(option);}
      choices.disabled=!backups.length;backupStatus.textContent=backups.length?'完整备份文件已生成，可直接下载。':'暂无已生成的完整备份文件。';
      choices.onchange=()=>{download.href=choices.value;};if(backups.length){choices.onchange(new Event('change'));download.hidden=false;}
    }catch{if(!disposed)backupStatus.textContent='暂时无法读取备份列表，请点击“下载服务器备份”重试。';}
  }
  function schedule(){clearTimeout(timer);if(!disposed&&!suspended&&document.visibilityState==='visible')timer=setTimeout(()=>{void refresh();},60000);}
  async function refresh(){
    if(disposed||suspended||fetching||document.visibilityState!=='visible')return;
    clearTimeout(timer);fetching=true;controller=new AbortController();
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
      status.textContent=last?`更新失败，显示 ${time(last.sampled_at)} 的用量。稍后自动重试。`:'读取失败，稍后自动重试。';
    }finally{fetching=false;if(!disposed)schedule();}
  }
  function visibility(){
    if(document.visibilityState!=='visible'){clearTimeout(timer);return;}
    if(!last||Date.now()-last.sampled_at>=60000)void refresh();else schedule();
  }
  const hide=()=>{suspended=true;clearTimeout(timer);},show=()=>{suspended=false;visibility();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);void refresh();
  return ()=>{disposed=true;clearTimeout(timer);controller?.abort();backupController?.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);root.replaceChildren();};
}
