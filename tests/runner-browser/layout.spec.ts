import {test,expect} from '@playwright/test';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.js';

for(const viewport of [{width:704,height:755},{width:390,height:660},{width:320,height:480}])test(`simulation keeps portraits and all response controls inside ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);
  await page.goto('/simulate.html');
  await page.route('**/api/lab/assets/layout-portrait',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="413" height="626"><rect width="413" height="626" fill="#587a91"/></svg>'}));
  const protocol=compileQuestionnaire({schema:'questionnaire-v1',title:'医生第一印象评分',orientation:'portrait',pages:[],groups:[{id:'ratings',title:'医生第一印象评分',choices:['1','2','3','4','5','6','7','8','9'],repeats:0,rating:{prompt:'请评分',items:['您觉得这位医生看起来有多值得信任？'],labels:['完全不','非常少','较少','有一点','一般','较多','很多','几乎完全','非常']},trials:[{root_id:'portrait',asset_id:'layout-portrait',correct:null,image_ms:1,isi_ms:3000}]}]});
  await page.evaluate(protocol=>window.postMessage({type:'lab-simulation',protocol},location.origin),protocol);
  await expect(page.locator('#status')).toContainText('模拟图片');
  await page.locator('img').evaluate((e:HTMLImageElement)=>e.decode());
  const clipped=await page.evaluate(()=>[...document.querySelectorAll('main button,main img')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.x<0||r.y<0||r.right>innerWidth+1||r.bottom>innerHeight+1);}).map(e=>e.textContent||e.tagName));
  expect(clipped).toEqual([]);
  await page.getByRole('slider',{name:'您觉得这位医生看起来有多值得信任？',exact:true}).press('End');
  await page.getByRole('button',{name:'提交评分',exact:true}).click();
  await expect(page.locator('#status')).toContainText('模拟完成');
});

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
