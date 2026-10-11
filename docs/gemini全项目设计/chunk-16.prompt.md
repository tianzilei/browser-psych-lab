全项目设计讨论，传输段 16，源码主题：研究和参加者事务（源包 5/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

      this.run('INSERT INTO lab_reanswer_links VALUES (?,?,?)',sid,next,this.now());this.run('INSERT INTO lab_consents SELECT ?,document_hash,accepted_at FROM lab_consents WHERE session_id=?',next,sid);this.run('INSERT INTO lab_marks VALUES (?,1,?,?,?,?,?,?)',randomUUID(),next,'REANSWER',`重新作答，关联原答卷 ${sid}`,'OPEN','PARTICIPANT',this.now());this.audit(sid,'participant.reanswer',next,{replaces:sid,original_retained:true});return this.view(next);
    });
    if(op==='participant.covariates')return this.request(sid,op,d,()=>{
      if(typeof d.raw!=='string'||Buffer.byteLength(d.raw)>32*1024)throw new ContractError('INVALID_COVARIATES');
      const parsed=object(JSON.parse(d.raw));if(parsed.schema!=='environment-v1')throw new ContractError('INVALID_COVARIATES');
      const sample=id(d.sample_id),h=digest(d.raw),old=this.get<{hash:string}>('SELECT hash FROM lab_covariates WHERE session_id=? AND sample_id=?',sid,sample);
      if(old&&old.hash!==h)throw new ContractError('COVARIATES_CONFLICT',409);
      if(!old){if(this.get<{n:number}>('SELECT count(*) AS n FROM lab_covariates WHERE session_id=?',sid)!.n>=50)throw new ContractError('COVARIATES_BUDGET_EXCEEDED');this.run('INSERT INTO lab_covariates VALUES (?,?,?,?,?,?)',sid,sample,h,d.raw,'client-reported',this.now());}
      return {sample_id:sample,hash:h,status:'PERSISTED'};
    });
    if(op==='participant.view')return this.view(sid);
    if(op==='participant.preparation.release')return {session_id:sid};
    if(op==='participant.ingest')return this.ingest(s,d);
    if(op==='participant.receipts'){
```