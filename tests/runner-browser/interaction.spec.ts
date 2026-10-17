import {test,expect} from '@playwright/test';

test('disabled capture installs no listeners and never reads context or emits snapshots and input',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const source='/interaction-recorder.ts';const {recordInteractions}=await import(source);
    const root=document.querySelector<HTMLElement>('#content')!,input=document.createElement('input');root.replaceChildren(input);
    let listeners=0,contexts=0,saves=0,failures=0;
    const original=EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener=function(...args:Parameters<typeof original>){listeners++;return original.apply(this,args);};
    let recorder:ReturnType<typeof recordInteractions>;
    try{recorder=recordInteractions(root,()=>{contexts++;throw new Error('Disabled capture read context');},async()=>{saves++;},()=>{failures++;},false);}
    finally{EventTarget.prototype.addEventListener=original;}
    input.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:12,clientY:34}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'unrecorded'}));
    window.dispatchEvent(new Event('resize'));document.dispatchEvent(new Event('visibilitychange'));
    recorder.screen();await recorder.flush();await recorder.stop();recorder.screen();await recorder.stop();
    return {listeners,contexts,saves,failures};
  });
  expect(result).toEqual({listeners:0,contexts:0,saves:0,failures:0});
});

test('optional formatted personal information can be cleared and skipped after validation',async({page})=>{
  await page.goto('/participate.html');
  await page.evaluate(async()=>{
    const source='/survey-page.ts';
    const {mountPage}=await import(source);
    (window as any).submitted=[];
    mountPage(document.querySelector('#content'),{id:'personal',title:'Interaction regression',instruction:'',questions:[
      {id:'name',type:'text',input_purpose:'personal',title:'可选姓名',required:false,max_length:30,input_match:{kind:'regex',pattern:'[A-Z]{2,10}',message:'请输入大写姓名'}},
      {id:'done',type:'single',title:'确认继续',required:true,choices:['继续']},
    ]},{},{},()=>{},(answers:unknown)=>(window as any).submitted.push(answers),{key:'interaction-optional',title:'Interaction regression'});
  });
  const input=page.getByRole('textbox',{name:'可选姓名'});
  await input.fill('wrong');await page.getByRole('button',{name:'完成输入'}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('请输入大写姓名');
  await input.fill('');await page.getByRole('button',{name:'完成输入'}).click();
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await expect(page.getByRole('button',{name:'继续',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('button',{name:'提交本页'}).click();
  expect(await page.evaluate(()=>(window as any).submitted)).toEqual([{name:'',done:'继续'}]);
});

test('large diagnostic screens fit the event budget and retain native input samples',async({page})=>{
  await page.goto('/participate.html');
  const result=await page.evaluate(async()=>{
    const source='/interaction-recorder.ts';const {recordInteractions}=await import(source);
    const root=document.querySelector<HTMLElement>('#content')!;root.replaceChildren();
    for(let i=0;i<1200;i++){const node=document.createElement('button');node.textContent=`选项 ${i}：${'完整中文内容'.repeat(30)}`;root.append(node);}
    const input=document.createElement('input');input.value='保留完整输入';root.append(input);
    const batches:any[]=[],errors:string[]=[],data='原始输入'.repeat(1000);
    const recorder=recordInteractions(root,()=>({page_id:'large-screen'}),async(batch:unknown)=>{batches.push(batch);},(error:unknown)=>errors.push(String(error)));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data}));
    await recorder.stop();
    const samples=batches.flatMap(batch=>batch.samples),screens=samples.filter(sample=>sample.type==='screen');
    return {errors,sizes:batches.map(batch=>new TextEncoder().encode(JSON.stringify(batch)).length),screens:screens.map(screen=>({truncated:screen.nodes_truncated,nodes:screen.nodes.length})),input:samples.find(sample=>sample.type==='input'),data};
  });
  expect(result.errors).toEqual([]);expect(result.sizes.length).toBeGreaterThan(0);
  expect(result.sizes.every((size:number)=>size<=91000)).toBe(true);
  expect(result.screens.every((screen:any)=>screen.truncated&&screen.nodes>0&&screen.nodes<1900)).toBe(true);
  expect(result.input).toMatchObject({value:'保留完整输入',data:result.data,input_type:'insertText'});
});
