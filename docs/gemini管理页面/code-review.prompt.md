本轮管理页面已实现，下面是关键实际代码节选。请做一轮紧凑工程审阅，只依据提供代码与说明，不做网络检索；最多列3个确实有工程影响的边界问题，不要重复基础建议，不要把省略片段判断成缺失。若没有阻断问题请明确说明，最后写 ADMIN_MANAGEMENT_CODE_REVIEW_COMPLETE。
实施说明：用新增 lab_study_order(study_id PK FK,position INTEGER NOT NULL) 独立表兼容旧 lab_studies INSERT 合同，构造函数一次补齐按原 rowid DESC 顺序；创建新问卷追加末尾；修改顺序全量原子校验，隐藏/重新公开保持顺序，公开列表也 JOIN 此表按 position 排序且排除软删除。rename只改索引title并revision+1，协议/源JSON/版本不改；UI明确显示原作答标题，冲突保留输入，可刷新revision再提交。
CSV EXPORT 维持既有同一 db BEGIN 读取快照，既有data.csv(table,data_json)完全保留；增加answers.csv与trajectories.csv，行标识snapshot_id，utf8 BOM，独立hash/bytes/rows/columns写manifest；文件写入fd由try/finally关闭，已fsync/目录sync后作业才READY。data.csv的原始JSON不做字符串公式净化，JSON起始字符安全，两个扁平CSV字符串字段净化但负数数值保持负数，answer_json/payload_json存原值。
样本实际字段为at，不是time_ms；UI用time_origin+at；GROUP_RECORD可能没有time_origin，保留空白和clock_epoch/clock_origin，不伪造时间。不完整答卷按既有封存快照规则UNCONFIRMED/NOT_REACHED空值；多轴逐轴行。所有诊断记录带disposition/reason，不将历史/隔离事件误当有效实验数据。下面代码省略了raw表和derived question_states/trial_results等旧逻辑；invalidInteractionBatch的完整payload会作为diagnostic行输出。私有下载桶白名单新加入answers.csv、trajectories.csv，原管理cookie鉴权保留。
界面：卡片主按钮 修改名称/上移/下移/隐藏公开 + 导出问卷结果/导出轨迹/下载完整数据/查看答卷回放；JSON操作折叠，小屏两列≥44px。浏览器已验证真实API改名、排序刷新、公开列表、冲突输入保留、导出歧义回应刷新复用job_id；测试已核对多轴零与负数、公式/中文/多行CSV、隔离轨迹、manifest哈希、私有下载拒绝访客和真实图片GROUP_RECORD导出。完整回归进行中。

