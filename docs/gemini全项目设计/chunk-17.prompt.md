全项目设计讨论，传输段 17，源码主题：研究和参加者事务（源包 6/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/lab-store.ts L393–L575

```
      if(!Array.isArray(d.events)||d.events.length>32)throw new ContractError('INVALID_RECEIPT_QUERY');return {receipts:d.events.map(eventRef).map(r=>this.custody(sid,r))};
    }
    if(op==='participant.admission'){
      const action=String(d.action),nonce=id(d.ticket_id);
      if(action==='join')return this.admission.join(sid,nonce);
      if(action==='leave')return this.admission.leave(sid,nonce);
      if(action!=='touch')throw new ContractError('INVALID_ADMISSION_ACTION');
      const result=this.admission.touch(sid,nonce);
      if(result.status==='ACTIVE'&&s.writer_id===d.writer_id&&s.writer_epoch===d.writer_epoch&&s.lease_until<this.now()+SESSION_LEASE_MS-60000)
        this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+SESSION_LEASE_MS,sid);
      return result;
    }
    if(op==='participant.activity'){
      if(['COMPLETED','TERMINATED'].includes(s.state))return {status:s.state};this.active(s,d);
      if(!this.get('SELECT 1 FROM lab_task_activity WHERE session_id=? AND writer_epoch=?',sid,s.writer_epoch))throw new ContractError('TASK_ACTIVITY_UNAVAILABLE',409);
      this.run('UPDATE lab_task_activity SET last_seen=? WHERE session_id=?',this.now(),sid);this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+300000,sid);this.admission.join(sid);return {status:'ACTIVE'};
    }
    if(!['COMPLETED','TERMINATED'].includes(s.state)&&['participant.claim','participant.reserve','participant.permit','participant.seal','participant.finalize','participant.preparation','participant.asset','participant.admission.check'].includes(op)){
      const result=this.admission.join(sid);if(result.status!=='ACTIVE')return new Rejection(new ContractError('SESSION_WAITING',409,result));
    }
    if(op==='participant.admission.check')return this.admission.view(sid);
    if(op==='participant.preparation'){
      this.active(s,d);const p=this.frozen(s.version_id).protocol;
      if(s.page_index<p.pages.length||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('PREPARATION_UNAVAILABLE',409);
      const slot=this.get<{variant_id:string}>('SELECT variant_id FROM lab_slots WHERE session_id=? AND (allocation_id IS NOT NULL OR reserved_until>?)',sid,this.now());
      if(!slot)throw new ContractError('RESERVATION_EXPIRED',409);
      const group=p.groups.find(g=>g.id===p.variants.find(v=>v.id===slot.variant_id)!.group_order[s.group_index]);
      if(!group)throw new ContractError('NO_NEXT_GROUP',409);
      const selection=this.selection(s,group);
      return {key:`${sid}:${s.writer_epoch}:${s.group_index}:${slot.variant_id}`,asset_ids:[...new Set((selection?.roots??group.trials).flatMap(t=>t.asset_id?[t.asset_id]:[]))]};
    }
    if(op==='participant.asset') {
      const asset=id(d.asset_id);if(!this.get("SELECT 1 FROM lab_asset_refs WHERE asset_id=? AND kind='VERSION' AND owner=?",asset,s.version_id))throw new ContractError('ASSET_FORBIDDEN',403);
      const info=this.get('SELECT asset_id,hash,bytes,width,height,format,state FROM lab_assets WHERE asset_id=?',asset);
      return {...info as object,runner_hash:this.get<{runner_hash:string}>('SELECT runner_hash FROM lab_versions WHERE version_id=?',s.version_id)!.runner_hash};
    }
    return this.request(sid,op,d,()=>{
      const p=this.frozen(s.version_id).protocol;
      if(op==='participant.terminate') {
        if(s.state==='COMPLETED')throw new ContractError('SESSION_TERMINAL',409);
        const reason=id(d.reason);this.run("UPDATE lab_sessions SET state='TERMINATED',lease_until=0 WHERE session_id=?",sid);
        this.run("UPDATE lab_permits SET state=? WHERE session_id=? AND state='ISSUED'",reason==='UNKNOWN_RUN'?'CLOSED_UNKNOWN':'CLOSED_TERMINATED',sid);
        this.admission.ended(sid);this.diagnostic(sid,null,reason,d.evidence??{});return this.view(sid);
      }
      if(op==='participant.reconcile') {
        if(s.state!=='TERMINATED')throw new ContractError('SESSION_NOT_TERMINATED');const manifest=parseManifest(d.manifest,5000);
        return {status:'RECONCILED',reconciliation_id:randomUUID(),manifest,receipts:manifest.events.map(r=>this.custody(sid,r)),unknown:d.unknown??[],cleanup_allowed:false};
      }
      if(op==='participant.claim') {
        if(['COMPLETED','TERMINATED'].includes(s.state))throw new ContractError('SESSION_TERMINAL',409);
        const writer=id(d.writer_id);if(s.writer_id!==writer&&(s.lease_until>this.now()||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid)))throw new ContractError('RUN_LOCKED',409);
        const epoch=s.writer_id===writer?s.writer_epoch:s.writer_epoch+1;
        this.run("UPDATE lab_sessions SET writer_id=?,writer_epoch=?,lease_until=?,state='ACTIVE' WHERE session_id=?",writer,epoch,this.now()+SESSION_LEASE_MS,sid);
        this.run('INSERT OR IGNORE INTO lab_writers VALUES (?,?,?)',sid,epoch,writer);this.skipPages(s,p);return this.view(sid);
      }
      this.active(s,d);
      if(op==='participant.release') {
        if(this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('RUN_LOCKED',409);
        this.run('UPDATE lab_sessions SET lease_until=0 WHERE session_id=?',sid);return {status:'RELEASED'};
      }
      if(op==='participant.reserve') {
        if(s.page_index<p.pages.length)throw new ContractError('PAGES_NOT_SEALED',409);
        if(this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('RUN_LOCKED',409);
        this.run('UPDATE lab_sessions SET lease_until=? WHERE session_id=?',this.now()+300000,sid);
        const reservation=this.reserve(s,p),variant=p.variants.find(v=>v.id===reservation.variant_id)!,group=p.groups.find(g=>g.id===variant.group_order[s.group_index]);
        const selection=group?this.selection(s,group):undefined;
        return {...reservation,...(selection?{selection}:{})};
      }
      if(op==='participant.permit') {
        if(this.frozen(s.version_id).runner_version!==RUNNER_VERSION)throw new ContractError('RUNNER_VERSION_UNAVAILABLE',409);
        if(s.page_index<p.pages.length||this.get("SELECT 1 FROM lab_permits WHERE session_id=? AND state='ISSUED'",sid))throw new ContractError('PREVIOUS_STAGE_UNSEALED',409);
        const slot=this.get<{variant_id:string;reservation_id:string;reserved_until:number;allocation_id:string|null;slot_id:string}>('SELECT * FROM lab_slots WHERE session_id=? AND reservation_id=?',sid,id(d.reservation_id));
        if(!slot||(!slot.allocation_id&&slot.reserved_until<this.now()))throw new ContractError('RESERVATION_EXPIRED',409);
        const readiness=object(d.readiness),frame=Number(readiness.frame_ms);
        if(!Number.isFinite(frame)||1000/frame<p.budget.refresh_min_hz||1000/frame>p.budget.refresh_max_hz
          ||readiness.protocol_hash!==this.frozen(s.version_id).hash||typeof readiness.commit_ms!=='number'||!Number.isFinite(readiness.commit_ms)||readiness.commit_ms<0||readiness.commit_ms>p.budget.commit_ms
          ||!['portrait','landscape'].includes(String(readiness.layout)))throw new ContractError('ENVIRONMENT_NOT_READY',409);
        const geometry=object(readiness.geometry),viewport=object(geometry.viewport),canvas=object(geometry.canvas);
        const positive=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>0;
        const coordinate=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
        const inside=(b:Record<string,unknown>)=>coordinate(b.x)&&coordinate(b.y)&&positive(b.width)&&positive(b.height)&&Number(b.x)+Number(b.width)<=Number(viewport.width)+1&&Number(b.y)+Number(b.height)<=Number(viewport.height)+1;
        if(!positive(viewport.width)||!positive(viewport.height)||!positive(viewport.dpr)||!inside(canvas)||Number(canvas.width)<(readiness.layout==='portrait'?p.layout.portrait_min_width:p.layout.landscape_min_width)||Math.abs(Number(canvas.width)/Number(canvas.height)-p.layout.aspect)>.01||!Array.isArray(geometry.buttons))throw new ContractError('INVALID_GEOMETRY');
        const variant=p.variants.find(v=>v.id===slot.variant_id)!;const group=p.groups.find(g=>g.id===variant.group_order[s.group_index]);if(!group)throw new ContractError('NO_NEXT_GROUP');
        if(geometry.buttons.length!==group.choices.length||geometry.buttons.some((v,i)=>{const b=object(v);return b.choice!==group.choices[i]||!inside(b)||Number(b.height)<44;}))throw new ContractError('INVALID_GEOMETRY');
        const selection=this.selection(s,group);
        const roots=selection?.roots??variant.trial_order[group.id]!.map(root=>group.trials.find(t=>t.root_id===root)!);
        const assetHashes=object(readiness.assets);for(const t of roots){if(!t.asset_id)continue;const a=this.get<{hash:string;state:string}>('SELECT hash,state FROM lab_assets WHERE asset_id=?',t.asset_id)!;if(a.state!=='READY'||assetHashes[t.asset_id]!==a.hash)throw new ContractError('RESOURCE_NOT_READY',409);}
        const seed=randomBytes(16);const dv=new DataView(seed.buffer,seed.byteOffset,seed.byteLength);const state=selection?.seed??[0,4,8,12].map(i=>dv.getUint32(i,true)) as GroupPlan['seed'];if(state.every(v=>v===0))state[0]=1;
        const design=group.rating?{roots:roots.map(t=>({...t,isi_ms:Math.ceil(t.isi_ms/frame)*frame}))}:realizeTrials(group,roots,state,frame);
        const scope=`g-${randomUUID()}`;const start=Math.max(1000,p.budget.commit_ms+p.budget.activate_ms+p.budget.margin_ms+1);const plan:GroupPlan={group_id:group.id,scope,seed:state,...design,...(group.response_keys?{response_keys:group.response_keys}:{}),...(group.feedback?{feedback:group.feedback}:{}),choices:group.choices,repeats:group.repeats,start,frame_ms:frame,layout:String(readiness.layout),budget:p.budget,geometry:geometry as unknown as NonNullable<GroupPlan['geometry']>};
        if(group.rating)plan.rating=group.rating;if(selection)plan.sampling=selection.sampling;
        if(plan.roots.reduce((n,t)=>n+(t.image_ms+t.isi_ms+(t.feedback_ms??0))*(plan.repeats+1),0)>p.budget.max_group_ms)throw new ContractError('QUANTIZED_GROUP_BUDGET_EXCEEDED',409);
        const allocation=slot.allocation_id??randomUUID();if(!slot.allocation_id){this.run('UPDATE lab_slots SET allocation_id=? WHERE slot_id=?',allocation,slot.slot_id);this.run('UPDATE lab_sessions SET allocation_id=? WHERE session_id=?',allocation,sid);}
        const permit=randomUUID();this.run("INSERT INTO lab_permits VALUES (?,?,?,?,?,?,?,?, 'ISSUED')",permit,sid,scope,group.id,s.writer_epoch,stableJSON(plan),digest(stableJSON(plan)),stableJSON(readiness));if(readiness.activity_policy==='idle120-offline300-v1')this.run('INSERT INTO lab_task_activity VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET writer_epoch=excluded.writer_epoch,last_seen=excluded.last_seen',sid,s.writer_epoch,this.now());return this.view(sid).permit;
      }
      if(op==='participant.seal')return this.seal(s,d,p);
      if(op==='participant.finalize') {
        const view=this.view(sid);if(s.page_index<p.pages.length||s.group_index<p.groups.length||view.permit?.state==='ISSUED'||view.diagnostics.length)return {status:'WAITING',reason:'PATH_OR_INTEGRITY_NOT_CONFIRMED'};
        if(!Array.isArray(d.seal_ids)||stableJSON([...d.seal_ids].sort())!==stableJSON(view.seals.map(s=>s.seal_id).sort()))throw new ContractError('COMPLETION_MANIFEST_MISMATCH');
        const completion={completion_id:randomUUID(),session_id:sid,seal_ids:d.seal_ids,path:view.path,status:'COMPLETED'};
        this.run("UPDATE lab_sessions SET state='COMPLETED',completion=? WHERE session_id=?",JSON.stringify(completion),sid);this.admission.ended(sid);return completion;
      }
      throw new ContractError('UNKNOWN_PARTICIPANT_OPERATION',404);
    });
  }
  private seal(s:SessionRow,d:Record<string,unknown>,p:Protocol) {
    const manifest=parseManifest(d.manifest,5000);const h=digest(manifestText(manifest));
    const old=this.get<{manifest_hash:string;response:string}>('SELECT * FROM lab_seals WHERE session_id=? AND scope=?',s.session_id,manifest.scope);
    if(old){if(old.manifest_hash!==h)throw new ContractError('SEAL_CONFLICT',409);return JSON.parse(old.response);}
    const refs=this.all<{event_id:string;hash:string;disposition:string;writer_epoch:number;kind:string}>('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence',s.session_id,manifest.scope);
    const received=new Set(refs.map(r=>`${r.event_id}:${r.hash}`)),declared=new Set(manifest.events.map(r=>`${r.event_id}:${r.hash}`));
    const missing=manifest.events.filter(r=>!received.has(`${r.event_id}:${r.hash}`));
    const extra=refs.filter(r=>!declared.has(`${r.event_id}:${r.hash}`));
    if(missing.length||extra.length||refs.some(e=>e.disposition!=='ACCEPTED'||e.writer_epoch!==s.writer_epoch)||this.get('SELECT 1 FROM lab_diagnostics WHERE session_id=? AND scope=?',s.session_id,manifest.scope))return {status:'WAITING',missing,extra,reason:'INTEGRITY_UNCONFIRMED'};
    const page=p.pages[s.page_index]; const path=JSON.parse(s.path) as string[];
    if(page?.id===manifest.scope) {
      if(!refs.length||refs.at(-1)!.kind!=='PAGE_SNAPSHOT'||refs.slice(0,-1).some(e=>e.kind!=='PAGE_REVISION')||stableJSON(manifest.path)!==stableJSON([...path,page.id]))throw new ContractError('PAGE_MANIFEST_MISMATCH');
      const e=this.get<{envelope:string}>('SELECT envelope FROM lab_events WHERE session_id=? AND event_id=?',s.session_id,refs.at(-1)!.event_id)!;
      const supplied=object(parseLabEvent(e.envelope).payload.answers) as Record<string,Answer>;const answers=JSON.parse(s.answers) as Record<string,Answer>;
      const snap=pageSnapshot(page,answers,supplied);for(const [k,v]of Object.entries(snap))answers[k]=v.answer;
      path.push(page.id);this.run('UPDATE lab_sessions SET page_index=page_index+1,answers=?,path=? WHERE session_id=?',stableJSON(answers),stableJSON(path),s.session_id);