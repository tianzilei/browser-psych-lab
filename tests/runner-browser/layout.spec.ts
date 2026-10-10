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