代码：
// Human-readable CSVs are separate from the exact evidence cells in data.csv.
export function csvCell(value:unknown):string {
  if(value===null||value===undefined)return '""';
  let text=String(value);
  // Preserve numeric negatives; escape untrusted text that spreadsheets interpret as formulas.
  if(typeof value==='string'&&(/^[\t\r\n]/.test(text)||/^[\s\uFEFF]*[=+\-@]/.test(text)))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export const answerColumns=['snapshot_id','study_id','study_title','session_id','version_id','protocol_title','session_state','session_created_at','page_id','question_id','question_title','question_type','axis_id','axis_title','answer_state','answer_numeric','answer_text','answer_json','scale_label'] as const;
export const trajectoryColumns=['snapshot_id','study_id','session_id','version_id','session_state','event_id','scope','sequence','sample_index','writer_epoch','clock_epoch','event_kind','disposition','reason','received_at','event_time_ms','time_origin','clock_origin','at','event_type','page_id','question_id','target','x','y','key','code','value','payload_json'] as const;
export function csvRow(columns:readonly string[],row:Record<string,unknown>):string {
  return columns.map(key=>csvCell(row[key])).join(',')+'\r\n';
}
      this.run('INSERT INTO lab_admin_tokens_new SELECT token_hash,csrf,expires_at FROM lab_admin_tokens WHERE expires_at>=?',now());
      db.exec('DROP TABLE lab_admin_tokens; ALTER TABLE lab_admin_tokens_new RENAME TO lab_admin_tokens');
    }).immediate();
    // Seed legacy installations once, retaining their existing admin list order.
    db.transaction(()=>{
      let position=this.get<{n:number}>('SELECT coalesce(max(position),-1)+1 AS n FROM lab_study_order')!.n;
      for(const row of this.all<{study_id:string}>('SELECT study_id FROM lab_studies WHERE study_id NOT IN (SELECT study_id FROM lab_study_order) ORDER BY rowid DESC'))
        this.run('INSERT INTO lab_study_order VALUES (?,?)',row.study_id,position++);
    }).immediate();
    this.admission=new SessionAdmission(db,sessionConcurrency,now);
  }
  get<T>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
      case 'study.list': return {studies:this.all('SELECT s.study_id,s.title,s.revision,s.admission,s.created_at,o.position,(SELECT version_id FROM lab_versions v WHERE v.study_id=s.study_id ORDER BY rowid DESC LIMIT 1) AS version_id,(SELECT json_extract(protocol,\'$.title\') FROM lab_versions v WHERE v.study_id=s.study_id ORDER BY rowid DESC LIMIT 1) AS protocol_title FROM lab_studies s JOIN lab_study_order o USING(study_id) WHERE NOT EXISTS(SELECT 1 FROM lab_archived_studies a WHERE a.study_id=s.study_id) ORDER BY o.position,s.rowid DESC')};
      case 'study.create': return this.request(actor,op,d,()=>{const sid=randomUUID();const p=sampleProtocol(); this.run("INSERT INTO lab_studies VALUES (?,?,?,1,'PAUSED',?)",sid,p.title,stableJSON(p),this.now());this.run('INSERT INTO lab_study_order SELECT ?,coalesce(max(position),-1)+1 FROM lab_study_order',sid);this.audit(actor,op,sid,{});return {study_id:sid,revision:1,draft:p};});
      case 'study.rename':return this.request(actor,op,d,()=>{
        const sid=id(d.study_id),revision=integer(d.revision,1);
        if(typeof d.title!=='string'||!d.title.trim()||d.title.trim().length>200)throw new ContractError('INVALID_STUDY_TITLE');
        const title=d.title.trim(),s=this.get<{title:string}>('SELECT title FROM lab_studies WHERE study_id=?',sid);
        if(!s||this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);
        const update=this.run('UPDATE lab_studies SET title=?,revision=revision+1 WHERE study_id=? AND revision=?',title,sid,revision);
        if(!update.changes)throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        this.audit(actor,op,sid,{before:s.title,title,revision:revision+1});return {study_id:sid,title,revision:revision+1};
      });
      case 'study.reorder':return this.request(actor,op,d,()=>{
        if(!Array.isArray(d.order)||!Array.isArray(d.expected_order)||d.order.length>10000)throw new ContractError('INVALID_STUDY_ORDER');
        const order=d.order.map(value=>id(value)),expected=d.expected_order.map(value=>id(value));
        const current=this.all<{study_id:string}>('SELECT s.study_id FROM lab_studies s JOIN lab_study_order o USING(study_id) WHERE NOT EXISTS(SELECT 1 FROM lab_archived_studies a WHERE a.study_id=s.study_id) ORDER BY o.position,s.rowid DESC').map(row=>row.study_id);
        if(stableJSON(current)!==stableJSON(expected))throw new ContractError('STUDY_ORDER_CONFLICT',409);
        const ids=new Set(current);if(order.length!==current.length||new Set(order).size!==order.length||order.some(sid=>!ids.has(sid)))throw new ContractError('INVALID_STUDY_ORDER');
        for(const [position,sid]of order.entries())this.run('UPDATE lab_study_order SET position=? WHERE study_id=?',position,sid);
        this.audit(actor,op,'studies',{before:current,order});return {order};
      });
      case 'study.get': {
        const s=this.get<{study_id:string;title:string;draft:string;revision:number;admission:string}>('SELECT * FROM lab_studies WHERE study_id=?',id(d.study_id));
        if(!s) throw new ContractError('STUDY_NOT_FOUND',404);return {...s,draft:JSON.parse(s.draft),source:this.get<{source:string}>('SELECT source FROM lab_questionnaire_sources WHERE study_id=?',s.study_id)?.source??null,versions:this.all('SELECT version_id,hash,runner_hash,created_at FROM lab_versions WHERE study_id=? ORDER BY rowid DESC',s.study_id)};
    if(config.kind==='EXPORT'){
      const sid=id(config.config.study_id);const target=await privateRoot(join(config.root,'research-exports',config.job));
      const output=join(target,'data.csv');const fd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      const descriptors=[fd],files:Record<string,{rows:number;bytes:number;hash?:string;columns:readonly string[]}>={};
      const snapshot=randomUUID(),started=Date.now(),source=createHash('sha256');let bytes=0,totalBytes=0,rows=0,flatRows=0;const tables:Record<string,number>={};
      const cell=(x:string)=>`"${x.replaceAll('"','""')}"`;
      const charge=(text:string)=>{totalBytes+=Buffer.byteLength(text);if(totalBytes>100*1024*1024||Date.now()-started>30000)throw new Error('EXPORT_BUDGET_EXCEEDED');};
      const emit=(text:string)=>{charge(text);bytes+=Buffer.byteLength(text);writeSync(fd,text);};
      const flatFile=(name:string,columns:readonly string[])=>{
        const descriptor=openSync(join(target,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);descriptors.push(descriptor);
        const info=files[name]={rows:0,bytes:0,columns},header='\uFEFF'+columns.join(',')+'\r\n';charge(header);info.bytes+=Buffer.byteLength(header);writeSync(descriptor,header);
        return (row:Record<string,unknown>)=>{if(++flatRows+rows>200000)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');const text=csvRow(columns,row);charge(text);info.bytes+=Buffer.byteLength(text);info.rows++;writeSync(descriptor,text);};
      };
      try{
        const answerRow=flatFile('answers.csv',answerColumns),trajectoryRow=flatFile('trajectories.csv',trajectoryColumns);
        db.exec('BEGIN');const study=db.prepare('SELECT study_id,title FROM lab_studies WHERE study_id=?').get(sid) as {study_id:string;title:string}|undefined;if(!study)throw new Error('STUDY_NOT_FOUND');
        const actualReadAt=new Date().toISOString();
        emit('table,data_json\r\n');
        for(const row of db.prepare("SELECT e.envelope,e.disposition,e.reason,r.received_at,s.state FROM lab_events e JOIN lab_sessions s USING(session_id) JOIN lab_raw r USING(session_id,event_id,hash) WHERE s.study_id=? AND e.kind IN ('INPUT_DIAGNOSTIC','GROUP_RECORD') ORDER BY s.rowid,e.scope,e.sequence,e.rowid").iterate(sid) as Iterable<{envelope:string;disposition:string;reason:string;received_at:number;state:string}>){
          const event=parseLabEvent(row.envelope),common={snapshot_id:snapshot,study_id:sid,session_id:event.session_id,version_id:event.version_id,session_state:row.state,event_id:event.event_id,scope:event.scope,sequence:event.sequence,writer_epoch:event.writer_epoch,clock_epoch:event.clock_epoch,event_kind:event.kind,disposition:row.disposition,reason:row.reason,received_at:row.received_at,event_time_ms:event.time_ms};
          const interaction=event.payload.interaction;
          if(validInteractionBatch(interaction)){
            for(const [index,item]of interaction.samples.entries()){
              const sample=object(item),context=sample.context&&!Array.isArray(sample.context)?object(sample.context):{};
              trajectoryRow({...common,sample_index:index,time_origin:interaction.time_origin,at:sample.at,event_type:sample.type,page_id:context.page_id,question_id:context.question_id,target:sample.target,x:sample.x,y:sample.y,key:sample.key,code:sample.code,value:sample.value,payload_json:stableJSON(sample)});
            }
          }else if(event.kind==='GROUP_RECORD'&&event.payload.record&&typeof event.payload.record==='object'&&!Array.isArray(event.payload.record)){
            const record=object(event.payload.record);trajectoryRow({...common,sample_index:0,time_origin:record.time_origin,clock_origin:record.clock_origin,at:record.at,event_type:record.type,x:record.x,y:record.y,code:record.key_code,value:record.answer??record.choice,payload_json:stableJSON(record)});
          }else trajectoryRow({...common,sample_index:0,event_type:'diagnostic',payload_json:stableJSON(event.payload)});
        }
        for(const session of db.prepare('SELECT s.session_id,s.version_id,s.state,s.created_at,s.page_index,s.path,v.protocol FROM lab_sessions s JOIN lab_versions v USING(version_id) WHERE s.study_id=?').iterate(sid) as Iterable<{session_id:string;version_id:string;state:string;created_at:number;page_index:number;path:string;protocol:string}>){
          const protocol=JSON.parse(session.protocol) as Protocol,path=JSON.parse(session.path) as string[],answers:Record<string,Answer>={},states:Record<string,unknown>={};
          for(const [index,page]of protocol.pages.entries()){
            if(path.includes(page.id)){const event=db.prepare("SELECT envelope FROM lab_events WHERE session_id=? AND scope=? AND kind='PAGE_SNAPSHOT' AND disposition='ACCEPTED' ORDER BY sequence DESC LIMIT 1").get(session.session_id,page.id) as {envelope:string}|undefined;if(!event)throw new Error('EXPORTED_PAGE_EVIDENCE_MISSING');const snapshot=pageSnapshot(page,answers,object(parseLabEvent(event.envelope).payload.answers) as Record<string,Answer>);for(const [q,state]of Object.entries(snapshot)){states[q]={page_id:page.id,...state};answers[q]=state.answer;}}
            else if(index<session.page_index&&!evaluate(page.condition,answers)){for(const q of page.questions){states[q.id]={page_id:page.id,state:'SKIPPED',answer:null,reason:'PAGE_BRANCH'};answers[q.id]=null;}}
          }
          const json=stableJSON({session_id:session.session_id,states});emit(`${cell('question_states')},${cell(json)}\r\n`);source.update(`question_states\0${json}\n`);rows++;tables.question_states=(tables.question_states??0)+1;
          for(const page of protocol.pages)for(const q of page.questions){
            const parent=object(states[q.id]),common={snapshot_id:snapshot,study_id:sid,study_title:study.title,session_id:session.session_id,version_id:session.version_id,protocol_title:protocol.title,session_state:session.state,session_created_at:session.created_at,page_id:page.id,question_id:q.id,question_title:q.title,question_type:q.type};
            if(q.type==='scales'){
              const answer=parent.answer&&typeof parent.answer==='object'?object(parent.answer):{};
              for(const axis of q.axes!){const value=typeof answer[axis.id]==='number'?answer[axis.id] as number:null;
                answerRow({...common,axis_id:axis.id,axis_title:axis.title,answer_state:value!==null?'ANSWERED':['ANSWERED','UNANSWERED'].includes(String(parent.state))?'UNANSWERED':parent.state,answer_numeric:value,answer_json:stableJSON(value),scale_label:value===null?null:axis.labels[value-axis.min]});
              }
            }else{
              const value=parent.answer??null;answerRow({...common,answer_state:parent.state,answer_numeric:typeof value==='number'?value:null,answer_text:typeof value==='string'?value:Array.isArray(value)?stableJSON(value):null,answer_json:stableJSON(value),scale_label:q.type==='scale'&&typeof value==='number'?q.labels?.[value-q.min!]:null});
            }
          }
          for(const page of protocol.pages)for(const q of page.questions)if(q.type==='scales'){
            const parent=object(states[q.id]),answer=parent.answer&&typeof parent.answer==='object'?object(parent.answer):{};
            for(const axis of q.axes!){const value=typeof answer[axis.id]==='number'?answer[axis.id] as number:null;
  }finally{db.close();}
}
try{const result=await run();parentPort!.postMessage({result});}catch(error){parentPort!.postMessage({error:error instanceof Error?error.message:'MAINTENANCE_FAILED',validation_rejected:(error as {validation_rejected?:boolean})?.validation_rejected===true});}finally{parentPort!.close();}
function download(name:string,content:unknown){const url=URL.createObjectURL(new Blob([typeof content==='string'?content:JSON.stringify(content,null,2)],{type:'application/json'})),link=el('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
type ExportFile='data.csv'|'answers.csv'|'trajectories.csv';
interface ExportJob {state:string;kind?:string;study_id?:string;result?:string}
async function exportData(study:Study,downloads:HTMLElement,file:ExportFile='data.csv'){
  const key=`lab-export-${study.study_id}`;let pending:{request_id:string;job_id:string;study_id:string}|undefined;
  try{pending=JSON.parse(sessionStorage.getItem(key)??'null')??undefined;}catch{sessionStorage.removeItem(key);}
  const job:ExportJob=pending?await api<ExportJob>(`/api/lab/jobs/${pending.job_id}`).catch(error=>{if(error instanceof RequestError&&error.code==='JOB_NOT_FOUND')return {state:'UNKNOWN'};throw error;}):{state:'NEW'};
  if(job.kind&&(job.kind!=='EXPORT'||job.study_id!==study.study_id))throw new Error('导出作业与当前问卷不匹配，请刷新后重试。');
  if(job.state==='FAILED')pending=undefined;
  if(job.state==='RECOVERY_REQUIRED')throw new Error('导出未完成，请通过维护流程核查作业后重新下载。');
  if(job.state==='READY'&&file!=='data.csv'&&!JSON.parse(job.result??'{}').files?.[file])pending=undefined;
  const ready=job.state==='READY'&&pending!==undefined;
  pending??={request_id:uid(),job_id:uid(),study_id:study.study_id};sessionStorage.setItem(key,JSON.stringify(pending));
  if(!ready)await api('/api/lab/jobs/export',pending);
  sessionStorage.removeItem(key);downloads.replaceChildren();
  const labels:Record<ExportFile,string>={'data.csv':'下载完整数据 CSV','answers.csv':'下载问卷结果 CSV','trajectories.csv':'下载轨迹 CSV'};
  const links=new Map<ExportFile,HTMLAnchorElement>();
  for(const name of Object.keys(labels) as ExportFile[]){const link=el('a',labels[name]);link.href=`/api/lab/jobs/${pending.job_id}/${name}`;link.download=name;links.set(name,link);downloads.append(link);}
  const manifest=el('a','下载导出说明');manifest.href=`/api/lab/jobs/${pending.job_id}/manifest.json`;manifest.download='manifest.json';downloads.append(manifest);links.get(file)!.click();
}
function simulate(protocol:Protocol){const overlay=el('div',undefined,'simulation-overlay'),frame=el('iframe');frame.title='模拟问卷';frame.src='/simulate.html';frame.onload=()=>frame.contentWindow?.postMessage({type:'lab-simulation',protocol},location.origin);overlay.append(button('关闭模拟',()=>overlay.remove()),frame);document.body.append(overlay);}
function login(){
  app.replaceChildren();const section=el('section'),form=el('form'),password=field('密码','','password'),submit=el('button','登录');
  password.input.name='password';password.input.autocomplete='current-password';password.input.enterKeyHint='go';password.input.required=true;password.input.maxLength=256;password.input.autofocus=true;submit.type='submit';
