import {test,expect} from '@playwright/test';
import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
import type {InteractionBatch,InteractionScreen} from '../../src/shared/interaction.js';

for(const background of ['#e5e5e5','#202020'])test(`snapshot matches wrapped text, selected markers, clipping and controls on ${background}`,async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:640});await page.goto('/participate.html');
  const captured=await page.evaluate(async(background)=>{
    const {recordInteractions}=await import('/interaction-recorder.ts' as string);
    const {choiceButton}=await import('/questionnaire-controls.ts' as string);
    const {applyParticipantBackground}=await import('/participant-theme.ts' as string);applyParticipantBackground(background);
    const root=document.querySelector('main')!;root.replaceChildren();root.style.cssText='position:fixed;inset:0;width:390px;height:640px;padding:20px;display:block;min-height:0';
    const paragraph=document.createElement('p');paragraph.style.cssText='font-size:18px;line-height:1.45;white-space:pre-wrap;width:260px';paragraph.textContent='这里是一段需要按照原始浏览器布局换行的中文题目，含 ABC 123。\n第二段保留换行。';root.append(paragraph);
    for(const type of ['single','multi']){const choice=choiceButton({type},'已选中：完整文字',true);choice.style.marginTop='16px';choice.style.height='52px';root.append(choice);}
    const input=document.createElement('input');input.type='text';input.value='已输入的答案';input.style.marginTop='16px';root.append(input);
    const clipped=document.createElement('div');clipped.style.cssText='width:160px;height:22px;overflow:hidden;margin-top:16px';const overflow=document.createElement('p');overflow.textContent='裁剪内容：这一行后面的文字和下一行应被裁剪掉';overflow.style.cssText='width:260px;line-height:24px';clipped.append(overflow);root.append(clipped);
    const hidden=document.createElement('div');hidden.style.opacity='0';hidden.textContent='隐藏元素不可出现';root.append(hidden);
    const batches:InteractionBatch[]=[];const recorder=recordInteractions(root,()=>({page_id:'visual'}),async(batch:InteractionBatch)=>{batches.push(batch);},(error:unknown)=>{throw error;});await recorder.stop();
    const screen=batches.flatMap(batch=>batch.samples).find(sample=>sample.type==='screen') as InteractionScreen;
    (window as any).replayScreen=screen;return screen;
  },background);
  await writeFile(testInfo.outputPath('snapshot.json'),JSON.stringify(captured,null,2));
  expect(captured.render_version).toBe(2);expect(captured.nodes_truncated).toBe(false);
  const lines=captured.nodes.filter(node=>node.tag==='text');expect(lines.length).toBeGreaterThan(4);expect(lines.map(node=>node.text).join('')).toContain('原始浏览器');
  expect(captured.nodes.filter(node=>node.tag==='pseudo')).toHaveLength(2);
  expect(captured.nodes.some(node=>node.text.includes('隐藏元素'))).toBe(false);
  expect(captured.nodes.some(node=>node.clip&&node.tag==='text')).toBe(true);
  const original=await page.screenshot({path:testInfo.outputPath('original.png')});
  await page.evaluate(async()=>{
    const {renderReplayScreen}=await import('/replay-renderer.ts' as string),screen=(window as any).replayScreen as InteractionScreen;
    const canvas=document.createElement('canvas');canvas.width=screen.width;canvas.height=screen.height;canvas.style.cssText='position:fixed;inset:0;border:0;border-radius:0;max-width:none;width:390px;height:640px';
    document.body.replaceChildren(canvas);renderReplayScreen(canvas.getContext('2d')!,screen,()=>undefined);
  });
  const replay=await page.screenshot({path:testInfo.outputPath('replay.png')});
  const a=await sharp(original).removeAlpha().raw().toBuffer(),b=await sharp(replay).removeAlpha().raw().toBuffer();
  let changed=0;for(let i=0;i<a.length;i+=3)if(Math.max(Math.abs(a[i]!-b[i]!),Math.abs(a[i+1]!-b[i+1]!),Math.abs(a[i+2]!-b[i+2]!))>40)changed++;
  const difference=changed/(390*640);await testInfo.attach('visual-difference',{body:JSON.stringify({difference}),contentType:'application/json'});expect(difference).toBeLessThan(.015);
  for(const top of [150,218]){let different=0;for(let y=top;y<top+30;y++)for(let x=60;x<190;x++){const i=(y*390+x)*3;if(Math.abs(a[i]!-b[i]!)>40)different++;}expect(different/(130*30)).toBeLessThan(.06);}
});

