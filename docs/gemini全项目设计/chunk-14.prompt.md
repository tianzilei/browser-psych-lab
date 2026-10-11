全项目设计讨论，传输段 14，源码主题：研究和参加者事务（源包 5/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      const old = this.get<StoredEvent>('SELECT * FROM lab_events WHERE session_id=? AND event_id=?',s.session_id,e.event_id);
      const receipt = randomUUID(); this.run('INSERT INTO lab_raw VALUES (?,?,?,?,?,?,?)',s.session_id,e.event_id,ref.hash,e.scope,receipt,raw,this.now());
      const [state,reason] = old ? ['QUARANTINED','EVENT_ID_HASH_CONFLICT'] as const : this.semantic(s,e);
      this.run('INSERT INTO lab_dispositions VALUES (?,?,?,?)',receipt,1,state,reason);
      if (!old) this.run('INSERT INTO lab_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',s.session_id,e.event_id,ref.hash,e.scope,e.sequence,e.writer_epoch,e.kind,text,state,1,reason);
      if (old || state==='QUARANTINED') this.diagnostic(s.session_id,old?.scope??e.scope,reason,ref);
    }
    for (const scope of new Set(items.map(i=>i.e.scope))) {
      const pending=this.all<StoredEvent>("SELECT * FROM lab_events WHERE session_id=? AND scope=? AND disposition='RECEIVED_PENDING' ORDER BY sequence LIMIT 5000",s.session_id,scope);
      for (const e of pending) {
        const [state,reason]=this.semantic(s,parseLabEvent(e.envelope));
        if (state===e.disposition && reason===e.reason) continue;
        const r=this.custody(s.session_id,e)!; this.run('INSERT INTO lab_dispositions VALUES (?,?,?,?)',r.receipt_id,e.version+1,state,reason);
        this.run('UPDATE lab_events SET disposition=?,version=?,reason=? WHERE session_id=? AND event_id=?',state,e.version+1,reason,s.session_id,e.event_id);
      }
    } return {receipts:items.map(i=>this.custody(s.session_id,i.ref))};
  }
  execute(c: Command): unknown {
    const started=performance.now(); const result=this.db.transaction(()=>{
      const value=this.dispatch(c); if(performance.now()-started>1000) throw new ContractError('TRANSACTION_BUDGET_EXCEEDED',503); return value;
    }).immediate(); if(result instanceof Rejection) throw result.error; return result;
  }
  expireTaskActivity(){
    return this.db.transaction(()=>{const expired=this.all<{session_id:string}>("SELECT a.session_id FROM lab_task_activity a JOIN lab_sessions s USING(session_id) WHERE a.last_seen<=? AND s.state='ACTIVE' AND a.writer_epoch=s.writer_epoch",this.now()-300000);
      for(const {session_id:sid} of expired){this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);this.run("UPDATE lab_permits SET state='CLOSED_UNKNOWN' WHERE session_id=? AND state='ISSUED'",sid);this.admission.ended(sid);this.diagnostic(sid,null,'CONNECTION_TIMEOUT',{timeout_ms:300000});}
      this.run("DELETE FROM lab_task_activity WHERE session_id IN (SELECT session_id FROM lab_sessions WHERE state IN ('COMPLETED','TERMINATED'))");return expired.length;
    }).immediate();
  }
  private dispatch(c: Command): unknown {
    const op=c.operation.slice(4); const d=object(c.data);
    if(op==='admin.issue') {
      this.run('DELETE FROM lab_admin_tokens WHERE expires_at<?',this.now());
      this.run('INSERT INTO lab_admin_tokens VALUES (?,?,?)',hash(d.token_hash),id(d.csrf),this.now()+8*3600000);
      this.audit(String(d.token_hash),'LOGIN','admin',{}); return {authenticated:true,csrf:d.csrf};
    }
    if(op==='version.public') return this.frozen(id(d.version_id));
    if(op==='questionnaires.public') {
      const rows=this.all<{version_id:string;title:string}>('SELECT v.version_id,s.title FROM lab_versions v JOIN lab_studies s ON s.study_id=v.study_id WHERE s.admission=\'OPEN\' AND v.rowid=(SELECT v2.rowid FROM lab_versions v2 WHERE v2.study_id=v.study_id ORDER BY v2.rowid DESC LIMIT 1) ORDER BY v.rowid DESC');
      return {questionnaires:rows.map(row=>({version_id:row.version_id,title:row.title}))};
    }
    if(op==='version.metadata'){const f=this.frozen(id(d.version_id));return {title:f.protocol.title,background:f.protocol.layout.background,orientation:f.protocol.layout.orientation??null};}
    if(op==='version.consent'){const {consent}=this.frozen(id(d.version_id)).protocol;return consent?{document:consent,document_hash:digest(stableJSON(consent))}:null;}
    if(op==='participant.create') return this.request(`admission-${id(d.version_id)}`,op,d,()=>{
      const frozen=this.frozen(id(d.version_id));
      const consentHash=frozen.protocol.consent?digest(stableJSON(frozen.protocol.consent)):null;
      if(consentHash){const c=d.consent===undefined?{}:object(d.consent);if(c.accepted!==true||c.document_hash!==consentHash||Object.keys(c).some(k=>!['accepted','document_hash'].includes(k)))throw new ContractError('CONSENT_REQUIRED',403);}
      else if(d.consent!==undefined)throw new ContractError('UNEXPECTED_CONSENT');
      if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',frozen.study_id)!.admission!=='OPEN') throw new ContractError('ADMISSION_PAUSED',409);
      if(frozen.protocol.mode==='COLLECTION' && this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value!=='OPEN') throw new ContractError('COLLECTION_GATE_CLOSED',409);
      if(frozen.protocol.mode==='COLLECTION'&&this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_environment'")?.value!==frozen.protocol.budget.environment_id)throw new ContractError('COLLECTION_ENVIRONMENT_MISMATCH',409);
      const sid=randomUUID(); this.run("INSERT INTO lab_sessions(session_id,study_id,version_id,admission_id,credential_hash,state,created_at) VALUES (?,?,?,?,?,'CREATED',?)",sid,frozen.study_id,frozen.version_id,randomUUID(),hash(d.credential_hash),this.now());
      if(consentHash)this.run('INSERT INTO lab_consents VALUES (?,?,?)',sid,consentHash,this.now());
      if(d.server_covariates){const raw=stableJSON(object(d.server_covariates));this.run('INSERT INTO lab_covariates VALUES (?,?,?,?,?,?)',sid,'server-open',digest(raw),raw,'server-observed',this.now());}
      return this.view(sid);
    });
    if(op.startsWith('participant.')) return this.participant(op,c,d);
    if(op.startsWith('internal.')) return this.internal(op,d);
    const admin=this.admin(c);
    const actor=admin.actor;
    switch(op) {
      case 'admin.me': return {authenticated:true,csrf:admin.csrf};
      case 'admin.logout': this.run('DELETE FROM lab_admin_tokens WHERE token_hash=?',actor); return {status:'LOGGED_OUT'};
      case 'study.list': return {studies:this.all('SELECT s.study_id,s.title,s.revision,s.admission,s.created_at,(SELECT version_id FROM lab_versions v WHERE v.study_id=s.study_id ORDER BY rowid DESC LIMIT 1) AS version_id FROM lab_studies s WHERE NOT EXISTS(SELECT 1 FROM lab_archived_studies a WHERE a.study_id=s.study_id) ORDER BY rowid DESC LIMIT 100')};
      case 'study.create': return this.request(actor,op,d,()=>{const sid=randomUUID();const p=sampleProtocol(); this.run("INSERT INTO lab_studies VALUES (?,?,?,1,'PAUSED',?)",sid,p.title,stableJSON(p),this.now());this.audit(actor,op,sid,{});return {study_id:sid,revision:1,draft:p};});
      case 'study.get': {
        const s=this.get<{study_id:string;title:string;draft:string;revision:number;admission:string}>('SELECT * FROM lab_studies WHERE study_id=?',id(d.study_id));
        if(!s) throw new ContractError('STUDY_NOT_FOUND',404);return {...s,draft:JSON.parse(s.draft),source:this.get<{source:string}>('SELECT source FROM lab_questionnaire_sources WHERE study_id=?',s.study_id)?.source??null,versions:this.all('SELECT version_id,hash,runner_hash,created_at FROM lab_versions WHERE study_id=? ORDER BY rowid DESC',s.study_id)};
      }
      case 'study.import':return this.request(actor,op,d,()=>{
        this.barrier();const sid=id(d.study_id),s=this.get<{revision:number}>('SELECT revision FROM lab_studies WHERE study_id=?',sid);
        if(!s||s.revision!==d.revision||this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',sid))throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        if(typeof d.source!=='string')throw new ContractError('JSON_REQUIRED');
        const p=compileQuestionnaire(parseQuestionnaireText(d.source),ref=>{
          const a=this.get<{asset_id:string}>("SELECT p.asset_id FROM lab_package_images p JOIN lab_assets a USING(asset_id) WHERE p.study_id=? AND p.name=? AND p.path=? AND a.state='READY'",sid,ref.package,ref.path);
          if(!a)throw new ContractError('IMAGE_PACKAGE_REFERENCE_MISSING',409,ref);return a.asset_id;
        });
        this.validateAssets(sid,p);
        if(p.mode==='COLLECTION'&&(p.budget.environment_id==='TEST_ONLY'||!this.get('SELECT 1 FROM lab_environments WHERE environment_id=?',p.budget.environment_id)))throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        this.run('UPDATE lab_studies SET title=?,draft=?,revision=revision+1 WHERE study_id=?',p.title,stableJSON(p),sid);
        this.run('INSERT INTO lab_questionnaire_sources VALUES (?,?) ON CONFLICT(study_id) DO UPDATE SET source=excluded.source',sid,d.source);
        this.run("DELETE FROM lab_asset_refs WHERE kind='DRAFT' AND owner=?",sid);
        const assets=new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))),vid=randomUUID(),h=digest(stableJSON(p));
        this.run('INSERT INTO lab_versions VALUES (?,?,?,?,?,?,?)',vid,sid,h,stableJSON(p),this.runnerHash,RUNNER_VERSION,this.now());
        for(const asset of assets){this.run("INSERT INTO lab_asset_refs VALUES (?,'DRAFT',?)",asset,sid);this.run("INSERT INTO lab_asset_refs VALUES (?,'VERSION',?)",asset,vid);}
        this.audit(actor,op,sid,{version_id:vid,hash:h,revision:s.revision+1});return {revision:s.revision+1,frozen:this.frozen(vid)};
      });
      case 'study.delete':return this.request(actor,op,d,()=>{const sid=id(d.study_id);if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);this.run('INSERT OR IGNORE INTO lab_archived_studies VALUES (?,?)',sid,this.now());this.run("UPDATE lab_studies SET admission='PAUSED' WHERE study_id=?",sid);this.audit(actor,op,sid,{data_retained:true});return {status:'DELETED',data_retained:true};});
      case 'package.begin':return this.request(actor,op,d,()=>{this.barrier();const sid=id(d.study_id),name=packageName(d.name);
        if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid)||this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);
        if(this.get('SELECT 1 FROM lab_packages WHERE study_id=? AND name=?',sid,name))throw new ContractError('PACKAGE_NAME_EXISTS',409);
        return this.beginJob(id(d.job_id),'PACKAGE',sid,{study_id:sid,name,package_id:id(d.job_id)},actor);
      });
      case 'study.save': return this.request(actor,op,d,()=>{
        this.barrier();const sid=id(d.study_id); const p=parseProtocol(d.protocol); const revision=integer(d.revision,1);
        this.validateAssets(sid,p);const update=this.run('UPDATE lab_studies SET title=?,draft=?,revision=revision+1 WHERE study_id=? AND revision=?',p.title,stableJSON(p),sid,revision);
        if(!update.changes) throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        this.run("DELETE FROM lab_asset_refs WHERE kind='DRAFT' AND owner=?",sid);
        for(const asset of new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[])))) this.run("INSERT INTO lab_asset_refs VALUES (?,'DRAFT',?)",asset,sid);
        this.audit(actor,op,sid,{revision:revision+1});return {study_id:sid,revision:revision+1,draft:p};
      });
      case 'study.publish': return this.request(actor,op,d,()=>{
        this.barrier();const s=this.get<{draft:string;revision:number}>('SELECT * FROM lab_studies WHERE study_id=?',id(d.study_id));
        if(!s || s.revision!==d.revision) throw new ContractError('DRAFT_REVISION_CONFLICT',409);
        const p=parseProtocol(JSON.parse(s.draft));this.validateAssets(id(d.study_id),p);
        for(const page of p.pages)for(const q of page.questions)if(q.type==='text'&&q.input_purpose!=='personal')throw new ContractError('PERSONAL_INPUT_ONLY',409,{question:q.id});
        for(const page of p.pages)for(const q of page.questions)if(q.type==='scale'&&(!q.min_label?.trim()||!q.max_label?.trim()))throw new ContractError('SCALE_ENDPOINTS_REQUIRED',409,{question:q.id});
        if(p.mode==='COLLECTION' && (p.budget.environment_id==='TEST_ONLY'||!this.get('SELECT 1 FROM lab_environments WHERE environment_id=?',p.budget.environment_id))) throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        const vid=randomUUID();const h=digest(stableJSON(p)); this.run('INSERT INTO lab_versions VALUES (?,?,?,?,?,?,?)',vid,d.study_id,h,stableJSON(p),this.runnerHash,RUNNER_VERSION,this.now());
        for(const asset of new Set(p.groups.flatMap(g=>g.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))))this.run("INSERT INTO lab_asset_refs VALUES (?,'VERSION',?)",asset,vid);
        this.audit(actor,op,vid,{hash:h});return this.frozen(vid);
      });
      case 'study.admission': return this.request(actor,op,d,()=>{
        if(typeof d.paused!=='boolean') throw new ContractError('INVALID_ADMISSION_STATE');
        if(this.get('SELECT 1 FROM lab_archived_studies WHERE study_id=?',id(d.study_id)))throw new ContractError('STUDY_DELETED',409);
        this.run('UPDATE lab_studies SET admission=? WHERE study_id=?',d.paused?'PAUSED':'OPEN',id(d.study_id));this.audit(actor,op,String(d.study_id),{paused:d.paused});return {status:d.paused?'PAUSED':'OPEN'};
      });
      case 'asset.list': return {assets:this.all('SELECT asset_id,name,state,hash,bytes,width,height,format FROM lab_assets WHERE study_id=? ORDER BY rowid DESC LIMIT 200',id(d.study_id))};
      case 'asset.begin': return this.request(actor,op,d,()=>{
        this.barrier(); const sid=id(d.study_id);if(!this.get('SELECT 1 FROM lab_studies WHERE study_id=?',sid))throw new ContractError('STUDY_NOT_FOUND',404);
        if(typeof d.name!=='string'||d.name.length>200)throw new ContractError('INVALID_ASSET_NAME');