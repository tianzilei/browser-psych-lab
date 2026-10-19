import {test,expect,type Page} from '@playwright/test';

async function list(page:Page,count=5){
  await page.route('**/api/questionnaires',route=>route.fulfill({json:{questionnaires:Array.from({length:count},(_,i)=>({title:`手机问卷 ${i+1}`,version_id:`test-${i}`}))}}));
  await page.goto('/');await expect(page.locator('article')).toHaveCount(count);
}
for(const viewport of [{width:393,height:664},{width:390,height:844},{width:320,height:480}])test(`list scrolling ends at the last card with no outer blank scroll region at ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);await list(page);
  const state=await page.evaluate(()=>{
    const main=document.querySelector('main')!;main.scrollTop=1e6;window.scrollTo(0,1e6);document.body.scrollTop=1e6;
    const last=main.querySelector('article:last-child')!.getBoundingClientRect(),bounds=main.getBoundingClientRect();
    return{rootScroll:scrollY,bodyScroll:document.body.scrollTop,rootOverflow:document.documentElement.scrollHeight-document.documentElement.clientHeight,height:bounds.height,innerHeight,bottomGap:bounds.bottom-last.bottom,scroll:main.scrollTop};
  });
  expect(state.rootScroll).toBe(0);expect(state.bodyScroll).toBe(0);expect(state.rootOverflow).toBeLessThanOrEqual(1);expect(state.height).toBeLessThanOrEqual(state.innerHeight);expect(state.bottomGap).toBeGreaterThanOrEqual(15);
  if(state.scroll>0)expect(state.bottomGap).toBeLessThanOrEqual(17);
  await expect(page.getByRole('link',{name:'进入问卷：手机问卷 5',exact:true})).toBeInViewport();
});
test('list touch edges stop outer scrolling while interior drags and pinch gestures remain available',async({page})=>{
  await page.setViewportSize({width:393,height:400});await list(page);
  const results=await page.evaluate(()=>{
    const main=document.querySelector('main')!;
    const event=(type:string,points:number[],clientX=0)=>{const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:points.map(clientY=>({clientX,clientY}))});main.dispatchEvent(e);return e.defaultPrevented;};
    main.scrollTop=0;event('touchstart',[100]);const top=event('touchmove',[120]),inward=event('touchmove',[110]);
    main.scrollTop=100;event('touchstart',[100]);const middle=event('touchmove',[80]);
    main.scrollTop=1e6;event('touchstart',[100]);const bottom=event('touchmove',[80]),reverse=event('touchmove',[100]);
    event('touchstart',[100,150]);const pinch=event('touchmove',[80,170]);event('touchstart',[100]);const horizontal=event('touchmove',[110],100);return{top,inward,middle,bottom,reverse,pinch,horizontal};
  });
  expect(results).toEqual({top:true,inward:false,middle:false,bottom:true,reverse:false,pinch:false,horizontal:false});
  await page.route('**/api/questionnaires',route=>route.fulfill({json:{questionnaires:[{title:'只有一份',version_id:'one'}]}}));await page.reload();await expect(page.locator('article')).toHaveCount(1);
  expect(await page.evaluate(()=>{const main=document.querySelector('main')!;main.scrollTop=1e6;return main.scrollTop;})).toBe(0);
});
test('list viewport is bounded during stale measurements and updates again after back-forward restoration',async({page})=>{
  await page.setViewportSize({width:393,height:664});await list(page);
  await page.evaluate(()=>{
    let height=1200;Object.defineProperty(visualViewport!,'height',{configurable:true,get:()=>height});
    Object.assign(window,{setTestViewport:(next:number)=>{height=next;}});visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(()=>page.locator('main').evaluate(node=>node.getBoundingClientRect().height)).toBe(664);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));(window as any).setTestViewport(530);window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await expect.poll(()=>page.locator('main').evaluate(node=>node.getBoundingClientRect().height)).toBe(530);
  await page.evaluate(()=>{(window as any).setTestViewport(600);visualViewport!.dispatchEvent(new Event('resize'));});
  await expect.poll(()=>page.locator('main').evaluate(node=>node.getBoundingClientRect().height)).toBe(600);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));(window as any).setTestViewport(664);window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await expect.poll(()=>page.locator('main').evaluate(node=>node.getBoundingClientRect().height)).toBe(664);
});
