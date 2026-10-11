请做最终补丁审查，只列新增阻断或可确定缺陷，最多8项，不再重写代码。
本地实验刺激预处理。已采纳：几何runtime校验/null拒绝；float边界容差；variant一次生成有界raw sRGB，再重试编码；tile整体resize后在raw坐标切片保证phase/高度一致；16MP tile raster预算；ZIP格式/后缀/Windows碰撞；CLI全量预检与源分组读取；临时目录rename发布+lock。all8 EXIF、fractional拼接逐像素、ICC和写入失败用例通过。
纠偏：裁切可行域上下界原代码与您所给修正等价；autoOrient换rotate并不能解决时序且当前8方向测试通过；ZIP日期33对应1980-01-01；原record的!value已拒绝defaults:null；所谓tile死循环原代码rows Math.max(1,...)已挡。这些不应继续当确定P0。CLI无通用安全对抗外部进程写同目录要求，kill可残留lock/临时目录会在文档说明，不自动删除用户目录。
请审查以下最终代码的剩余问题，特别整数溢出、raw Alpha、尺寸报告、config预检和路径竞争，严格区分确定/假设：

文件src/shared/image-plan.ts

export interface Size { width:number; height:number }
export interface Rect extends Size { left:number; top:number }
export type ImageScene = keyof typeof IMAGE_PRESETS;
export const IMAGE_PRESETS = {
  stimulus:{width:360,height:240,density:2,fit:'contain',budget:120*1024},
  avatar:{width:64,height:64,density:2,fit:'cover',budget:8*1024},
  thumbnail:{width:120,height:90,density:1.5,fit:'cover',budget:15*1024},
  feed:{width:360,height:480,density:1.5,fit:'contain',budget:90*1024},
  detail:{width:390,height:390,density:2,fit:'contain',budget:150*1024},
  fullscreen:{width:390,height:844,density:2,fit:'contain',budget:300*1024},
  chat:{width:160,height:200,density:1.5,fit:'contain',budget:35*1024},
  document:{width:960,height:1280,density:2,fit:'contain',budget:300*1024},
  banner:{width:360,height:120,density:2,fit:'cover',budget:50*1024},
} as const;
export interface ImagePlanOptions {
  scene?:ImageScene;
  viewport?:Size; // CSS px / dp / pt, never physical pixels
  deviceDpr?:number;
  density?:1|1.5|2|3;
  saveData?:boolean;
  zoom?:boolean;
  fit?:'contain'|'cover';
  content?:'photo'|'text';

