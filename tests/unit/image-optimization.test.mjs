import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,readFile,writeFile,rm,readdir,access,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {planImage,resolveImageTarget,planImageTiles} from '../../src/shared/image-plan.ts';
import {optimizeImage,packImageZip,validateVariantOptions} from '../../src/server/offline-image.ts';
import {unpackImages} from '../../src/server/image-package.ts';
import {publishImageOutput} from '../../scripts/image-output.mjs';

test('DPR policy, aspect ratio buckets, and hard pixel limits',()=>{
  const opts={viewport:{width:375,height:250},deviceDpr:3};
  assert.deepEqual(resolveImageTarget(opts),{width:768,height:512,dpr:2,budget:120*1024});
  assert.equal(resolveImageTarget({...opts,saveData:true}).dpr,1);
  assert.equal(resolveImageTarget({...opts,density:1.5}).dpr,1.5);
  assert.equal(resolveImageTarget({...opts,density:3}).dpr,2);
  assert.equal(resolveImageTarget({...opts,density:3,zoom:true}).dpr,3);
  const limited=resolveImageTarget({viewport:{width:100000,height:20000},maxPixels:100000});
  assert.ok(limited.width*limited.height<=100000);
  const extreme=resolveImageTarget({viewport:{width:100000,height:1},maxPixels:10});
  assert.ok(extreme.width*extreme.height<=10);
  assert.throws(()=>resolveImageTarget({viewport:{width:NaN,height:1}}),/INVALID_IMAGE_DIMENSION/);
  assert.throws(()=>resolveImageTarget({maxPixels:Infinity}),/INVALID_IMAGE_PIXEL_LIMIT/);
});
test('common ratios keep original framing in contain and never upscale',()=>{
  for(const [w,h] of [[1,1],[4,3],[3,4],[16,9],[9,16],[3,2],[2,3],[8,1],[1,10]]){
    const source={width:w*100,height:h*100},p=planImage(source,{viewport:{width:360,height:240}});
    assert.deepEqual(p.crop,{left:0,top:0,...source});
    assert.ok(p.output.width<=source.width&&p.output.height<=source.height);
    assert.ok(p.output.width<=p.target.width&&p.output.height<=p.target.height);
    assert.ok(Math.abs(p.output.width/p.output.height-w/h)<.02);
  }
  assert.deepEqual(planImage({width:80,height:120}).output,{width:80,height:120});
});
test('cover protects whole subject region and falls back for text or severe unknown crops',()=>{
  const opts={scene:'avatar',protectedRegion:{x:.8,y:.2,width:.15,height:.2}};
  const p=planImage({width:1600,height:900},opts);
  assert.equal(p.fit,'cover');assert.ok(p.crop.left<=1280-36);
  assert.ok(p.crop.left+p.crop.width>=1520+36);
  const text=planImage({width:1600,height:900},{...opts,content:'text'});
  assert.equal(text.fit,'contain');assert.equal(text.fallback,'text-protection');
  const group=planImage({width:1600,height:900},{...opts,protectedRegion:{x:0,y:.1,width:1,height:.3}});
  assert.equal(group.fit,'contain');assert.equal(group.fallback,'protected-region-does-not-fit');
  const wide=planImage({width:4000,height:500},{scene:'avatar'});
  assert.equal(wide.fit,'contain');assert.equal(wide.fallback,'unsafe-crop-without-subject');
  const focus=planImage({width:4000,height:500},{scene:'avatar',focus:{x:.9,y:.5}});
  assert.equal(focus.fit,'cover');assert.equal(focus.crop.left,3350);
  assert.throws(()=>planImage({width:100,height:100},{focus:{x:2,y:0}}),/INVALID_IMAGE_REGION/);
});
test('long image tiles cover source rows exactly once without enlargement',()=>{
  const tiles=planImageTiles({width:1000,height:30000},{viewport:{width:360,height:240},density:1.5},1024);
  assert.ok(tiles.length>1);let row=0;
  for(const t of tiles){assert.equal(t.crop.top,row);row+=t.crop.height;
    assert.equal(t.crop.width,1000);assert.ok(t.output.height<=1024);assert.ok(t.output.width<=1000);}
  assert.equal(row,30000);
  assert.throws(()=>planImageTiles({width:10,height:100000},{},32),/TOO_MANY_IMAGE_TILES/);
});
test('actual encoder normalizes EXIF, strips metadata and emits acceptable ZIP',async()=>{
  const input=await sharp({create:{width:90,height:60,channels:3,background:'#438278'}})
    .jpeg().withMetadata({orientation:6}).toBuffer();
  const {source,outputs}=await optimizeImage(input,{viewport:{width:60,height:90}});
  assert.deepEqual([source.width,source.height],[60,90]);
  assert.deepEqual([outputs[0].report.width,outputs[0].report.height],[60,90]);
  assert.equal((await sharp(outputs[0].bytes).metadata()).exif,undefined);
  const zip=packImageZip([{path:'images/normalized.webp',bytes:outputs[0].bytes}]);
  assert.deepEqual(unpackImages(zip)[0].bytes,outputs[0].bytes);
});
test('text stays lossless at impossible byte budget and transparency survives',async()=>{
  const input=await sharp({create:{width:40,height:30,channels:4,background:{r:42,g:84,b:126,alpha:.5}}}).png().toBuffer();
  const {outputs}=await optimizeImage(input,{content:'text',budgetBytes:1});
  assert.equal(outputs[0].report.lossless,true);assert.equal(outputs[0].report.budgetExceeded,true);
  assert.deepEqual(await sharp(outputs[0].bytes).raw().toBuffer(),await sharp(input).raw().toBuffer());
  await assert.rejects(optimizeImage(input,{format:'jpeg'}),/JPEG_CANNOT_PRESERVE_ALPHA/);
  await assert.rejects(optimizeImage(Buffer.from('invalid image')),/unsupported image format/i);
});
test('photo byte search respects quality floor and JPEG/PNG stay accepted',async()=>{
  const input=await sharp(await readFile('examples/stimuli/mobile-card.png')).removeAlpha().png().toBuffer();
  const result=await optimizeImage(input,{quality:88,minQuality:78,budgetBytes:1});
  assert.ok(result.outputs[0].report.quality>=78);assert.equal(result.outputs[0].report.budgetExceeded,true);
  for(const format of ['jpeg','png']){
    const encoded=await optimizeImage(input,{format});
    assert.equal(encoded.outputs[0].report.format,format);
    assert.equal((await sharp(encoded.outputs[0].bytes).metadata()).orientation,undefined);
  }
});
test('real long image output keeps every row and does not create full-height bitmap assets',async()=>{
  const input=await sharp({create:{width:10,height:125,channels:3,background:'#123456'}}).png().toBuffer();
  const {outputs}=await optimizeImage(input,{content:'text',tiles:true,tileHeight:32});
  assert.deepEqual(outputs.map(o=>o.report.height),[32,32,32,29]);
  const raw=await sharp(input).raw().toBuffer();
  const rows=await Promise.all(outputs.map(o=>sharp(o.bytes).raw().toBuffer()));
  assert.deepEqual(Buffer.concat(rows),raw);
});
test('real crop preserves red subject and independent variants keep same source hash',async()=>{
  const input=await sharp({create:{width:200,height:100,channels:3,background:'#0000ff'}})
    .composite([{input:await sharp({create:{width:40,height:40,channels:3,background:'#ff0000'}}).png().toBuffer(),left:150,top:30}]).png().toBuffer();
  const {outputs}=await optimizeImage(input,{scene:'avatar',format:'png',protectedRegion:{x:.75,y:.3,width:.2,height:.4}});
  const raw=await sharp(outputs[0].bytes).raw().toBuffer({resolveWithObject:true});
  let red=0;for(let i=0;i<raw.data.length;i+=raw.info.channels)if(raw.data[i]>240&&raw.data[i+2]<10)red++;
  assert.equal(red,1600);assert.equal(raw.info.width,100);assert.equal(raw.info.height,100);
  const small=await optimizeImage(input,{viewport:{width:50,height:25},density:1,format:'png'});
  assert.equal(small.source.sha256,(await optimizeImage(input)).source.sha256);
});
test('offline CLI produces uploadable package, report, and never overwrites masters or prior output',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bpl-image-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const original=await readFile('examples/stimuli/mobile-card.png');await writeFile(join(dir,'master.png'),original);
  await writeFile(join(dir,'config.json'),JSON.stringify({schema:'mobile-images-v1',package:'test.zip',defaults:{content:'text'},
    images:[{source:'master.png',variants:[{name:'card'},{name:'small',density:1}]}]}));
  const cli=resolve('scripts/prepare-images.mjs'),run=()=>execFileSync(process.execPath,['--import','tsx',cli,join(dir,'config.json'),join(dir,'output')],{encoding:'utf8',stdio:'pipe'});
  run();assert.deepEqual(await readFile(join(dir,'master.png')),original);
  const zip=unpackImages(await readFile(join(dir,'output','test.zip')));
  assert.deepEqual(zip.map(f=>f.path),['images/card.webp','images/small.webp']);
  const report=JSON.parse(await readFile(join(dir,'output','report.json'),'utf8'));
  assert.equal(report.images.length,2);assert.equal(report.images[0].sourceInfo.sha256,report.images[1].sourceInfo.sha256);
  const before=await readFile(join(dir,'output','test.zip'));assert.throws(run);assert.deepEqual(await readFile(join(dir,'output','test.zip')),before);
});
test('runtime options reject null, wrong types and overflow before decoding',async()=>{
  for(const options of [null,{content:'typo'},{density:null},{scene:'toString'},{format:null},{quality:null},
    {viewport:{width:1e-320,height:100}},{zoom:'yes'},{tiles:'yes'},{protectedRegion:null},
    {maxPixels:-1,budgetBytes:1024},{deviceDpr:0,budgetBytes:1024}]){
    assert.throws(()=>validateVariantOptions(options));
    await assert.rejects(optimizeImage(Buffer.from('bad source'),options),/IMAGE_|NULL_/);
  }
  assert.throws(()=>planImageTiles({width:10.5,height:100}),/INVALID_IMAGE_DIMENSION/);
  assert.throws(()=>planImageTiles({width:4096,height:15625},{viewport:{width:2048,height:512}}),/TILE_RASTER_PIXEL_LIMIT/);
});
test('protected edge tolerates numerical noise and overrides conflicting focus safely',()=>{
  assert.doesNotThrow(()=>planImage({width:1000,height:1000},{protectedRegion:{x:.7000000000000001,y:0,width:.3,height:1}}));
  const p=planImage({width:1000,height:1000},{viewport:{width:400,height:800},fit:'cover',
    protectedRegion:{x:.6,y:.1,width:.2,height:.2},focus:{x:0,y:1}});
  assert.equal(p.fit,'cover');assert.ok(p.crop.left<=570);assert.ok(p.crop.left+p.crop.width>=830);
  assert.ok(p.crop.top<=70);assert.ok(p.crop.top+p.crop.height>=330);
});
test('fractional-scale tiles equal a single Lanczos resize at every pixel without seams',async()=>{
  const width=101,height=777,data=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*3;data[i]=(y*17+x*13)%256;data[i+1]=(y*31+x*5)%256;data[i+2]=(y*19+x*23)%256;
  }
  const input=await sharp(data,{raw:{width,height,channels:3}}).png().toBuffer();
  const settings={viewport:{width:40,height:100},density:1,tiles:true,tileHeight:64,content:'text'};
  const plans=planImageTiles({width,height},settings,64),size=plans[0].fullOutput;
  assert.equal(plans.reduce((n,p)=>n+p.output.height,0),Math.round(height*size.width/width));
  const encoded=await optimizeImage(input,settings);
  const pieces=await Promise.all(encoded.outputs.map(o=>sharp(o.bytes).raw().toBuffer()));
  const expected=await sharp(input).resize(size.width,size.height,{fit:'fill',kernel:'lanczos3'})
    .withIccProfile('srgb',{attach:false}).toColourspace('srgb').raw().toBuffer();
  assert.deepEqual(Buffer.concat(pieces),expected);
});
test('all eight EXIF orientations crop in normalized coordinates',async()=>{
  const base=await sharp({create:{width:140,height:90,channels:3,background:'#143678'}})
    .composite([{input:await sharp({create:{width:30,height:30,channels:3,background:'#cc1100'}}).png().toBuffer(),left:100,top:10}]).png().toBuffer();
  const settings={scene:'avatar',format:'png',focus:{x:.8,y:.3}};
  for(let orientation=1;orientation<=8;orientation++){
    const tagged=await sharp(base).withMetadata({orientation}).png().toBuffer();
    const normalized=await sharp(tagged).autoOrient().png().toBuffer();
    const actual=(await optimizeImage(tagged,settings)).outputs[0].bytes;
    const expected=(await optimizeImage(normalized,settings)).outputs[0].bytes;
    assert.deepEqual(await sharp(actual).raw().toBuffer(),await sharp(expected).raw().toBuffer(),`orientation ${orientation}`);
  }
});
test('explicit P3 to sRGB transform strips ICC and quality retries reuse one raster',async()=>{
  const master=await sharp({create:{width:40,height:30,channels:3,background:'#996644'}}).withIccProfile('p3').png().toBuffer();
  const {outputs}=await optimizeImage(master,{content:'text'});
  const expected=await sharp(master).withIccProfile('srgb',{attach:false}).toColourspace('srgb').raw().toBuffer();
  assert.deepEqual(await sharp(outputs[0].bytes).raw().toBuffer(),expected);
  assert.equal((await sharp(outputs[0].bytes).metadata()).icc,undefined);
  const encoded=await optimizeImage(master,{budgetBytes:1,quality:88,minQuality:78});
  assert.equal(encoded.outputs[0].report.encodeAttempts,3);
  assert.ok(encoded.outputs[0].report.rasterBytes<=40*30*4);
});
test('ZIP rejects wrong extension, case collisions and Windows device paths',async()=>{
  const bytes=(await optimizeImage(await readFile('examples/stimuli/mobile-card.png'))).outputs[0].bytes;
  assert.throws(()=>packImageZip([{path:'images/card.png',bytes}]),/IMAGE_EXTENSION_MISMATCH/);
  assert.throws(()=>packImageZip([{path:'images/CARD.webp',bytes},{path:'images/card.webp',bytes}]),/DUPLICATE_IMAGE_PATH/);
  assert.throws(()=>packImageZip([{path:'images/aux.webp',bytes}]),/NON_PORTABLE_IMAGE_PATH/);
  assert.throws(()=>packImageZip([{path:'images\\aux.webp',bytes}]),/INVALID_IMAGE_PATH/);
});
test('atomic publisher cleans handled failures, allows retry and preserves prior empty directories',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bpl-publish-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const out=join(dir,'output');
  await assert.rejects(publishImageOutput(out,async stage=>{await writeFile(join(stage,'partial'),'x');throw new Error('injected write failure');}),/injected/);
  await assert.rejects(access(out));assert.deepEqual(await readdir(dir),[]);
  await publishImageOutput(out,stage=>writeFile(join(stage,'complete'),'ready'));
  assert.equal(await readFile(join(out,'complete'),'utf8'),'ready');
  const empty=join(dir,'empty');await mkdir(empty);
  await assert.rejects(publishImageOutput(empty,()=>Promise.resolve()),/IMAGE_OUTPUT_ALREADY_EXISTS/);
  assert.deepEqual(await readdir(empty),[]);
});
test('CLI rejects invalid plans before opening missing sources and groups repeated source reads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bpl-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const configPath=join(dir,'config.json'),out=join(dir,'output'),cli=resolve('scripts/prepare-images.mjs');
  const config={schema:'mobile-images-v1',package:'test.zip',images:[{source:'missing.png',variants:[{name:'card'}]}]};
  const run=()=>execFileSync(process.execPath,['--import','tsx',cli,configPath,out],{encoding:'utf8',stdio:'pipe'});
  for(const [defaults,variants,code] of [[null,[{name:'card'}],'INVALID_IMAGE_CONFIG_FIELDS'],
    [{density:null},[{name:'card'}],'NULL_IMAGE_OPTION'],
    [{},[{name:'CARD'},{name:'card'}],'DUPLICATE_PLANNED_IMAGE_PATH'],
    [{},[{name:'AUX'}],'RESERVED_DEVICE_NAME'],
    [{},[{name:'x',tiles:true},{name:'x-tile-001'}],'DUPLICATE_PLANNED_IMAGE_PATH']]){
    await writeFile(configPath,JSON.stringify({...config,defaults,images:[{source:'missing.png',variants}]}));
    assert.throws(run,e=>e.stderr.includes(code));await assert.rejects(access(out));
  }
  await writeFile(join(dir,'master.png'),await readFile('examples/stimuli/mobile-card.png'));
  await writeFile(configPath,JSON.stringify({...config,images:[
    {source:'master.png',variants:[{name:'one'}]},{source:'./master.png',variants:[{name:'two'}]}]}));
  run();assert.equal(JSON.parse(await readFile(join(out,'report.json'),'utf8')).sourceReads,1);
});
