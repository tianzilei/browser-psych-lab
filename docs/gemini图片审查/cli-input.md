第2轮：审查CLI与测试。请指出确定且可复现的问题，给最小修复与回归测试。特别关注运行时null/类型、CLI重试/半成品、输出命名Windows大小写/设备保留名、重复variants与重复读取解码。无需重写完整模块。前轮有些结论自相矛盾（保护框建议与原代码等价，ICC修复仍与原链等价），请将假设标为待验证，不给无依据性能百分比。当前代码与测试：
文件scripts/prepare-images.mjs
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {optimizeImage,packImageZip} from '../src/server/offline-image.ts';
import {IMAGE_PRESETS} from '../src/shared/image-plan.ts';
import {packageName} from '../src/shared/questionnaire-json.ts';
import {fail} from './lib.mjs';

const keys=['scene','viewport','deviceDpr','density','saveData','zoom','fit','content','focus','protectedRegion','maxPixels','format','quality','minQuality','budgetBytes','tiles','tileHeight'];
function record(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('INVALID_IMAGE_CONFIG_FIELDS');
  return value;
}
function options(value={}){
  record(value,keys);
  for(const k of ['saveData','zoom','tiles'])if(k in value&&typeof value[k]!=='boolean')throw new Error('INVALID_IMAGE_CONFIG_BOOLEAN');
  if(value.scene!==undefined&&!Object.hasOwn(IMAGE_PRESETS,value.scene))throw new Error('INVALID_IMAGE_SCENE');
  if(value.content!==undefined&&!['photo','text'].includes(value.content))throw new Error('INVALID_IMAGE_CONTENT');
  for(const [key,fields] of [['viewport',['width','height']],['focus',['x','y']],['protectedRegion',['x','y','width','height']]]){
    if(key in value){record(value[key],fields);if(fields.some(k=>typeof value[key][k]!=='number'))throw new Error('INVALID_IMAGE_CONFIG_REGION');}
  }
  return value;
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){
    console.log('npm run images:prepare -- <config.json> <new-output-directory>\nSee docs/移动端图片处理.md and examples/images/mobile-plan.json');return;
  }
  if(args.length!==2)throw new Error('Usage: npm run images:prepare -- <config.json> <new-output-directory>');
  const configPath=resolve(args[0]),text=await readFile(configPath,'utf8');
  if(Buffer.byteLength(text)>512*1024)throw new Error('IMAGE_CONFIG_TOO_LARGE');
  const config=record(JSON.parse(text.replace(/^\uFEFF/,'')),['schema','package','defaults','images']);
  if(config.schema!=='mobile-images-v1')throw new Error('INVALID_IMAGE_CONFIG_SCHEMA');
  packageName(config.package);const defaults=options(config.defaults);
  if(!Array.isArray(config.images)||!config.images.length||config.images.length>100)throw new Error('INVALID_IMAGE_CONFIG_LIST');
  const files=[],reports=[],names=new Set();let packageBytes=0;
  for(const item of config.images){
    record(item,['source','variants']);
    if(typeof item.source!=='string'||!Array.isArray(item.variants)||!item.variants.length||item.variants.length>20)throw new Error('INVALID_IMAGE_VARIANTS');
    const sourcePath=await realpath(resolve(dirname(configPath),item.source));
    const st=await stat(sourcePath);if(!st.isFile()||st.size>32*1024*1024)throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');
    const input=await readFile(sourcePath);
    for(const variant of item.variants){
      record(variant,['name',...keys]);
      if(typeof variant.name!=='string'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(variant.name))throw new Error('INVALID_VARIANT_NAME');
      const {name,...overrides}=variant,settings={...defaults,...options(overrides)};
      const result=await optimizeImage(input,settings);
      for(const [i,output] of result.outputs.entries()){
        const ext=settings.format==='jpeg'?'jpg':settings.format??'webp';
        const path=`images/${name}${settings.tiles?`-tile-${String(i+1).padStart(3,'0')}`:''}.${ext}`;
        if(names.has(path))throw new Error('DUPLICATE_IMAGE_PATH');names.add(path);
        packageBytes+=output.bytes.length;if(packageBytes>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
        files.push({path,bytes:output.bytes});if(files.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
        reports.push({path,source:item.source,sourceInfo:result.source,settings,...output.report});
      }
    }
  }
  const zip=packImageZip(files),output=resolve(args[1]);
  // Fresh directory plus exclusive writes: masters and previous packages cannot
  // be overwritten, including accidental output/source path overlap.
  await mkdir(dirname(output),{recursive:true});await mkdir(output);
  await mkdir(join(output,'images'));
  for(const file of files)await writeFile(join(output,file.path),file.bytes,{flag:'wx'});
  await writeFile(join(output,config.package),zip,{flag:'wx'});
  const report={schema:'mobile-images-report-v1',package:config.package,packageBytes:zip.length,images:reports};
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const warnings=reports.filter(r=>r.budgetExceeded).length;
  console.log(`${files.length} images, ${zip.length} bytes -> ${join(output,config.package)}\n${warnings} images exceed soft byte budget; inspect report.json before upload.`);
}
main().catch(fail);


文件tests/unit/image-optimization.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {planImage,resolveImageTarget,planImageTiles} from '../../src/shared/image-plan.ts';
import {optimizeImage,packImageZip} from '../../src/server/offline-image.ts';
import {unpackImages} from '../../src/server/image-package.ts';

test('DPR policy, aspect ratio buckets, and hard pixel limits',()=>{
  const opts={viewport:{width:375,height:250},deviceDpr:3};
  assert.deepEqual(resolveImageTarget(opts),{width:768,height:512,dpr:2,budget:120*1024});
  assert.equal(resolveImageTarget({...opts,saveData:true}).dpr,1);
  assert.equal(resolveImageTarget({...opts,density:1.5}).dpr,1.5);
  assert.equal(resolveImageTarget({...opts,density:3}).dpr,2);
  assert.equal(resolveImageTarget({...opts,density:3,zoom:true}).dpr,3);
  const limited=resolveImageTarget({viewport:{width:100000,height:20000},maxPixels:100000});
  assert.ok(limited.width*limited.height<=100000);
  const extreme=resolveImageTarget({viewport:{width:100000,height:.001},maxPixels:10});
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
  const tiles=planImageTiles({width:1000,height:30000},{viewport:{width:360,height:240}},1024);
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