  focus?:{x:number;y:number};
  protectedRegion?:{x:number;y:number;width:number;height:number};
  maxPixels?:number;
}
function positive(v:number){if(!Number.isFinite(v)||v<=0)throw new Error('INVALID_IMAGE_DIMENSION');return v;}
function unit(v:number){if(!Number.isFinite(v)||v<0||v>1)throw new Error('INVALID_IMAGE_REGION');return v;}
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
export function validateImagePlanOptions(options:ImagePlanOptions){
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('INVALID_IMAGE_OPTIONS');
  for(const [key,value] of Object.entries(options))if(value===null)throw new Error(`NULL_IMAGE_OPTION: ${key}`);
  if(options.scene!==undefined&&!Object.hasOwn(IMAGE_PRESETS,options.scene))throw new Error('INVALID_IMAGE_SCENE');
  if(options.fit!==undefined&&!['contain','cover'].includes(options.fit))throw new Error('INVALID_IMAGE_FIT');
  if(options.content!==undefined&&!['photo','text'].includes(options.content))throw new Error('INVALID_IMAGE_CONTENT');
  for(const key of ['saveData','zoom'] as const)if(options[key]!==undefined&&typeof options[key]!=='boolean')throw new Error('INVALID_IMAGE_BOOLEAN');
  if(options.viewport){positive(options.viewport.width);positive(options.viewport.height);
    if(options.viewport.width<1||options.viewport.height<1||options.viewport.width>100000||options.viewport.height>100000)throw new Error('IMAGE_VIEWPORT_LIMIT_EXCEEDED');}
  if(options.focus){unit(options.focus.x);unit(options.focus.y);}
  if(options.protectedRegion){const r=options.protectedRegion;unit(r.x);unit(r.y);positive(r.width);positive(r.height);
    if(r.x+r.width>1+Number.EPSILON*8||r.y+r.height>1+Number.EPSILON*8)throw new Error('INVALID_IMAGE_REGION');}
}
function validateSource(source:Size){
  if(!source||!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height))throw new Error('INVALID_IMAGE_DIMENSION');
  positive(source.width);positive(source.height);
  if(source.width*source.height>64_000_000)throw new Error('SOURCE_PIXEL_LIMIT_EXCEEDED');
}
export function resolveImageTarget(options:ImagePlanOptions={}){
  validateImagePlanOptions(options);
  const preset=IMAGE_PRESETS[options.scene??'stimulus'];
  if(!preset)throw new Error('INVALID_IMAGE_SCENE');
  const viewport=options.viewport??preset,ratio=positive(viewport.width)/positive(viewport.height);
  if(viewport.width>100000||viewport.height>100000)throw new Error('IMAGE_VIEWPORT_LIMIT_EXCEEDED');
  const maxPixels=options.maxPixels??4_000_000;
  if(!Number.isSafeInteger(maxPixels)||maxPixels<1||maxPixels>4_000_000)throw new Error('INVALID_IMAGE_PIXEL_LIMIT');
  const device=positive(options.deviceDpr??2),requested=options.density??preset.density;
  if(![1,1.5,2,3].includes(requested))throw new Error('INVALID_IMAGE_DENSITY');
  if(device<1)throw new Error('INVALID_IMAGE_DENSITY');
  const dpr=Math.min(device,options.saveData?1:requested,options.zoom?3:2);


  let width=Math.ceil(viewport.width*dpr/32)*32,height=Math.max(1,Math.round(width/ratio));
  const scale=Math.min(1,4096/width,4096/height,Math.sqrt(maxPixels/(width*height)));
  width=Math.max(1,Math.floor(width*scale));height=Math.max(1,Math.floor(height*scale));

  if(width*height>maxPixels){if(width>=height)width=Math.max(1,Math.floor(maxPixels/height));
    else height=Math.max(1,Math.floor(maxPixels/width));}
  return {width,height,dpr,budget:preset.budget};
}
export function planImage(source:Size,options:ImagePlanOptions={}){
  validateSource(source);
  const target=resolveImageTarget(options),preset=IMAGE_PRESETS[options.scene??'stimulus'];
  const requestedFit=options.fit??preset.fit;
  if(!['contain','cover'].includes(requestedFit))throw new Error('INVALID_IMAGE_FIT');
  let fit=requestedFit,reason:string|null=null;
  let region:Rect|undefined;
  if(options.protectedRegion){const r=options.protectedRegion;
    unit(r.x);unit(r.y);positive(r.width);positive(r.height);

    const left=clamp((r.x-r.width*.15)*source.width,0,source.width);
    const top=clamp((r.y-r.height*.15)*source.height,0,source.height);
    region={left,top,width:Math.min(source.width,(r.x+r.width*1.15)*source.width)-left,
      height:Math.min(source.height,(r.y+r.height*1.15)*source.height)-top};
  }
  if(options.focus){unit(options.focus.x);unit(options.focus.y);}
  let crop:Rect={left:0,top:0,...source};
  if(fit==='cover'){
    const ratio=target.width/target.height;
    const width=Math.min(source.width,Math.floor(source.height*ratio));
    const height=Math.min(source.height,Math.floor(source.width/ratio));
    if(width<1||height<1){fit='contain';reason='extreme-ratio';}
    else if(options.content==='text'||options.scene==='document'){fit='contain';reason='text-protection';}
    else if(region&&(region.width>width||region.height>height)){fit='contain';reason='protected-region-does-not-fit';}
    else if(!region&&!options.focus&&width*height/(source.width*source.height)<.55){fit='contain';reason='unsafe-crop-without-subject';}
    else {
      const x=options.focus?options.focus.x*source.width:region?region.left+region.width/2:source.width/2;
      const y=options.focus?options.focus.y*source.height:region?region.top+region.height/2:source.height/2;


      const minX=region?Math.max(0,Math.ceil(region.left+region.width-width)):0;
      const maxX=region?Math.min(source.width-width,Math.floor(region.left)):source.width-width;
      const minY=region?Math.max(0,Math.ceil(region.top+region.height-height)):0;
      const maxY=region?Math.min(source.height-height,Math.floor(region.top)):source.height-height;
      if(minX>maxX||minY>maxY){fit='contain';reason='protected-region-does-not-fit';}
      else crop={left:clamp(Math.round(x-width/2),minX,maxX),top:clamp(Math.round(y-height/2),minY,maxY),width,height};
    }
  }
  const scale=Math.min(1,target.width/crop.width,target.height/crop.height);
  const output={width:Math.max(1,Math.floor(crop.width*scale)),height:Math.max(1,Math.floor(crop.height*scale))};
  return {target,crop,output,fit,fallback:reason,retainedArea:crop.width*crop.height/(source.width*source.height),
    decodedBytes:output.width*output.height*4};
}


