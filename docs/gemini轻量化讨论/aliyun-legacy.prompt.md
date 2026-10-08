继续项目代码审查，仅检查这次旧冻结运行器兼容改动。最多500中文字，指出真实的安全/取消/槽位释放/升级问题，无问题则明确说未发现；不要泛化调参，不需要外部搜索。结尾 LEGACY_ASSET_REVIEW_COMPLETE。
背景：新客户端已经采用单会话组前FIFO票据+串行图片下载。服务器2c4g Ubuntu26.04，1Mbps，队列concurrency默认1/capacity64，FULL/WAL单writer不变。不能修改旧冻结代码/协议。
本次：新构建先生成runner-contract.json(schema:runner-assets-v1,preparation_queue:true)，它作为canonical release.files成员参与runnerHash。服务端cookie/version资源引用鉴权后返回DB中该冻结版本runnerHash；若三个queue/writer headers都缺失，读取那个归档的release.json并验证runnerHash/files摘要，若没有canonical runner-contract.json，允许旧GET但等同加入同一个FIFO下载容量；如果有contract必须核对摘要/schema并拒绝无票据访问。部分header缺失不走legacy分支。能力缓存64项，归档内容不变；损坏/未知声明fail closed。旧客户端原20秒超时不能静默改变，所以旧GET服务端最多等18秒再503。新的组前排队另45min，不受这个legacy等待预算影响。
单writer升级集成测试：真正关闭旧writer，启动新writer再发布新版本，不改旧版本/资源引用；旧图片GET保留原字节，new缺票据409，cookie错误401，旧GET在modern占名额时只能等待。队列只有HTTP实际finish/close后释放stream，legacy同时释放ticket。新client仍检查currentgroup, fence, state; legacy保留原version级授权。raw/seals均未改。
代码：
import {join} from 'node:path';
import {digest} from './collection-store.js';
import {openPrivate} from './private-files.js';
export class RunnerAssetPolicy {
  private cache=new Map<string,'legacy'|'ticket'>();
  constructor(private root:string){}
  private async read(path:string,maxBytes:number){
    const file=await openPrivate(path);
    try{if((await file.stat()).size>maxBytes)throw new Error('RUNNER_POLICY_BUDGET_EXCEEDED');return await file.readFile();}
    finally{await file.close();}
  }
  async get(hash:string){
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('INVALID_RUNNER_IDENTITY');
    const cached=this.cache.get(hash);if(cached){this.cache.delete(hash);this.cache.set(hash,cached);return cached;}
    const directory=join(this.root,'research-assets','runners',hash);
    const release=JSON.parse((await this.read(join(directory,'release.json'),256*1024)).toString()) as {runnerHash:string;files:{path:string;hash:string}[]};
    if(release.runnerHash!==hash||!Array.isArray(release.files)||release.files.length>500||digest(JSON.stringify(release.files))!==hash)throw new Error('RUNNER_POLICY_IDENTITY_MISMATCH');
    const contracts=release.files.filter(f=>f.path==='runner-contract.json');if(contracts.length>1)throw new Error('INVALID_RUNNER_CONTRACT');
    let policy:'legacy'|'ticket'='legacy';
    if(contracts.length){const bytes=await this.read(join(directory,'runner-contract.json'),1024);
      if(digest(bytes)!==contracts[0]!.hash)throw new Error('RUNNER_CONTRACT_HASH_MISMATCH');
      const contract=JSON.parse(bytes.toString()) as {schema:string;preparation_queue:boolean};
      if(contract.schema!=='runner-assets-v1'||contract.preparation_queue!==true)throw new Error('UNSUPPORTED_RUNNER_CONTRACT');policy='ticket';
    }
    if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value!);this.cache.set(hash,policy);return policy;
  }
}
    if(info.state!=='READY')throw new ContractError('ASSET_NOT_READY',409);
    const headerless=['x-preparation-ticket','x-writer-id','x-writer-epoch'].every(h=>request.headers[h]===undefined);
    let stream:Readable|undefined,closed=false,done:(()=>void)|undefined;
    const connection=new AbortController();
    const cancel=()=>{closed=true;stream?.destroy();reply.raw.destroy();};
    const release=()=>{closed=true;connection.abort(new Error('ASSET_CONNECTION_CLOSED'));stream?.destroy();done?.();};
    reply.raw.once('finish',release);reply.raw.once('close',release);
    try{
      if(headerless){
        // Only archives predating the queue contract may use their original GET.
        // Their pending requests still share the global FIFO stream budget.
        if(await assetPolicy.get(info.runner_hash)!=='legacy')throw new ContractError('PREPARATION_TICKET_REQUIRED',409);
        done=await preparation.legacyTransfer(id((request.params as {session:string}).session),connection.signal,cancel);
      }else{
        const nonce=id(request.headers['x-preparation-ticket']);
        const ready=await participant(request,'preparation',{writer_id:id(request.headers['x-writer-id']),writer_epoch:Number(request.headers['x-writer-epoch'])}) as {key:string;asset_ids:string[]};
        if(!ready.asset_ids.includes(asset))throw new ContractError('ASSET_FORBIDDEN',403);
        done=preparation.transfer(ready.key,nonce,cancel);
      }
      const file=await openPrivate(await assetPath(root,asset));stream=file.createReadStream();
      if(closed||reply.raw.destroyed){stream.destroy();done();throw new ContractError('PREPARATION_TICKET_EXPIRED',409);}stream.once('error',release);
      reply.type(`image/${info.format}`).header('ETag',`"${info.hash}"`).header('Cache-Control','private, no-store, no-transform');return reply.send(stream);
    }catch(error){done?.();throw error;}
  });
  app.get('/runners/:hash/*',async(request,reply)=>{
    const params=request.params as {hash:string;'*':string};if(!/^[a-f0-9]{64}$/.test(params.hash)||!params['*']||params['*'].split('/').some(p=>!p||p==='..'||! /^[a-zA-Z0-9._-]+$/.test(p)))throw new ContractError('INVALID_RUNNER_OBJECT',404);
    const path=join(root,'research-assets','runners',params.hash,params['*']),suffix=params['*'].split('.').at(-1);
    reply.type(suffix==='js'?'text/javascript':suffix==='css'?'text/css':suffix==='html'?'text/html':'application/json');
    reply.header('Vary','Accept-Encoding').header('Cache-Control',suffix==='html'?'no-cache, no-transform':'public, max-age=31536000, immutable, no-transform');
    for(const encoding of runnerEncodings(request.headers['accept-encoding'])){
      if(encoding!=='identity'&&!/^assets\/.*\.(js|css)$/.test(params['*']))continue;
      try{const file=await openPrivate(encoding==='identity'?path:`${path}.${encoding==='br'?'br':'gz'}`);
        if(encoding!=='identity')reply.header('Content-Encoding',encoding);
        reply.header('Content-Length',(await file.stat()).size);return reply.send(file.createReadStream());
      }catch(error){if(encoding==='identity'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
      while(ticket.status!=='READY'){
        if(this.now()>=deadline)throw new ContractError('LEGACY_PREPARATION_BUSY',503);
        await new Promise<void>((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.min(200,Math.max(1,deadline-this.now())));
          signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });ticket=this.touch(key,nonce);
      }
      signal.throwIfAborted();const done=this.transfer(key,nonce,cancel);
      return ()=>{done();this.release(key,nonce);};
    }catch(error){this.release(key,nonce);throw error;}
  }
  stats(){this.sweep();return {active:this.tickets.filter(t=>t.started!==null).length,queued:this.tickets.filter(t=>t.started===null).length,streams:this.tickets.reduce((n,t)=>n+t.streams.size,0),limit:this.concurrency,capacity:64};}
  close(){for(const t of this.tickets){t.closing=true;for(const cancel of t.streams)cancel();}this.tickets=[];}
}
      return {...info as object,runner_hash:this.get<{runner_hash:string}>('SELECT runner_hash FROM lab_versions WHERE version_id=?',s.version_id)!.runner_hash};
    }
    return this.request(sid,op,d,()=>{
      const p=this.frozen(s.version_id).protocol;
      if(op==='participant.terminate') {
        if(s.state==='COMPLETED')throw new ContractError('SESSION_TERMINAL',409);

