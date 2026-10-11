这是实施后设计复审 6/7。内容为当前修改源码、测试或采用设计。先吸收本段；只回复“已接收复审6”，等全部7段后再讨论。

          const refs=db.prepare('SELECT event_id,hash,disposition,writer_epoch,kind FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope);
          for(const row of db.prepare('SELECT envelope FROM lab_events WHERE session_id=? AND scope=? ORDER BY sequence').all(sid,permit.scope) as any[]){const e=JSON.parse(row.envelope);if(e.kind==='GROUP_RECORD')replay.apply(e.payload.record);}
          const results=replay.finish(),job=randomUUID();store.beginJob(job,'REPLAY',null,{});
          store.execute({operation:'lab/internal.job.finish',data:{job_id:job,state:'READY',result:{session_id:sid,scope:permit.scope,source_hash:digest(stableJSON(refs)),valid:true,results}}});
          result=call('seal',{...body,proof_job_id:job});
        }else{if(op==='ingest')groupCalls++;result=call(op??'view',body);}
      }
      await route.fulfill({json:result});
    }catch(error){await route.fulfill({status:400,json:{code:String(error)}});}
  });
  await page.route('**/participate.html?**',route=>route.fulfill({contentType:'text/html',body:'<p id="done">Group saved</p>'}));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`/run.html?version=${version.version_id}`);
  await expect(page.getByRole('button',{name:'开始本组'})).toBeVisible();
  return {view:()=>call('view'),records:()=>db.prepare("SELECT envelope FROM lab_events WHERE session_id=? AND kind='GROUP_RECORD' ORDER BY sequence").all(sid).map((e:any)=>JSON.parse(e.envelope).payload.record),
    requests:()=>groupCalls,downloads:()=>assetCalls,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

test('image click visibly confirms first answer; right click, repeated key, and changed second answer are excluded',async({page})=>{
  const f=await start(page);try{
    await page.getByRole('button',{name:'开始本组'}).click();
    await expect(page.locator('#status')).toContainText('本组已呈现 1 次');
    const left=page.getByRole('button',{name:'Left',exact:true}),right=page.getByRole('button',{name:'Right',exact:true});
    await left.click({button:'right'});await left.click({button:'middle'});await expect(left).toHaveAttribute('aria-pressed','false');
    expect(await left.evaluate(e=>!e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})))).toBe(true);
    await left.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(page.locator('#status')).toContainText('已记录：Left');
    await right.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(right).toHaveAttribute('aria-pressed','false');
    expect(f.requests()).toBe(0);
    await expect(page.locator('#status')).toContainText('本组已呈现 2 次');
    await page.keyboard.down('j');await page.keyboard.down('j');await page.keyboard.up('j');
    await expect(right).toHaveAttribute('aria-pressed','true');await expect(page.locator('#done')).toBeVisible();
    expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
    const inputs=f.records().filter((r:any)=>r.type==='INPUT');expect(inputs.filter((r:any)=>r.pointer_type==='keyboard'&&r.action==='down')).toHaveLength(1);
    expect(f.records().filter((r:any)=>r.type==='WINDOW').map((r:any)=>r.answer)).toEqual(['Left','Right']);
    for(const [i,r] of f.records().filter((r:any)=>r.type==='END').entries())expect(r.at).toBeGreaterThanOrEqual(f.view().permit.plan.start+(i+1)*2300);
  }catch(error){console.log('Runner diagnostic',JSON.stringify(f.view().diagnostics),JSON.stringify(f.records()));throw error;}finally{f.close();}
});

test('mobile touch held through ISI never answers the next stimulus until release and a new press',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),f=await start(page);
  try{await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('本组已呈现 1 次');
    await page.getByRole('button',{name:'Left',exact:true}).tap();await expect(page.getByRole('button',{name:'Left',exact:true})).toHaveAttribute('aria-pressed','true');
    // Watch every frame: ordinary assertion polling can miss a short interval.
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='已记录；请等待下一刺激。');
    await page.evaluate(()=>{const r=document.querySelector('.response-buttons button')!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.locator('#status')).toContainText('本组已呈现 2 次');
    await page.evaluate(()=>{const r=document.querySelectorAll('.response-buttons button')[1]!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.getByRole('button',{name:'Right',exact:true})).toHaveAttribute('aria-pressed','false');
    await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:77,pointerType:'touch',button:0})));
    await page.getByRole('button',{name:'Right',exact:true}).tap();await expect(page.locator('#done')).toBeVisible();
    expect(f.view().permit.state).toBe('CLOSED_NORMAL');expect(f.records().filter((r:any)=>r.type==='WINDOW').map((r:any)=>r.answer)).toEqual(['Left','Right']);
  }finally{await context.close();f.close();}
});

test('self-paced rating requires selection and submit, clears image, then waits a full 3-second ISI',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),f=await start(page,true);
  try{
    await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('第 1/2 张');
    const chooseRating=async(value:number)=>{const range=page.getByRole('slider',{name:'测试项目',exact:true});const box=(await range.boundingBox())!;await page.touchscreen.tap(box.x+11+(box.width-22)*(value-1)/8,box.y+box.height/2);};
    const submit=page.getByRole('button',{name:'提交评分',exact:true});await expect(submit).toBeDisabled();
    // More than the legacy fixed window: no answer still keeps the first picture.
    await page.waitForTimeout(3200);await expect(page.locator('#status')).toContainText('第 1/2 张');await expect(page.locator('#stimulus')).toBeVisible();
    await chooseRating(2);await expect(submit).toBeEnabled();
    await submit.tap();
    await expect(page.locator('#stimulus')).toBeHidden();await expect(submit).toBeDisabled();expect(f.requests()).toBe(0);
    await expect(submit).toBeDisabled();
    await expect(page.locator('#status')).toContainText('第 2/2 张',{timeout:5000});
    await chooseRating(4);await submit.tap();await expect(page.locator('#done')).toBeVisible({timeout:12000});
    const permit=f.view().permit,records=f.records();expect(permit.state).toBe('CLOSED_NORMAL');expect(f.view().diagnostics).toHaveLength(0);
    expect(records.filter((r:any)=>r.type==='RATING').map((r:any)=>r.values)).toEqual([[2],[4]]);
    const replay=new RunReplay(permit.plan);for(const r of records)replay.apply(r);const results=replay.finish();
    expect(results).toHaveLength(2);for(const r of results)expect(r.isi_ms).toBeGreaterThanOrEqual(3000);
    expect(results[1]!.onset-results[0]!.clear!).toBeGreaterThanOrEqual(3000);
  }catch(error){console.log('Rating diagnostic',JSON.stringify(f.view().diagnostics),JSON.stringify(f.records()));throw error;}finally{await context.close();f.close();}
});