export function planImageTiles(source:Size,options:ImagePlanOptions={},tileHeight=1024){
  validateSource(source);
  if(!Number.isSafeInteger(tileHeight)||tileHeight<32||tileHeight>4096)throw new Error('INVALID_TILE_HEIGHT');
  const target=resolveImageTarget(options),width=Math.min(source.width,target.width);
  const heightLimit=Math.min(tileHeight,Math.floor((options.maxPixels??4_000_000)/width));
  const fullOutput={width,height:Math.max(1,Math.round(source.height*width/source.width))};


  if(fullOutput.width*fullOutput.height>16_000_000)throw new Error('TILE_RASTER_PIXEL_LIMIT_EXCEEDED');
  if(Math.ceil(fullOutput.height/heightLimit)>100)throw new Error('TOO_MANY_IMAGE_TILES');
  const plans=[];
  for(let outputTop=0;outputTop<fullOutput.height;outputTop+=heightLimit){
    const outputHeight=Math.min(heightLimit,fullOutput.height-outputTop);
    const top=Math.round(outputTop*source.height/fullOutput.height);
    const bottom=Math.round((outputTop+outputHeight)*source.height/fullOutput.height);
    plans.push({crop:{left:0,top,width:source.width,height:bottom-top},
      output:{width,height:outputHeight},outputTop,fullOutput});}
  return plans;
}


文件src/server/offline-image.ts

import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {planImage,planImageTiles,resolveImageTarget,validateImagePlanOptions,type ImagePlanOptions} from '../shared/image-plan.js';
import {imageInfo} from './image-package.js';
import {imagePath} from '../shared/questionnaire-json.js';