test('drag frames and asynchronous DOM changes are captured after handlers settle',async({page})=>{
  await page.goto('/participate.html');
  const screens=await page.evaluate(async()=>{
    const {recordInteractions}=await import('/interaction-recorder.ts' as string),root=document.querySelector<HTMLElement>('#content')!;
    const input=document.createElement('input');input.type='range';input.min='1';input.max='9';input.value='1';root.replaceChildren(input);
    input.onpointermove=()=>{input.value=String(Number(input.value)+1);input.dataset.answered='true';};
    const batches:InteractionBatch[]=[];const recorder=recordInteractions(root,()=>({page_id:'drag'}),async(batch:InteractionBatch)=>{batches.push(batch);},(error:unknown)=>{throw error;});
    for(let i=0;i<3;i++){input.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,buttons:1,clientX:10+i,clientY:20}));await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
    await Promise.resolve();const label=document.createElement('p');label.textContent='异步保存完成';root.append(label);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));await recorder.stop();
    return batches.flatMap(batch=>batch.samples).filter(sample=>sample.type==='screen') as InteractionScreen[];
  });
  expect(screens.map(screen=>screen.nodes.find(node=>node.tag==='range')?.value)).toEqual(expect.arrayContaining(['1','2','3','4']));
  expect(screens.at(-1)!.nodes.some(node=>node.text==='异步保存完成')).toBe(true);
});

test('dense action playback reuses the static screen, follows elapsed time and supports exact action stepping',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const {mountReplayPlayer}=await import('/replay-player.ts' as string);
    const callbacks=new Map<number,FrameRequestCallback>();let sequence=0,now=0,paints=0;
    const raf=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,originalNow=performance.now,originalText=CanvasRenderingContext2D.prototype.fillText;
    window.requestAnimationFrame=callback=>{callbacks.set(++sequence,callback);return sequence;};window.cancelAnimationFrame=id=>{callbacks.delete(id);};performance.now=()=>now;
    CanvasRenderingContext2D.prototype.fillText=function(...args:Parameters<typeof originalText>){paints++;return originalText.apply(this,args);};
    const canvas=document.createElement('canvas'),controls=document.createElement('div'),status=document.createElement('p'),details=document.createElement('pre');document.body.replaceChildren(controls,canvas,status,details);
    const screen:InteractionScreen={type:'screen',at:0,context:{page_id:'dense'},width:390,height:640,dpr:3,scroll_x:0,scroll_y:0,visual_viewport:null,background:'#fff',render_version:2,nodes:[{tag:'text',x:10,y:10,width:200,height:20,text:'静态内容',style:{'font-size':'16px'}}]};
    const items:any[]=[{time:1000,sample:screen}];for(let i=1;i<=20000;i++)items.push({time:1000+i/10,sample:{type:'pointermove',at:i/10,context:{page_id:'dense'},x:i%300,y:100,pointer_id:1}});
    let dispose=()=>{};
    try{
      dispose=mountReplayPlayer({items,canvas,controls,status,details,assetURL:()=>''});const slider=controls.querySelector('input')!;
      (controls.children[1] as HTMLButtonElement).click();
      for(let i=1;i<=120;i++){now=i*2000/120;const frame=[...callbacks.values()];callbacks.clear();for(const callback of frame)callback(now);}
      const final={paints,value:Number(slider.value),max:Number(slider.max),playing:(controls.children[1] as HTMLButtonElement).textContent,detail:JSON.parse(details.textContent!)};
      slider.value='1000';slider.dispatchEvent(new Event('input'));const sought=JSON.parse(details.textContent!);(controls.children[0] as HTMLButtonElement).click();const previous=JSON.parse(details.textContent!);(controls.children[2] as HTMLButtonElement).click();const next=JSON.parse(details.textContent!);
      return {...final,sought:sought.at,previous:previous.at,next:next.at,remaining:callbacks.size};
    }finally{dispose();window.requestAnimationFrame=raf;window.cancelAnimationFrame=cancel;performance.now=originalNow;CanvasRenderingContext2D.prototype.fillText=originalText;}
  });
  expect(result.paints).toBe(1);expect(result.value).toBe(2000);expect(result.max).toBe(2000);expect(result.playing).toBe('播放');expect(result.detail.at).toBe(2000);
  expect(result.sought).toBe(1000);expect(result.previous).toBe(999.9);expect(result.next).toBe(1000);expect(result.remaining).toBe(0);
});

test('legacy snapshots wrap text and the high-DPI player keeps CSS coordinates',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const {mountReplayPlayer}=await import('/replay-player.ts' as string),calls:{text:string;args:number}[]=[];
    const original=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(...args:Parameters<typeof original>){calls.push({text:args[0],args:args.length});return original.apply(this,args);};
    const canvas=document.createElement('canvas');let dispose=()=>{};
    try{dispose=mountReplayPlayer({canvas,items:[{time:0,sample:{type:'screen',at:0,context:{},width:390,height:640,dpr:3,scroll_x:0,scroll_y:0,visual_viewport:null,background:'#fff',nodes:[{x:10,y:10,width:80,height:200,tag:'text',text:'历史记录中的长中文文本需要换行',style:{'font-size':'16px','line-height':'24px'}}]}}],controls:document.createElement('div'),status:document.createElement('p'),details:document.createElement('pre'),assetURL:()=>''});return {calls,width:canvas.style.width,height:canvas.style.height,backing:canvas.width,ratio:devicePixelRatio};}
    finally{dispose();CanvasRenderingContext2D.prototype.fillText=original;}
  });
  expect(result.calls.length).toBeGreaterThan(1);expect(result.calls.every(call=>call.args===3)).toBe(true);expect(result.width).toBe('390px');expect(result.height).toBe('auto');expect(result.backing).toBe(Math.round(390*Math.min(2,result.ratio)));
});

