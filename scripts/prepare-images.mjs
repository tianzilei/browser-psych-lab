import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {optimizeImage,packImageZip,validateVariantOptions} from '../src/server/offline-image.ts';
import {IMAGE_PRESETS} from '../src/shared/image-plan.ts';
import {packageName} from '../src/shared/questionnaire-json.ts';
import {fail} from './lib.mjs';
import {publishImageOutput} from './image-output.mjs';

const keys=['scene','viewport','deviceDpr','density','saveData','zoom','fit','content','focus','protectedRegion','maxPixels','format','quality','minQuality','budgetBytes','tiles','tileHeight'];
function record(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('INVALID_IMAGE_CONFIG_FIELDS');
  return value;
}
function options(value={}){
  record(value,keys);
  if(Object.values(value).some(v=>v===null))throw new Error('NULL_IMAGE_OPTION');
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
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(config.package))throw new Error('RESERVED_DEVICE_NAME');
  const planned=[],plannedPaths=new Set();
  // Validate the entire configuration before opening sources or encoding.
  for(const item of config.images){
    record(item,['source','variants']);
    if(typeof item.source!=='string'||!Array.isArray(item.variants)||!item.variants.length||item.variants.length>20)throw new Error('INVALID_IMAGE_VARIANTS');
    for(const variant of item.variants){
      record(variant,['name',...keys]);
      if(typeof variant.name!=='string'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(variant.name))throw new Error('INVALID_VARIANT_NAME');
      if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(variant.name))throw new Error('RESERVED_DEVICE_NAME');
      const {name,...overrides}=variant,settings={...defaults,...options(overrides)};
      validateVariantOptions(settings);
      const ext=settings.format==='jpeg'?'jpg':settings.format??'webp';
      // Reserve all possible tile paths before work, including cross-variant
      // names such as foo(tile) versus foo-tile-001(single).
      for(let i=1;i<=(settings.tiles?100:1);i++){
        const path=`images/${name}${settings.tiles?`-tile-${String(i).padStart(3,'0')}`:''}.${ext}`.toLowerCase();
        if(plannedPaths.has(path))throw new Error('DUPLICATE_PLANNED_IMAGE_PATH');plannedPaths.add(path);
      }
      planned.push({source:item.source,name,settings});
    }
  }
  const sources=new Map();
  for(const entry of planned){
    const path=await realpath(resolve(dirname(configPath),entry.source));
    if(!sources.has(path))sources.set(path,[]);sources.get(path).push(entry);
  }
  const files=[],reports=[],names=new Set();let packageBytes=0;
  for(const [sourcePath,entries] of sources){
    const st=await stat(sourcePath);if(!st.isFile()||st.size>32*1024*1024)throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');
    const input=await readFile(sourcePath);
    for(const {source,name,settings} of entries){
      const result=await optimizeImage(input,settings);
      for(const [i,output] of result.outputs.entries()){
        const ext=settings.format==='jpeg'?'jpg':settings.format??'webp';
        const path=`images/${name}${settings.tiles?`-tile-${String(i+1).padStart(3,'0')}`:''}.${ext}`;
        const key=path.toLowerCase();if(names.has(key))throw new Error('DUPLICATE_IMAGE_PATH');names.add(key);
        packageBytes+=output.bytes.length;if(packageBytes>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
        files.push({path,bytes:output.bytes});if(files.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
        reports.push({path,source,sourceInfo:result.source,settings,...output.report});
      }
    }
  }
  const zip=packImageZip(files),output=resolve(args[1]);
  const report={schema:'mobile-images-report-v1',package:config.package,packageBytes:zip.length,sourceReads:sources.size,images:reports};
  await publishImageOutput(output,async staging=>{
    await mkdir(join(staging,'images'));
    for(const file of files)await writeFile(join(staging,file.path),file.bytes,{flag:'wx'});
    await writeFile(join(staging,config.package),zip,{flag:'wx'});
    await writeFile(join(staging,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  });
  const warnings=reports.filter(r=>r.budgetExceeded).length;
  console.log(`${files.length} images, ${zip.length} bytes -> ${join(output,config.package)}\n${warnings} images exceed soft byte budget; inspect report.json before upload.`);
}
main().catch(fail);
