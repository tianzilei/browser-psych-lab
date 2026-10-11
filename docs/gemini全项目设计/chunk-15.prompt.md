全项目设计讨论，传输段 15，源码主题：研究和参加者事务（源包 5/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

        const asset=randomUUID();this.run("INSERT INTO lab_assets(asset_id,study_id,name,state,upload_id,created_at) VALUES (?,?,?,'UPLOADING',?,?)",asset,sid,d.name,d.request_id,this.now());
        if(d.job_id)this.beginJob(id(d.job_id),'UPLOAD',sid,{asset_id:asset},actor);
        this.audit(actor,op,asset,{study_id:sid});return {asset_id:asset,state:'UPLOADING'};
      });
      case 'asset.delete': return this.request(actor,op,d,()=>{
        this.barrier();const asset=id(d.asset_id);
        if(this.get('SELECT 1 FROM lab_asset_refs WHERE asset_id=?',asset)||this.get('SELECT 1 FROM lab_pins WHERE asset_id=?',asset)) throw new ContractError('ASSET_REFERENCED',409);
        const a=this.get<{state:string}>('SELECT state FROM lab_assets WHERE asset_id=?',asset);if(!a)throw new ContractError('ASSET_NOT_FOUND',404);
        if(!['READY','FAILED','DELETING'].includes(a.state))throw new ContractError('ASSET_STATE_CONFLICT',409);
        this.run("UPDATE lab_assets SET state='DELETING' WHERE asset_id=?",asset);this.audit(actor,op,asset,{});return {asset_id:asset,status:'DELETING'};
      });
      case 'session.list':this.admission.stats();return {sessions:this.all('SELECT s.session_id,s.version_id,s.state,s.writer_epoch,q.status AS admission_status,s.page_index,s.group_index,s.created_at,(SELECT count(*) FROM lab_diagnostics d WHERE d.session_id=s.session_id) AS diagnostics,(SELECT max(received_at) FROM lab_raw r WHERE r.session_id=s.session_id) AS last_received FROM lab_sessions s LEFT JOIN lab_session_queue q USING(session_id) WHERE s.study_id=? ORDER BY s.rowid DESC LIMIT ? OFFSET ?',id(d.study_id),Math.min(100,Number(d.limit)||50),integer(d.offset??0))};
      case 'session.detail': {
        const sid=id(d.session_id);if(!this.get('SELECT 1 FROM lab_sessions WHERE session_id=?',sid))throw new ContractError('SESSION_NOT_FOUND',404);
        return {...this.view(sid),marks:this.all('SELECT * FROM lab_marks WHERE session_id=? ORDER BY created_at',sid),
          receipts:this.all('SELECT e.event_id,e.hash,e.scope,e.sequence,e.disposition,e.version,e.reason,r.receipt_id,r.received_at FROM lab_events e JOIN lab_raw r USING(session_id,event_id,hash) WHERE e.session_id=? ORDER BY e.scope,e.sequence LIMIT 5000',sid),
          diagnostic_evidence:this.all('SELECT code,scope,detail,created_at FROM lab_diagnostics WHERE session_id=? ORDER BY rowid',sid),covariates:this.all('SELECT * FROM lab_covariates WHERE session_id=? ORDER BY received_at',sid)};
      }
      case 'session.actions': {
        const sid=id(d.session_id),after=integer(Number(d.after??0));if(!this.get('SELECT 1 FROM lab_sessions WHERE session_id=?',sid))throw new ContractError('SESSION_NOT_FOUND',404);
        const rows=this.all<{cursor:number;envelope:string}>("SELECT rowid AS cursor,envelope FROM lab_events WHERE session_id=? AND kind='INPUT_DIAGNOSTIC' AND scope LIKE 'd-ui-%' AND rowid>? ORDER BY rowid LIMIT 20",sid,after);
        return {batches:rows.map(row=>({cursor:row.cursor,...object(parseLabEvent(row.envelope).payload.interaction)})),next:rows.at(-1)?.cursor??after,more:rows.length===20};
      }
      case 'session.mark': return this.request(actor,op,d,()=>{
        const mark=id(d.mark_id),revision=integer(d.revision,1); const prior=this.get<{n:number}>('SELECT coalesce(max(revision),0) AS n FROM lab_marks WHERE mark_id=?',mark)!.n;
        if(revision!==prior+1||typeof d.note!=='string'||d.note.length>2000||!['NOTE','REVIEW','EXCLUDE'].includes(String(d.type))||!['OPEN','CHECKED'].includes(String(d.status)))throw new ContractError('INVALID_MARK_REVISION');
        this.run('INSERT INTO lab_marks VALUES (?,?,?,?,?,?,?,?)',mark,revision,id(d.session_id),d.type,d.note,d.status,actor,this.now());return {mark_id:mark,revision};
      });
      case 'environment.list': return {environments:this.all('SELECT * FROM lab_environments ORDER BY created_at DESC')};
      case 'environment.put': return this.request(actor,op,d,()=>{
        const record=object(d.record);for(const k of ['hardware','filesystem','device_matrix','capacity_report','independent_restore_report','backup_target','rpo','rto','operator','verified_at'])
          if(typeof record[k]!=='string'||!(record[k] as string).trim())throw new ContractError('INCOMPLETE_ENVIRONMENT_RECORD');
        const env=id(d.environment_id);this.run('INSERT INTO lab_environments VALUES (?,?,?)',env,stableJSON(record),this.now());this.audit(actor,op,env,record);return {environment_id:env};
      });
      case 'gate.open': return this.request(actor,op,d,()=>{
        const env=this.get<{record:string}>('SELECT record FROM lab_environments WHERE environment_id=?',id(d.environment_id));
        if(!env||d.environment_id==='TEST_ONLY')throw new ContractError('ENVIRONMENT_NOT_VERIFIED',409);
        const record=object(JSON.parse(env.record));const backup=this.get<{result:string}>("SELECT result FROM lab_jobs WHERE kind='BACKUP' AND state='READY' AND job_id=?",id(record.backup_job_id));
        if(!backup||object(JSON.parse(backup.result)).independent!==true||record.restore_manifest_hash!==object(JSON.parse(backup.result)).manifest_hash||record.restore_verified!==true)throw new ContractError('INDEPENDENT_RESTORE_REQUIRED',409);
        this.run("INSERT INTO lab_meta VALUES ('collection_environment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(d.environment_id));this.run("UPDATE lab_meta SET value='OPEN' WHERE key='collection_gate'");this.audit(actor,op,String(d.environment_id),{});return {status:'OPEN'};
      });
      case 'gate.close':return this.request(actor,op,d,()=>{this.run("UPDATE lab_meta SET value='CLOSED' WHERE key='collection_gate'");this.audit(actor,op,'collection',{});return {status:'CLOSED'};});
      case 'job.list': return {jobs:this.all('SELECT * FROM lab_jobs ORDER BY created_at DESC LIMIT 100')};
      case 'job.get': return this.get('SELECT * FROM lab_jobs WHERE job_id=?',id(d.job_id))??{};
      case 'job.begin': return this.request(actor,op,d,()=>{if(d.kind==='REBUILD'){const study=id(d.study_id);if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',study)?.admission!=='PAUSED'||this.get("SELECT 1 FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND p.state='ISSUED'",study))throw new ContractError('REBUILD_REQUIRES_PAUSED_AND_IDLE',409);}return this.beginJob(id(d.job_id),String(d.kind),d.study_id? id(d.study_id):null,object(d.config??{}),actor);});
      case 'job.recover': return this.request(actor,op,d,()=>{
        const job=this.get<{state:string}>('SELECT state FROM lab_jobs WHERE job_id=?',id(d.job_id));
        if(!job||job.state!=='RECOVERY_REQUIRED'||typeof d.report!=='string'||!d.report.trim())throw new ContractError('RECOVERY_REPORT_REQUIRED');
        // Recovery only fails the old job; pins/barriers are released after the file audit route succeeds.
        this.audit(actor,'RECOVERY_REVIEW',String(d.job_id),{report:d.report});return {job_id:d.job_id,status:'RECOVERY_REVIEW',report:d.report};
      });
      default:throw new ContractError('UNKNOWN_LAB_OPERATION',404);
    }
  }
  private validateAssets(sid: string,p: Protocol) {
    for(const group of p.groups){let decoded=0;const hashes=new Set<string>(),sizes:number[]=[];
      for(const a of new Set(group.trials.flatMap(t=>t.asset_id?[t.asset_id]:[]))){const asset=this.get<{state:string;width:number;height:number;hash:string}>('SELECT state,width,height,hash FROM lab_assets WHERE asset_id=? AND study_id=?',a,sid);
        if(!asset||asset.state!=='READY')throw new ContractError('ASSET_NOT_READY',409,{asset_id:a});if(!hashes.has(asset.hash)){hashes.add(asset.hash);const bytes=asset.width*asset.height*4;decoded+=bytes;sizes.push(bytes);}
      }if(group.sampling)decoded=sizes.sort((a,b)=>b-a).slice(0,Object.values(group.sampling.allocations[0]!).reduce((n,v)=>n+v,0)).reduce((n,v)=>n+v,0);
      if(decoded>p.budget.max_decoded_bytes)throw new ContractError('RESOURCE_MEMORY_BUDGET_EXCEEDED');
    }
  }

  private skipPages(s: SessionRow,p: Protocol) {
    let index=s.page_index;const answers=JSON.parse(s.answers) as Record<string,Answer>;
    while(p.pages[index]&&!evaluate(p.pages[index]!.condition,answers)) {
      for(const q of p.pages[index]!.questions)answers[q.id]=null;index++;
    }
    this.run('UPDATE lab_sessions SET page_index=?,answers=? WHERE session_id=?',index,stableJSON(answers),s.session_id);
  }
  private reserve(s: SessionRow,p: Protocol) {
    if(s.allocation_id)return this.get<{reservation_id:string;variant_id:string;allocation_id:string}>('SELECT reservation_id,variant_id,allocation_id FROM lab_slots WHERE session_id=? AND allocation_id IS NOT NULL',s.session_id)!;
    let slot=this.get<{slot_id:string;reservation_id:string;variant_id:string;reserved_until:number}>('SELECT * FROM lab_slots WHERE session_id=? AND allocation_id IS NULL AND reserved_until>?',s.session_id,this.now());
    if(!slot) {
      this.run('UPDATE lab_slots SET session_id=NULL,reservation_id=NULL,reserved_until=NULL WHERE allocation_id IS NULL AND reserved_until<?',this.now());
      slot=this.get('SELECT * FROM lab_slots WHERE version_id=? AND session_id IS NULL ORDER BY rowid LIMIT 1',s.version_id);
      if(!slot) {
        const entries=p.variants.flatMap(v=>Array.from({length:v.weight},()=>v.id));const seed=randomBytes(16).toString('hex');const buf=Buffer.from(seed,'hex');const state=[0,4,8,12].map(i=>buf.readUInt32LE(i)) as [number,number,number,number];if(state.every(x=>x===0))state[0]=1;const rng=new Xoshiro128(state);
        // Preserve the actual shuffled block and private seed; credentials/PRNG use different random streams.
        for(let i=entries.length-1;i>0;i--){const j=sampleBounded(i+1,()=>rng.next(),p.budget.draw_budget).index;[entries[i],entries[j]]=[entries[j]!,entries[i]!];}
        const block=randomUUID();entries.forEach((variant,i)=>this.run('INSERT INTO lab_slots(slot_id,version_id,block_id,ordinal,variant_id,seed) VALUES (?,?,?,?,?,?)',randomUUID(),s.version_id,block,i,variant,seed));
        slot=this.get('SELECT * FROM lab_slots WHERE version_id=? AND session_id IS NULL ORDER BY rowid LIMIT 1',s.version_id)!;
      }
      const reservation=randomUUID();this.run('UPDATE lab_slots SET session_id=?,reservation_id=?,reserved_until=? WHERE slot_id=?',s.session_id,reservation,this.now()+300000,slot.slot_id);
      slot={...slot,reservation_id:reservation,reserved_until:this.now()+300000};
    }else{
      // Preparation can exceed five minutes on a shared low-bandwidth link.
      // A fresh, fenced request renews only a still-live reservation; expired
      // slots are reassigned through the normal path and never resurrected.
      slot.reserved_until=this.now()+300000;
      this.run('UPDATE lab_slots SET reserved_until=? WHERE slot_id=?',slot.reserved_until,slot.slot_id);
    }return {reservation_id:slot.reservation_id,variant_id:slot.variant_id,reserved_until:slot.reserved_until};
  }
  private selection(s:SessionRow,group:Protocol['groups'][number]):TrialSelection|undefined {
    if(!group.sampling)return undefined;
    const old=this.get<{selection:string}>('SELECT selection FROM lab_group_selections WHERE session_id=? AND group_id=?',s.session_id,group.id);
    if(old)return JSON.parse(old.selection) as TrialSelection;
    const bytes=randomBytes(16),seed=[0,4,8,12].map(i=>bytes.readUInt32LE(i)) as GroupPlan['seed'];if(seed.every(n=>n===0))seed[0]=1;
    const selection:TrialSelection={group_id:group.id,seed,...sampleTrials(group.trials,group.sampling,seed)};
    this.run('INSERT INTO lab_group_selections VALUES (?,?,?)',s.session_id,group.id,stableJSON(selection));return selection;
  }
  private participant(op: string,c: Command,d: Record<string,unknown>): unknown {
    const s=this.session(c),sid=s.session_id;
    if(op==='participant.reanswer') return this.request(sid,op,d,()=>{
      if(s.state!=='TERMINATED')throw new ContractError('SESSION_NOT_TERMINATED',409);
      const existing=this.get<{new_session_id:string}>('SELECT new_session_id FROM lab_reanswer_links WHERE old_session_id=?',sid);if(existing){const next=this.get<{credential_hash:string}>('SELECT credential_hash FROM lab_sessions WHERE session_id=?',existing.new_session_id)!;if(next.credential_hash!==d.credential_hash)throw new ContractError('REANSWER_ALREADY_CREATED',409);return this.view(existing.new_session_id);}
      const latest=this.get<{version_id:string}>('SELECT version_id FROM lab_versions WHERE study_id=? ORDER BY rowid DESC LIMIT 1',s.study_id)!.version_id;const oldFrozen=this.frozen(s.version_id),candidate=this.frozen(latest);const sameConsent=stableJSON(oldFrozen.protocol.consent??null)===stableJSON(candidate.protocol.consent??null);const frozen=sameConsent?candidate:oldFrozen;if(this.get<{admission:string}>('SELECT admission FROM lab_studies WHERE study_id=?',s.study_id)!.admission!=='OPEN')throw new ContractError('ADMISSION_PAUSED',409);
      if(frozen.protocol.mode==='COLLECTION'&&(this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_gate'")!.value!=='OPEN'||this.get<{value:string}>("SELECT value FROM lab_meta WHERE key='collection_environment'")?.value!==frozen.protocol.budget.environment_id))throw new ContractError('COLLECTION_GATE_CLOSED',409);
      const next=randomUUID();this.run("INSERT INTO lab_sessions(session_id,study_id,version_id,admission_id,credential_hash,state,created_at) VALUES (?,?,?,?,?,'CREATED',?)",next,s.study_id,frozen.version_id,randomUUID(),hash(String(d.credential_hash)),this.now());