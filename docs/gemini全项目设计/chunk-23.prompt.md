全项目设计讨论，传输段 23，源码主题：维护、文件生命周期及恢复（源包 8/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

        for(const row of db.prepare('SELECT envelope,disposition FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').iterate(p.session_id,p.scope) as Iterable<{envelope:string;disposition:string}>){if(row.disposition!=='ACCEPTED')throw new Error('REBUILD_INPUT_INVALID');const e=parseLabEvent(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);}
        projections.push({session_id:p.session_id,scope:p.scope,source_hash:digest(stableJSON(refs)),result:replay.finish()});if(Buffer.byteLength(stableJSON(projections))>4*1024*1024)throw new Error('REBUILD_RESULT_BUDGET_EXCEEDED');
      }db.exec('COMMIT');return {generation_id:config.job,projections,algorithm:'run-replay-v1'};
    }
    if(config.kind==='BACKUP'){
      const target=await privateRoot(join(config.root,'research-backups',config.job));const destination=join(target,'database.sqlite');
      phase('DATABASE_BACKUP');await db.backup(destination);await chmod(destination,0o600);const restored=new Database(destination,{readonly:true,fileMustExist:true});
      try{
        if(restored.pragma('integrity_check',{simple:true})!=='ok'||(restored.pragma('foreign_key_check') as unknown[]).length)throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED');
        const assets=restored.prepare("SELECT asset_id,hash,bytes FROM lab_assets WHERE state='READY'").all() as {asset_id:string;hash:string;bytes:number}[];
        const runners=restored.prepare('SELECT DISTINCT runner_hash FROM lab_versions').all() as {runner_hash:string}[];
        // Parent establishes durable pins from THIS completed backup view before releasing the barrier.
        phase('PIN_REQUIRED',assets);await new Promise<void>(resolve=>parentPort!.once('message',()=>resolve()));
        await mkdir(join(target,'assets'),{mode:0o700});await mkdir(join(target,'runners'),{mode:0o700});const files:{path:string;hash:string}[]=[];
        files.push({path:'database.sqlite',hash:await fileHash(destination)});let total=0;
        for(const asset of assets){total+=asset.bytes;if(total>512*1024*1024)throw new Error('BACKUP_ASSET_BUDGET_EXCEEDED');
          const h=await copyChecked(await assetPath(config.root,asset.asset_id),join(target,'assets',`${asset.asset_id}.bin`));if(h!==asset.hash)throw new Error('BACKUP_ASSET_HASH_MISMATCH');files.push({path:`assets/${asset.asset_id}.bin`,hash:h});}
        for(const runner of runners){const from=join(config.root,'research-assets','runners',runner.runner_hash),release=JSON.parse(await readFile(join(from,'release.json'),'utf8')) as {runnerHash:string;files:{path:string;hash:string}[]};
          if(release.runnerHash!==runner.runner_hash||digest(JSON.stringify(release.files))!==runner.runner_hash)throw new Error('BACKUP_RUNNER_IDENTITY_MISMATCH');for(const f of release.files){if(!/^[a-zA-Z0-9._/-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='..')||await fileHash(join(from,f.path))!==f.hash)throw new Error('BACKUP_RUNNER_HASH_MISMATCH');}
          await copyTree(from,join(target,'runners',runner.runner_hash),files,`runners/${runner.runner_hash}`);}
        const manifest={schema:'backup-v1',job_id:config.job,completed_at:new Date().toISOString(),database_view:'completed-online-backup',files,assets,software:'browser-psych-lab',restore_gate:'CLOSED',secret_configuration:'configure-separately'};
        await writeDurable(join(target,'manifest.json'),stableJSON(manifest));await syncDirectory(target);
        let independent=false;const independentRoot=String(config.config.independent_root??'');
        if(independentRoot){const independentPath=await privateRoot(independentRoot);if((await lstat(independentPath)).dev===(await lstat(config.root)).dev)throw new Error('BACKUP_TARGET_SAME_FILESYSTEM');phase('INDEPENDENT_COPY');const copied:{path:string;hash:string}[]=[];await copyTree(target,join(independentPath,config.job),copied,'backup');for(const file of copied){const local=file.path.slice('backup/'.length);if(await fileHash(join(target,local))!==file.hash)throw new Error('INDEPENDENT_COPY_MISMATCH');}independent=true;}
        return {job_id:config.job,files:files.length,manifest_hash:await fileHash(join(target,'manifest.json')),independent,independent_target:independentRoot||null};
      }finally{restored.close();}
    }
    if(config.kind==='EXPORT'){
      const sid=id(config.config.study_id);const target=await privateRoot(join(config.root,'research-exports',config.job));
      const output=join(target,'data.csv');const fd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      const snapshot=randomUUID(),started=Date.now(),source=createHash('sha256');let bytes=0,rows=0;const tables:Record<string,number>={};
      const cell=(x:string)=>`"${x.replaceAll('"','""')}"`;
      const emit=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>100*1024*1024||Date.now()-started>30000)throw new Error('EXPORT_BUDGET_EXCEEDED');writeSync(fd,text);};
      db.exec('BEGIN');const readPoint=db.prepare('SELECT study_id FROM lab_studies WHERE study_id=?').get(sid);if(!readPoint)throw new Error('STUDY_NOT_FOUND');
      const actualReadAt=new Date().toISOString();
      try{
        emit('table,data_json\r\n');
        const queries:Record<string,string>={
          studies:'SELECT study_id,title,draft,revision,admission,created_at FROM lab_studies WHERE study_id=?',
          versions:'SELECT * FROM lab_versions WHERE study_id=?',assets:'SELECT * FROM lab_assets WHERE study_id=?',
          sessions:'SELECT session_id,study_id,version_id,admission_id,state,writer_id,writer_epoch,lease_until,page_index,group_index,answers,path,allocation_id,completion,created_at FROM lab_sessions WHERE study_id=?',
          slots:'SELECT a.* FROM lab_slots a JOIN lab_versions v USING(version_id) WHERE v.study_id=?',
        };
        queries.questionnaire_sources='SELECT * FROM lab_questionnaire_sources WHERE study_id=?';queries.packages='SELECT * FROM lab_packages WHERE study_id=?';queries.package_images='SELECT * FROM lab_package_images WHERE study_id=?';
        queries.reanswer_links='SELECT a.* FROM lab_reanswer_links a JOIN lab_sessions s ON s.session_id=a.new_session_id WHERE s.study_id=?';
        for(const table of ['writers','permits','events','raw','seals','diagnostics','marks','projections','covariates','consents','group_selections'])queries[table]=`SELECT a.* FROM lab_${table} a JOIN lab_sessions s USING(session_id) WHERE s.study_id=?`;
        queries.dispositions='SELECT d.* FROM lab_dispositions d JOIN lab_raw r USING(receipt_id) JOIN lab_sessions s USING(session_id) WHERE s.study_id=?';
        for(const [table,query]of Object.entries(queries)){tables[table]=0;
          for(const row of db.prepare(query).iterate(sid) as Iterable<Record<string,unknown>>){if(++rows>200000)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');
            if(Buffer.isBuffer(row.raw)){row.raw_utf8=(row.raw as Buffer).toString('utf8');delete row.raw;}const encoded=stableJSON(row);source.update(`${table}\0${encoded}\n`);emit(`${cell(table)},${cell(encoded)}\r\n`);tables[table]++;}
        }
        // Derived trial rows are recomputed from the same read view, including interrupted histories.
        for(const row of db.prepare("SELECT e.session_id,e.event_id,e.envelope FROM lab_events e JOIN lab_sessions s USING(session_id) WHERE s.study_id=? AND e.kind='INPUT_DIAGNOSTIC' AND e.scope LIKE 'd-ui-%' ORDER BY e.rowid").iterate(sid) as Iterable<{session_id:string;event_id:string;envelope:string}>){const batch=object(parseLabEvent(row.envelope).payload.interaction);for(const sample of batch.samples as Record<string,unknown>[]){const encoded=stableJSON({session_id:row.session_id,event_id:row.event_id,time_origin:batch.time_origin,...sample});if(++rows>200000)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');emit(`${cell('interaction_actions')},${cell(encoded)}\r\n`);source.update(`interaction_actions\0${encoded}\n`);tables.interaction_actions=(tables.interaction_actions??0)+1;}}
        for(const session of db.prepare('SELECT s.session_id,s.version_id,s.page_index,s.path,v.protocol FROM lab_sessions s JOIN lab_versions v USING(version_id) WHERE s.study_id=?').iterate(sid) as Iterable<{session_id:string;version_id:string;page_index:number;path:string;protocol:string}>){
          const protocol=JSON.parse(session.protocol) as Protocol,path=JSON.parse(session.path) as string[],answers:Record<string,Answer>={},states:Record<string,unknown>={};
          for(const [index,page]of protocol.pages.entries()){
            if(path.includes(page.id)){const event=db.prepare("SELECT envelope FROM lab_events WHERE session_id=? AND scope=? AND kind='PAGE_SNAPSHOT' AND disposition='ACCEPTED' ORDER BY sequence DESC LIMIT 1").get(session.session_id,page.id) as {envelope:string}|undefined;if(!event)throw new Error('EXPORTED_PAGE_EVIDENCE_MISSING');const snapshot=pageSnapshot(page,answers,object(parseLabEvent(event.envelope).payload.answers) as Record<string,Answer>);for(const [q,state]of Object.entries(snapshot)){states[q]={page_id:page.id,...state};answers[q]=state.answer;}}
            else if(index<session.page_index&&!evaluate(page.condition,answers)){for(const q of page.questions){states[q.id]={page_id:page.id,state:'SKIPPED',answer:null,reason:'PAGE_BRANCH'};answers[q.id]=null;}}
            else for(const q of page.questions)states[q.id]={page_id:page.id,state:index===session.page_index?'UNCONFIRMED':'NOT_REACHED',answer:null};
          }
          const json=stableJSON({session_id:session.session_id,states});emit(`${cell('question_states')},${cell(json)}\r\n`);source.update(`question_states\0${json}\n`);rows++;tables.question_states=(tables.question_states??0)+1;
          for(const page of protocol.pages)for(const q of page.questions)if(q.type==='scales'){
            const parent=object(states[q.id]),answer=parent.answer&&typeof parent.answer==='object'?object(parent.answer):{};
            for(const axis of q.axes!){const value=typeof answer[axis.id]==='number'?answer[axis.id] as number:null;
              const state=value!==null?'ANSWERED':['ANSWERED','UNANSWERED'].includes(String(parent.state))?'UNANSWERED':parent.state;
              const row={session_id:session.session_id,version_id:session.version_id,page_id:page.id,question_id:q.id,axis_id:axis.id,axis_title:axis.title,min:axis.min,max:axis.max,value,label:value===null?null:axis.labels[value-axis.min],state};
              const encoded=stableJSON(row);if(++rows>200000)throw new Error('EXPORT_ROW_BUDGET_EXCEEDED');emit(`${cell('axis_answers')},${cell(encoded)}\r\n`);source.update(`axis_answers\0${encoded}\n`);tables.axis_answers=(tables.axis_answers??0)+1;
            }
          }
        }
        for(const permit of db.prepare('SELECT p.* FROM lab_permits p JOIN lab_sessions s USING(session_id) WHERE s.study_id=?').iterate(sid) as Iterable<{session_id:string;scope:string;plan:string;state:string;writer_epoch:number}>){
          const replay=new RunReplay(JSON.parse(permit.plan));let replayError:string|null=null;let previous:{event_id:string;hash:string}|null=null;let sequence=0;const sourceDispositions:Record<string,number>={};
          try{for(const row of db.prepare('SELECT envelope,disposition,reason,hash FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').iterate(permit.session_id,permit.scope) as Iterable<{envelope:string;disposition:string;reason:string;hash:string}>){sourceDispositions[row.disposition]=(sourceDispositions[row.disposition]??0)+1;if(row.disposition!=='ACCEPTED'&&row.reason!=='HISTORICAL_RECONCILIATION_REQUIRED')throw new Error('NONCANONICAL_HISTORY');const e=parseLabEvent(row.envelope);if(e.writer_epoch!==permit.writer_epoch||e.sequence!==sequence++||stableJSON(e.previous)!==stableJSON(previous))throw new Error('HISTORICAL_CHAIN_GAP_OR_FENCE');previous={event_id:e.event_id,hash:row.hash};if(e.kind==='GROUP_RECORD')replay.apply(object(e.payload.record) as unknown as RunRecord);}if(permit.state==='CLOSED_NORMAL')replay.finish();}catch(error){replayError=String(error);}
          const derived={session_id:permit.session_id,scope:permit.scope,permit_state:permit.state,historical:permit.state!=='CLOSED_NORMAL',source_dispositions:sourceDispositions,algorithm:'run-replay-v1',results:[...replay.results.values()],executions:Object.fromEntries(replay.scheduler.executions),replay_error:replayError};const json=stableJSON(derived);emit(`${cell('trial_results')},${cell(json)}\r\n`);source.update(`trial_results\0${json}\n`);rows++;tables.trial_results=(tables.trial_results??0)+1;
        }
        for(const audit of db.prepare('SELECT * FROM lab_audit WHERE subject=? OR subject IN (SELECT version_id FROM lab_versions WHERE study_id=?) OR subject IN (SELECT session_id FROM lab_sessions WHERE study_id=?)').iterate(sid,sid,sid)){const json=stableJSON(audit);emit(`${cell('audit')},${cell(json)}\r\n`);source.update(`audit\0${json}\n`);rows++;tables.audit=(tables.audit??0)+1;}
        const refs=db.prepare('SELECT r.* FROM lab_asset_refs r JOIN lab_assets a USING(asset_id) WHERE a.study_id=?').all(sid);
        const refsJson=stableJSON(refs);emit(`${cell('asset_refs')},${cell(refsJson)}\r\n`);source.update(`asset_refs\0${refsJson}\n`);rows++;tables.asset_refs=1;db.exec('COMMIT');
        try{fsyncSync(fd);}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
        const manifest={schema:'export-v1',snapshot_id:snapshot,study_id:sid,actual_read_at:actualReadAt,algorithm:'single-read-view-v1',source_hash:source.digest('hex'),tables,rows,bytes,csv_hash:await fileHash(output),raw_encoding:'exact UTF-8 in raw_utf8 cells',all_session_states:true,