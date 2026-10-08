请作为代码审查协作者，审查一个已经实现并通过 34 单元/故障测试和 15 Chromium 测试的浏览器心理实验平台。请用中文提供按优先级排列的具体代码修正建议，不要泛泛介绍架构。用户希望继续实现，服务器是阿里云 ECS：系统盘 IOPS 2120，吞吐 106.0 MB/s，公网出带宽可选 1–5 Mbps，已确认 2 vCPU / 4GB RAM / Ubuntu 26.04。目标最多 20 会话混合采集，但尚未在此主机验收。
约束：单应用/单 SQLite writer worker，WAL + synchronous FULL 不可降级；原始事件严格落盘才返回 custody ACK；每组试次期间完全没有网络请求，组前图片按冻结 SHA-256/尺寸核验并全部解码，组后补传/重放；私有图片原字节不可压缩转码；有限队列和维护 worker；不得猜测 IOPS 能换算为 fsync 延迟；正式采集 gate 仍关闭。
重点请检查：
1. 当前准备下载固定 20 秒超时在共享低带宽上是否错误，给出有上限的分段下载/进度/取消处理方案，避免组内下载以及低带宽误终止。
2. 内容寻址私有原图能否在准备阶段复用且保持鉴权/版本/摘要/预算。隐私/浏览器配额限制；第一版是否只做会话内内存缓存更稳。
3. frozen runner 原代码已归档但预压缩 .gz/.br 没有归档，如何保留 code hash 身份且把归档压缩变体可靠验证，Accept-Encoding(q=0)、Vary/no-transform、旧发行兼容、备份恢复如何处理。
4. 保持 FULL 的前提下减少无谓 fsync/读写/维护 contention；最小改动优先。现有单重维护作业，REPLAY 也共用，混合20会话有503需要重试。指出真正有证据的 bug 和改进，勿引入新的数据库/消息队列。
5. 给用户一个 1/2/3/4/5 Mbps 出带宽选择表与计算方法（20人各下载1MiB或5MiB，理想下限及工程余量），建议写入部署文档的参数；不把磁盘标称吞吐或本机 M4 测量当成主机容量结论。

当前prepare.ts:
import {openDB,deleteDB} from 'idb';
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
export async function prepareImages(session:LabSession,group:Group,status:(text:string)=>void){
  const infos=group.trials.map(t=>session.frozen.assets.find(a=>a.asset_id===t.asset_id)!);if(infos.some(a=>!a))throw new Error('冻结资源清单不完整。');
  const unique=[...new Map(infos.map(a=>[a.hash,a])).values()];const estimated=unique.reduce((n,a)=>n+a.width*a.height*4,0);
  if(estimated>session.frozen.protocol.budget.max_decoded_bytes)throw new Error('图片解码预算不足。');
  const bitmaps=new Map<string,ImageBitmap>();let index=0,completed=0;let decoding:Promise<unknown>=Promise.resolve();
  async function worker(){while(index<unique.length){const info=unique[index++]!;status(`准备图片 ${completed}/${unique.length}`);
    const response=await fetch(`/api/participate/sessions/${session.session_id}/assets/${info.asset_id}`,{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('图片下载失败，可重试准备。');
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let length=0;
    for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>info.bytes){await reader.cancel();throw new Error('图片字节数超出清单。');}chunks.push(part.value);}
    if(length!==info.bytes)throw new Error('图片未完整下载。');const data=new Uint8Array(length);let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}
    const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');if(h!==info.hash)throw new Error('图片摘要不匹配。');
    const decoded=decoding.then(async()=>{const bitmap=await createImageBitmap(new Blob([data],{type:`image/${info.format}`}));if(bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();throw new Error('图片尺寸与冻结清单不符。');}bitmaps.set(info.hash,bitmap);});decoding=decoded.catch(()=>{});await decoded;completed++;
  }}
  try{const outcomes=await Promise.allSettled([worker(),worker()]);const failure=outcomes.find(o=>o.status==='rejected');if(failure?.status==='rejected')throw failure.reason;status(`全部 ${unique.length} 张图片已准备。`);const byAsset=new Map(infos.map(a=>[a.asset_id,bitmaps.get(a.hash)!]));return {byAsset,hashes:Object.fromEntries(infos.map(a=>[a.asset_id,a.hash])),decoded_bytes:estimated,release:()=>{for(const image of bitmaps.values())image.close();bitmaps.clear();}};}
  catch(error){for(const image of bitmaps.values())image.close();throw error;}
}

release.ts:
import {readFile,mkdir,copyFile,link,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from './collection-store.js';
import {privateRoot,fileHash,syncDirectory,writeDurable,openPrivate} from './private-files.js';
export async function retainRelease(root:string) {
  const dist=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../dist/':'../',import.meta.url));let release:{runnerHash:string;runnerVersion:string;files:{path:string;hash:string}[]};
  try{release=JSON.parse(await readFile(join(dist,'release.json'),'utf8')) as typeof release;}
  catch(error){if(process.env.NODE_ENV==='production')throw error;return digest('TEST_ONLY-development');}
  if(!/^[a-f0-9]{64}$/.test(release.runnerHash)||digest(JSON.stringify(release.files))!==release.runnerHash)throw new Error('INVALID_RELEASE_MANIFEST');
  const destination=await privateRoot(join(root,'research-assets','runners',release.runnerHash));
  for(const file of release.files){if(!/^[a-zA-Z0-9._/-]+$/.test(file.path)||file.path.split('/').some(x=>x==='..'||!x))throw new Error('INVALID_RELEASE_PATH');
    const source=join(dist,'web',file.path),target=join(destination,file.path);if(await fileHash(source)!==file.hash)throw new Error('BUILD_ARTIFACT_HASH_MISMATCH');
    await mkdir(dirname(target),{recursive:true,mode:0o700});const temp=join(dirname(target),`.tmp-${randomUUID()}`);await copyFile(source,temp);
    const copied=await openPrivate(temp);try{await copied.sync();}finally{await copied.close();}
    try{await link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await fileHash(target)!==file.hash)throw error;}finally{await unlink(temp);}
    await syncDirectory(dirname(target));
  }
  const manifest=join(destination,'release.json');try{await writeDurable(manifest,JSON.stringify(release));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  return release.runnerHash;
}

其他事实：build脚本precompress在dist/web/assets生成js/css .gz和.br，release脚本只扫描原文件排除gz/br，因此归档不含压缩。路由/runners/:hash/*直接openPrivate返回stream，没有Accept-Encoding协商。backup从目的库引用runnerHash后验证release.files原文件与runnerHash，随后copyTree归档目录所有文件到backup并记录各hash；restore验证backup所有文件hash后复制。PUBLIC assets Fastify static preCompressed=true；nginx gzipoff，对API禁buffer和缓存。
SQLite写入短事务预算1s，队列32请求/2MiB，控制预留4，单worker每次一条RPC，group结束REPLAY也复用单Maintenance worker，最多120sec，busy503。客户端retry，离线事件IDB持久留存，数据ACK后删outbox。
请明确不确定性和本轮建议。