test('dark text stimuli replay with their original canvas dimensions and feedback text',async({page})=>{
  await page.setViewportSize({width:390,height:300});await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const {drawTextStimulus}=await import('/stimulus.ts' as string),{recordInteractions}=await import('/interaction-recorder.ts' as string),{renderReplayScreen}=await import('/replay-renderer.ts' as string);
    document.documentElement.style.background='#202020';const root=document.querySelector('main')!;root.style.cssText='position:fixed;inset:0;padding:0;display:block;min-height:0';root.replaceChildren();
    const stimulus=document.createElement('canvas');stimulus.width=780;stimulus.height=400;stimulus.style.cssText='width:390px;height:200px;border:0;border-radius:0';root.append(stimulus);
    const original=stimulus.getContext('2d')!;original.fillStyle='#202020';original.fillRect(0,0,780,400);drawTextStimulus(original,stimulus,'回答正确\n等待下一次呈现','#202020');
    const batches:InteractionBatch[]=[];const recorder=recordInteractions(root,()=>({instance_id:'text-1',stimulus_text:'原题文字'}),async(batch:InteractionBatch)=>{batches.push(batch);},(error:unknown)=>{throw error;});await recorder.stop();
    const screen=batches.flatMap(batch=>batch.samples).find(sample=>sample.type==='screen') as InteractionScreen;
    const replay=document.createElement('canvas');replay.width=780;replay.height=600;const ctx=replay.getContext('2d')!;ctx.scale(2,2);renderReplayScreen(ctx,screen,()=>undefined);
    const a=original.getImageData(0,0,780,400).data,b=ctx.getImageData(0,0,780,400).data;let changed=0,bright=0;for(let i=0;i<a.length;i+=4){if(a[i]!>180)bright++;if(Math.abs(a[i]!-b[i]!)>40)changed++;}
    return {node:screen.nodes.find(node=>node.tag==='canvas'),changed,bright,background:screen.background};
  });
  expect(result.node).toMatchObject({canvas_width:780,canvas_height:400,text:'回答正确\n等待下一次呈现'});expect(result.bright).toBeGreaterThan(100);expect(result.changed,JSON.stringify(result)).toBe(0);
});

test('image decoding is prefetched across repeated snapshots before the next photo is selected',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const {mountReplayPlayer}=await import('/replay-player.ts' as string);
    const source=document.createElement('canvas');source.width=source.height=8;const context=source.getContext('2d')!,urls:Record<string,string>={};for(const [id,color]of [['red','#ff0000'],['blue','#0000ff']]){context.fillStyle=color!;context.fillRect(0,0,8,8);urls[id!]=source.toDataURL();}
    const base:InteractionScreen={type:'screen',at:0,context:{},width:80,height:80,dpr:1,scroll_x:0,scroll_y:0,visual_viewport:null,background:'#fff',render_version:2,nodes:[]};
    const items=Array.from({length:101},(_,index)=>({time:index*10,sample:{...base,at:index*10,nodes:[{x:0,y:0,width:80,height:80,tag:'canvas',text:'',asset_id:index===100?'blue':'red',style:{}}]}}));
    const canvas=document.createElement('canvas'),controls=document.createElement('div'),requested:string[]=[];document.body.replaceChildren(controls,canvas);
    const dispose=mountReplayPlayer({items,canvas,controls,status:document.createElement('p'),details:document.createElement('pre'),assetURL:(id:string)=>{requested.push(id);return urls[id]!;}});
    try{
      for(let i=0;i<30;i++){if(canvas.getContext('2d')!.getImageData(10,10,1,1).data[0]===255&&canvas.getContext('2d')!.getImageData(10,10,1,1).data[1]===0)break;await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
      const first=[...canvas.getContext('2d')!.getImageData(10,10,1,1).data],prefetched=[...requested];
      const slider=controls.querySelector('input')!;slider.value='1000';slider.dispatchEvent(new Event('input'));
      for(let i=0;i<30;i++){if(canvas.getContext('2d')!.getImageData(10,10,1,1).data[2]===255&&canvas.getContext('2d')!.getImageData(10,10,1,1).data[0]===0)break;await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
      return {first,prefetched,last:[...canvas.getContext('2d')!.getImageData(10,10,1,1).data],requested};
    }finally{dispose();}
  });
  expect(result.first).toEqual([255,0,0,255]);expect(result.prefetched).toEqual(['red','blue']);expect(result.last).toEqual([0,0,255,255]);expect(result.requested).toEqual(['red','blue']);
});
