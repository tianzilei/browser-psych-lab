现已提供初版完整源码、5段实施差异。请最终静态复审，不再收源码或仅ACK。核查补丁本身是否引入新的交互/持久化缺陷，重点：固定任务准备 await 后 checkReady/AbortSignal、permitIssued 后终止、评分旧 range 的身份校验与捕获释放、诊断屏幕按完整 JSON UTF-8 字节累计≤75000且 nodes_truncated、seal 失败 catch remove()、同版本本地 Web Lock 内恢复持久 writer 身份而不重写原始事件。用户答案仍即时写，不防抖；原始交互输入均保留；快照DOM节点可以明确截断；方向门控维持现行持续模式；年龄 readonly/inputmode=none 不扩大忽略真实几何变化。
当前本机已有119项单元和完整12项运行器通过（包含新的滑块跨项/跨图片、年龄、键盘焦点、许可中布局变化、诊断预算、seal失败重试）。首次全检中双标签恢复真实失败定位为 writer_epoch 推进，已以持久身份修复；另一个管理员限流失败是前一测试失败造成 worker 重启后重新登录，不能修改生产限流；原 actions 测试的服务器接收顺序断言已改为完整原生点集及字段核验，生产 replay 原本就按事件时钟排序。最终 npm run check 将重新执行。这些是本机工程测试，不是正式采集/真实手机验收。持久身份迁移还补充了在严格 IDB 事务内重新读最新 metadata（避免旧快照覆盖）和删除 writer_id 的历史格式回归，最新源码片段附后。
如果存在具体阻塞，列出不超过3项及触发步骤；没有则直说未发现新增阻塞并保留静态审计边界。不要再泛化重构，不要搜索。最多1000中文字，末尾必须 INTERACTION_PATCH_REVIEW_DONE。
  private failure:unknown=null;
  private diagnosticCount=0;
  constructor(readonly db:IDBPDatabase<LedgerSchema>,readonly version:string,readonly writer:string,readonly clock=crypto.randomUUID()){}
  static async open(version:string,writer:string,resumeWriter=false){
    const db=await openDB<LedgerSchema>('browser-psych-lab-v1',1,{upgrade(db){const e=db.createObjectStore('events',{keyPath:'event_id'});e.createIndex('session','session_id');e.createIndex('scope','scope');const o=db.createObjectStore('outbox',{keyPath:'event_id'});o.createIndex('session','session_id');db.createObjectStore('meta');}});
    // Only resume an identity after acquiring this version's native Web Lock.
    // A new tab must not advance the epoch of still-pending original events.
    const prior=resumeWriter?await db.get('meta',version):undefined;
    return new Ledger(db,version,prior?.writer_id??prior?.session?.writer_id??writer);
  }
  async state(){
    let m=await this.db.get('meta',this.version);
    if(!m){
      m={version_id:this.version,request_id:crypto.randomUUID(),credential:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),session:null,writer_id:this.writer,heads:{},pending:{},finalize_id:crypto.randomUUID(),page_values:{}};
      await this.db.add('meta',m,this.version);
    }else if(!m.writer_id){
      const tx=this.db.transaction('meta','readwrite',{durability:'strict'});
      m=(await tx.store.get(this.version))!;m.writer_id??=this.writer;
      await tx.store.put(m,this.version);await tx.done;
    }
    return m;
  }
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=64){this.failure=new Error('LOCAL_QUEUE_BUDGET_EXCEEDED');return Promise.reject(this.failure);}this.queued++;const next=this.chain.then(fn).finally(()=>{this.queued--;});this.chain=next.catch(error=>{this.failure=error;});return next;}
  session(session:LabSession){return this.serialized(async()=>{const tx=this.db.transaction('meta','readwrite',{durability:'strict'});const m=(await tx.store.get(this.version))!;m.session=session;await tx.store.put(m,this.version);await tx.done;});}
});
test('a duplicate participant tab can retry after the original closes and restore durable answers',async({page,context})=>{
  const {version,study}=await setup(context);await page.goto(`/participate.html?version=${version.version_id}`);await begin(page);
  await page.getByRole('button',{name:'是',exact:true}).click();await expect.poll(async()=>(await local(page)).raw).toBeGreaterThan(0);
  const sid=(await (await context.request.get(`/api/lab/studies/${study.study_id}/sessions`)).json()).sessions[0].session_id;
  const original=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();
  // Legacy ledgers have no explicit writer_id metadata. Their saved session
  // still identifies the writer of the immutable pending answer chain.
  await page.evaluate(async version=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('browser-psych-lab-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta'),r=store.get(version);r.onsuccess=()=>{const row=r.result;delete row.writer_id;store.put(row,version);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}
  },version.version_id);
  const second=await context.newPage();
  await second.goto(`/participate.html?version=${version.version_id}`);await expect(second.locator('#status')).toContainText('只读');
  await expect(second.getByRole('button',{name:'重新尝试',exact:true})).toBeVisible();
  await second.getByRole('button',{name:'重新尝试',exact:true}).click();await expect(second.locator('#status')).toContainText('只读');
  await page.close();await second.getByRole('button',{name:'重新尝试',exact:true}).click();await begin(second);
  await expect(second.getByRole('button',{name:'是',exact:true})).toHaveAttribute('aria-pressed','true');
  await second.getByRole('button',{name:'提交本页'}).click();await expect(second.locator('#status')).toContainText('研究已完成');
  const restored=await (await context.request.get(`/api/lab/sessions/${sid}`)).json();
  expect(restored.writer_id).toBe(original.writer_id);expect(restored.writer_epoch).toBe(original.writer_epoch);
});
test('button wizard preserves branches, optional empty choice and numeric zero without scrolling',async({page,context})=>{
  const {version,study}=await setup(context,false,0,p=>{
    p.layout.background='#202020';p.pages[0]!.instruction='按钮作答';p.pages[0]!.questions=[