export interface VariantOptions extends ImagePlanOptions {
  format?:'webp'|'jpeg'|'png';
  quality?:number;
  minQuality?:number;
  budgetBytes?:number;
  tiles?:boolean;
  tileHeight?:number;
}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function validateVariantOptions(options:VariantOptions){
  validateImagePlanOptions(options);
  if(options.format!==undefined&&!['webp','jpeg','png'].includes(options.format))throw new Error('INVALID_OUTPUT_FORMAT');
  if(options.tiles!==undefined&&typeof options.tiles!=='boolean')throw new Error('INVALID_IMAGE_BOOLEAN');
  if(options.tileHeight!==undefined&&(!Number.isSafeInteger(options.tileHeight)||options.tileHeight<32||options.tileHeight>4096))throw new Error('INVALID_TILE_HEIGHT');
  const quality=options.quality??88,minQuality=options.minQuality??78;
  if(!Number.isInteger(quality)||quality<1||quality>100||!Number.isInteger(minQuality)||minQuality<1||minQuality>quality)throw new Error('INVALID_IMAGE_QUALITY_RANGE');
  const budget=options.budgetBytes??resolveImageTarget(options).budget;
  if(!Number.isSafeInteger(budget)||budget<1||budget>8*1024*1024)throw new Error('INVALID_IMAGE_BYTE_BUDGET');
}
export async function optimizeImage(input:Buffer,options:VariantOptions={}){
  validateVariantOptions(options);
  if(input.length>32*1024*1024)throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');
  const decoder=()=>sharp(input,{limitInputPixels:64_000_000,failOn:'warning'});
  const meta=await decoder().metadata();
  if(!meta.width||!meta.height||!['png','jpeg','webp','heif','avif','tiff'].includes(meta.format??''))throw new Error('UNSUPPORTED_SOURCE_IMAGE');
  if((meta.pages??1)>1)throw new Error('ANIMATED_OR_MULTIPAGE_IMAGE_NOT_SUPPORTED');
  const rotated=[5,6,7,8].includes(meta.orientation??1);
  const source={width:rotated?meta.height:meta.width,height:rotated?meta.width:meta.height};
  const content=options.content??(options.scene==='document'?'text':'photo');
  const format=options.format??'webp';
  if(!['webp','jpeg','png'].includes(format))throw new Error('INVALID_OUTPUT_FORMAT');
  if(meta.hasAlpha&&format==='jpeg')throw new Error('JPEG_CANNOT_PRESERVE_ALPHA');
  const quality=options.quality??88,minQuality=options.minQuality??78;
  if(!Number.isInteger(quality)||quality<1||quality>100||!Number.isInteger(minQuality)||minQuality<1||minQuality>quality)throw new Error('INVALID_IMAGE_QUALITY_RANGE');
  if(content==='text'&&format==='jpeg')throw new Error('TEXT_REQUIRES_LOSSLESS_WEBP_OR_PNG');
  const budget=options.budgetBytes??resolveImageTarget(options).budget;
  if(!Number.isSafeInteger(budget)||budget<1||budget>8*1024*1024)throw new Error('INVALID_IMAGE_BYTE_BUDGET');
  const plan=planImage(source,{...options,content});
  const tiles=options.tiles?planImageTiles(source,options,options.tileHeight):null;
  const geometries=tiles??[{crop:plan.crop,output:plan.output,outputTop:0,fullOutput:plan.output}];
  const rasterSize=geometries[0]!.fullOutput;
  const raster=await decoder().autoOrient()
    .extract(tiles?{left:0,top:0,...source}:plan.crop)
    .resize(rasterSize.width,rasterSize.height,{fit:'fill',kernel:'lanczos3',withoutEnlargement:true})
    .withIccProfile('srgb',{attach:false}).toColourspace('srgb')
    .raw({depth:'uchar'}).timeout({seconds:30}).toBuffer({resolveWithObject:true});
  const outputs=[];let outputBytes=0;
  for(const geometry of geometries){
    let encodeAttempts=0;
    const encode=async(q:number)=>{
      encodeAttempts++;
      const image=sharp(raster.data,{raw:{width:raster.info.width,height:raster.info.height,channels:raster.info.channels},limitInputPixels:16_000_000})
        .extract({left:0,top:geometry.outputTop,...geometry.output}).timeout({seconds:30});


      if(format==='webp')image.webp({quality:q,lossless:content==='text',alphaQuality:100,effort:4});
      else if(format==='jpeg')image.jpeg({quality:q,mozjpeg:true,chromaSubsampling:'4:2:0',progressive:true});
      else image.png({compressionLevel:9,palette:false});
      return image.toBuffer();
    };
    let bytes=await encode(quality),selectedQuality=quality;


    if(bytes.length>budget&&format!=='png'&&content!=='text'&&quality>minQuality){
      for(const q of [...new Set([Math.round((quality+minQuality)/2),minQuality])]){
        const candidate=await encode(q);
        if(candidate.length<bytes.length){bytes=candidate;selectedQuality=q;}
        if(bytes.length<=budget)break;
      }
    }
    const info=imageInfo(bytes);outputBytes+=bytes.length;
    if(outputBytes>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
    outputs.push({bytes,report:{...info,sha256:hash(bytes),bytes:bytes.length,budgetBytes:budget,
      budgetExceeded:bytes.length>budget,quality:content==='text'||format==='png'?null:selectedQuality,
      lossless:content==='text'||format==='png',decodedBytes:info.width*info.height*4,
      crop:geometry.crop,fit:options.tiles?'tile':plan.fit,fallback:options.tiles?null:plan.fallback,
      encodeAttempts,rasterBytes:raster.data.length,outputRegion:{left:0,top:geometry.outputTop,...geometry.output}}});
  }
  return {source:{...source,format:meta.format,bytes:input.length,sha256:hash(input)},outputs};
}


export function packImageZip(images:{path:string;bytes:Buffer}[]){
  if(!images.length||images.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
  const names=new Set<string>(),local:Buffer[]=[],central:Buffer[]=[];let offset=0,total=0;
  for(const image of images){
    imagePath(image.path);const key=image.path.toLowerCase();
    if(names.has(key))throw new Error('DUPLICATE_IMAGE_PATH');names.add(key);
    if(image.path.split('/').some(part=>/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||part.endsWith('.')))throw new Error('NON_PORTABLE_IMAGE_PATH');
    const info=imageInfo(image.bytes),ext=image.path.split('.').at(-1)!.toLowerCase();
    if(info.format!==({png:'png',webp:'webp',jpg:'jpeg',jpeg:'jpeg'} as Record<string,string>)[ext])throw new Error('IMAGE_EXTENSION_MISMATCH');
    total+=image.bytes.length;if(total>32*1024*1024)throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
    const name=Buffer.from(image.path),crc=crc32(image.bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
    header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(image.bytes.length,18);
    header.writeUInt32LE(image.bytes.length,22);header.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);
    directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);
    directory.writeUInt32LE(image.bytes.length,20);directory.writeUInt32LE(image.bytes.length,24);
    directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,name,image.bytes);central.push(directory,name);offset+=header.length+name.length+image.bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(images.length,8);end.writeUInt16LE(images.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  if(offset+directory.length+end.length>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
  return Buffer.concat([...local,directory,end]);
}


文件scripts/image-output.mjs
import {open,lstat,mkdir,mkdtemp,rename,rm,unlink,realpath} from 'node:fs/promises';
import {dirname,resolve,join,basename} from 'node:path';

async function requireMissing(path){
  try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error('IMAGE_OUTPUT_ALREADY_EXISTS');
}


export async function publishImageOutput(output,write){
  output=resolve(output);await mkdir(dirname(output),{recursive:true});
  const parent=await realpath(dirname(output));output=join(parent,basename(output));
  const lockPath=`${output}.lock`,lock=await open(lockPath,'wx');let staging;
  try{
    await requireMissing(output);
    staging=await mkdtemp(join(parent,`.${basename(output)}.tmp-`));
    await write(staging);await requireMissing(output);
    await rename(staging,output);staging=undefined;
  }finally{
    try{
      if(staging){

        const actual=await realpath(staging);
        if(actual!==staging||dirname(actual)!==parent||!basename(actual).startsWith(`.${basename(output)}.tmp-`))throw new Error('UNSAFE_IMAGE_STAGING_PATH');
        await rm(actual,{recursive:true,force:true});
      }
    }finally{await lock.close();await unlink(lockPath);}
  }
}
