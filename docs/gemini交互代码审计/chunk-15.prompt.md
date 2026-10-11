当前交互源码第 15 段。连续片段，请与前后段拼接阅读。本阶段只回复 ACK_INTERACTION_15。
t left.click({button:'middle'});await expect(left).toHaveAttribute('aria-pressed','false');
    expect(await left.evaluate(e=>!e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})))).toBe(true);
    await left.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(page.locator('#status')).toContainText('已选择：Left');
    await right.click();await expect(left).toHaveAttribute('aria-pressed','true');await expect(right).toHaveAttribute('aria-pressed','false');
    expect(f.requests()).toBe(0);
    await expect(page.locator('#status')).toContainText('第 2 次呈现');
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
  try{await page.getByRole('button',{name:'开始本组'}).tap();await expect(page.locator('#status')).toContainText('第 1 次呈现');
    await page.getByRole('button',{name:'Left',exact:true}).tap();await expect(page.getByRole('button',{name:'Left',exact:true})).toHaveAttribute('aria-pressed','true');
    // Watch every frame: ordinary assertion polling can miss a short interval.
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='请等待下一次呈现。');
    await page.evaluate(()=>{const r=document.querySelector('.response-buttons button')!.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'touch',button:0,clientX:r.x+10,clientY:r.y+10}));});
    await expect(page.locator('#status')).toContainText('第 2 次呈现');
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

test('one rating plus age advances before submitting and honors frozen age bounds without moving the image',async({page})=>{
  const f=await start(page,true,true);try{
    await page.getByRole('button',{name:'开始本组'}).click();const range=page.getByRole('slider',{name:'测试项目'});await expect(range).toBeVisible();
    const before=await page.locator('#stimulus').boundingBox();await expect(page.locator('#status')).toHaveText('第 1/1 张');await expect(page.getByRole('button',{name:'下一题',exact:true})).toBeDisabled();
    await range.press('End');await expect(page.locator('#status')).toHaveText('第 1/1 张');await expect(page.locator('.rating-axis output').first()).toHaveText('已选择：9 · 非常');
    await page.getByRole('button',{name:'下一题',exact:true}).click();const age=page.getByRole('textbox',{name:'你的年龄是？'});await expect(age).toBeVisible();await expect(page.locator('.rating-age-hint')).toHaveText('18–65 岁');
    await age.press('5');await expect(age).toHaveAttribute('aria-invalid','true');await expect(page.getByRole('button',{name:'提交评分'})).toBeDisabled();
    await age.press('Backspace');await age.press('1');await age.press('8');await expect(page.getByRole('button',{name:'提交评分'})).toBeEnabled();expect(await page.locator('#stimulus').boundingBox()).toEqual(before);
    await page.getByRole('button',{name:'提交评分'}).click();await expect(page.locator('#done')).toBeVisible({timeout:10000});expect(f.records().find((r:any)=>r.type==='RATING').values).toEqual([9,18]);expect(f.view().diagnostics).toHaveLength(0);expect(f.view().permit.state).toBe('CLOSED_NORMAL');
  }finally{f.close();}
});

```


=== FILE tests/runner-browser/layout.spec.ts (complete source; may continue in next chunk) ===
```
import {test,expect} from '@playwright/test';

test('document pages scroll on touch, wrap titles, and use the configured selected-option color',async({page})=>{
  await page.setViewportSize({width:320,height:480});
  await page.goto('/run.html');
  const result=await page.evaluate(async()=>{
    // Browser URL resolved by Vite at runtime, not a TypeScript module path.
    const themeUrl='/participant-theme.ts';
    const {applyParticipantBackground}=await import(themeUrl);
    applyParticipantBackground('#123456');
    const title=document.querySelector<HTMLElement>('#title')!;
    title.textContent='这是一份需要完整显示的很长的研究标题'.repeat(4);
    const content=document.querySelector<HTMLElement>('#content')!;
    content.innerHTML='<button class="choice-button" aria-pressed="true"><span>已选答案</span></button><div style="height:1500px">可滚动正文</div>';
    const move=new Event('touchmove',{bubbles:true,cancelable:true});content.dispatchEvent(move);
    scrollTo(0,200);
    const documentState={prevented:move.defaultPrevented,scroll:scrollY,titleHeight:title.clientHeight,titleOverflow:title.scrollHeight>title.clientHeight,color:getComputedStyle(content.querySelector('span')!).color};
    document.body.classList.add('runner-layout');
    const taskMove=new Event('touchmove',{bubbles:true,cancelable:true});content.dispatchEvent(taskMove);
    document.body.classList.remove('runner-layout');
    return {...documentState,taskPrevented:taskMove.defaultPrevented};
  });
  expect(result.prevented).toBe(false);expect(result.scroll).toBeGreaterThan(0);
  expect(result.titleHeight).toBeGreaterThan(27);expect(result.titleOverflow).toBe(false);
  expect(result.color).toBe('rgb(18, 52, 86)');expect(result.taskPrevented).toBe(true);
});

test('missing native Web Locks stops admission before creating a participant session',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));
  const requests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/participate/'))requests.push(r.url());});
  await page.goto('/participate.html?version=test-version');
  await expect(page.locator('#status')).toContainText('HTTPS');
  expect(requests).toHaveLength(0);
  expect(await page.evaluate(()=>navigator.locks)).toBeUndefined();
});

```
