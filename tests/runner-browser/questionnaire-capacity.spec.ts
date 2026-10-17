import {test,expect} from '@playwright/test';
for(const mode of ['count','bytes'] as const)test(`questionnaire ${mode} limit preserves raw bytes and reserves one final snapshot`,async({page})=>{
  test.setTimeout(90000);await page.goto('/participate.html');
  const report=await page.evaluate(async mode=>{
    const source='/ledger.ts';const {Ledger}=await import(source) as typeof import('../../src/web/ledger.js'),writer=crypto.randomUUID();
    const ledger=await Ledger.open(`budget-${mode}`,writer);await ledger.state();
    await ledger.session({session_id:'budget-test',writer_epoch:1,frozen:{version_id:`budget-${mode}`,hash:'a'.repeat(64),protocol:{questionnaire_layout:'adaptive'}}} as any);
    const scope='survey';let revisions=0,last: any,error='';
    for(let i=0;i<5001;i++){
      const answer=mode==='bytes'?'汉'.repeat(3999)+(i%2?'甲':'乙'):i%2?'yes':'no';
      try{last=await ledger.append(scope,'PAGE_REVISION',{question_id:'q',answer},undefined,{q:answer});revisions++;}
      catch(e){error=(e as Error).message;break;}
    }
    await ledger.drain();const before=await ledger.scopeUsage(scope);
    const first=(await ledger.db.getAll('events'))[0]!;
    const state=await ledger.state();await ledger.append(scope,'PAGE_SNAPSHOT',{answers:state.page_values[scope]},[scope],state.page_values[scope]);
    await ledger.drain();const after=await ledger.scopeUsage(scope),events=await ledger.db.getAll('events');
    const tail=events.filter(row=>row.scope===scope).sort((a,b)=>a.sequence-b.sequence).at(-1)!;
    const all=events.filter(row=>row.scope===scope);
    const exactBytes=all.reduce((n,row)=>n+new TextEncoder().encode(row.raw).length,0);
    // Simulate metadata from an earlier browser version: usage must migrate
    // from retained original rows, not UTF-16 string length or just the outbox.
    const meta=await ledger.state();delete meta.scope_usage;await ledger.db.put('meta',meta,ledger.version);
    const migrated=await ledger.scopeUsage(scope);
    return {revisions,error,before,after,migrated,exactBytes,rows:all.length,
      firstUnchanged:JSON.stringify(await ledger.db.get('events',first.event_id))===JSON.stringify(first),
      lastUnchanged:JSON.stringify(await ledger.db.get('events',last.event_id))===JSON.stringify(last),
      tailKind:JSON.parse(tail.raw).kind,previous:JSON.parse(tail.raw).previous,expectedPrevious:{event_id:last.event_id,hash:last.hash},
      manifest:(await ledger.state()).pending[scope]?.manifest.events.length};
  },mode);
  expect(report.error).toBe('LOCAL_QUESTIONNAIRE_EDIT_LIMIT');expect(report.firstUnchanged).toBe(true);expect(report.lastUnchanged).toBe(true);
  expect(report.rows).toBe(report.revisions+1);expect(report.manifest).toBe(report.rows);expect(report.tailKind).toBe('PAGE_SNAPSHOT');
  expect(report.previous).toEqual(report.expectedPrevious);expect(report.after.bytes).toBe(report.exactBytes);expect(report.migrated).toEqual(report.after);
  expect(report.after.events).toBeLessThanOrEqual(5000);expect(report.after.bytes).toBeLessThanOrEqual(32*1024*1024);
  if(mode==='count')expect(report.after.events).toBe(5000);else{expect(report.revisions).toBeLessThan(4999);expect(report.before.bytes).toBeGreaterThan(31*1024*1024);}
});
