审查输入：src/shared/image-plan.ts 与 src/server/offline-image.ts（2026-10-10）。完整代码快照如下。

## src/shared/image-plan.ts

```typescript
// Pure geometry shared by the offline packer and potential preview clients.
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
  // Coordinates relative to the EXIF-normalized original, in [0,1].
  focus?:{x:number;y:number};
  protectedRegion?:{x:number;y:number;width:number;height:number};
  maxPixels?:number;
}
function positive(v:number){if(!Number.isFinite(v)||v<=0)throw new Error('INVALID_IMAGE_DIMENSION');return v;}
function unit(v:number){if(!Number.isFinite(v)||v<0||v>1)throw new Error('INVALID_IMAGE_REGION');return v;}
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
export function resolveImageTarget(options:ImagePlanOptions={}){
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
  // Bucket one dimension only, then derive the other. Independent rounding
  // changes aspect ratio and causes an additional crop at rendering time.
  let width=Math.ceil(viewport.width*dpr/32)*32,height=Math.max(1,Math.round(width/ratio));
  const scale=Math.min(1,4096/width,4096/height,Math.sqrt(maxPixels/(width*height)));
  width=Math.max(1,Math.floor(width*scale));height=Math.max(1,Math.floor(height*scale));
  // Re-check area after an extreme ratio rounds the short edge up to one pixel.
  if(width*height>maxPixels){if(width>=height)width=Math.max(1,Math.floor(maxPixels/height));
    else height=Math.max(1,Math.floor(maxPixels/width));}
  return {width,height,dpr,budget:preset.budget};
}
export function planImage(source:Size,options:ImagePlanOptions={}){
  if(!Number.isSafeInteger(source.width)||!Number.isSafeInteger(source.height))throw new Error('INVALID_IMAGE_DIMENSION');
  positive(source.width);positive(source.height);
  const target=resolveImageTarget(options),preset=IMAGE_PRESETS[options.scene??'stimulus'];
  const requestedFit=options.fit??preset.fit;
  if(!['contain','cover'].includes(requestedFit))throw new Error('INVALID_IMAGE_FIT');
  let fit=requestedFit,reason:string|null=null;
  let region:Rect|undefined;
  if(options.protectedRegion){const r=options.protectedRegion;
    unit(r.x);unit(r.y);positive(r.width);positive(r.height);
    if(r.x+r.width>1||r.y+r.height>1)throw new Error('INVALID_IMAGE_REGION');
    // 15% padding around the union of all faces / text / subjects.
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
      // A feasible origin interval guarantees the whole protected region fits;
      // centering on the subject alone does not provide this guarantee.
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
// Tiles are independent assets, intended for scrolling viewers. The timed
// experiment runner displays one image; it does not stitch tile assets.
export function planImageTiles(source:Size,options:ImagePlanOptions={},tileHeight=1024){
  positive(source.width);positive(source.height);
  if(!Number.isSafeInteger(tileHeight)||tileHeight<32||tileHeight>4096)throw new Error('INVALID_TILE_HEIGHT');
  const target=resolveImageTarget(options),width=Math.min(source.width,target.width);
  const heightLimit=Math.min(tileHeight,Math.floor((options.maxPixels??4_000_000)/width));
  const rows=Math.max(1,Math.floor(heightLimit*source.width/width));
  if(Math.ceil(source.height/rows)>100)throw new Error('TOO_MANY_IMAGE_TILES');
  const plans=[];
  for(let top=0;top<source.height;top+=rows){const height=Math.min(rows,source.height-top);
    plans.push({crop:{left:0,top,width:source.width,height},output:{width,height:Math.max(1,Math.floor(height*width/source.width))}});}
  return plans;
}
```

## src/server/offline-image.ts

```typescript
// Imported only by the local packer, never by HTTP routes or maintenance jobs.
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {planImage,planImageTiles,resolveImageTarget,type ImagePlanOptions} from '../shared/image-plan.js';
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
export async function optimizeImage(input:Buffer,options:VariantOptions={}){
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
  const geometries=options.tiles?planImageTiles(source,options,options.tileHeight):[plan];
  const outputs=[];let outputBytes=0;
  for(const geometry of geometries){
    const encode=async(q:number)=>{
      const image=decoder().autoOrient().extract(geometry.crop)
        .resize(geometry.output.width,geometry.output.height,{fit:'fill',kernel:'lanczos3',withoutEnlargement:true})
        .toColourspace('srgb').timeout({seconds:30});
      // libwebp lossy only supports 4:2:0. Text uses lossless, not a fictitious
      // subsampling=4:4:4 option. Default output strips EXIF/ICC after sRGB conversion.
      if(format==='webp')image.webp({quality:q,lossless:content==='text',alphaQuality:100,effort:4});
      else if(format==='jpeg')image.jpeg({quality:q,mozjpeg:true,chromaSubsampling:'4:2:0',progressive:true});
      else image.png({compressionLevel:9,palette:false});
      return image.toBuffer();
    };
    let bytes=await encode(quality),selectedQuality=quality;
    // Byte budget is soft. Never silently shrink text, crop more, or cross the
    // configured quality floor. This search measures bytes, not perceptual loss.
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
      crop:geometry.crop,fit:options.tiles?'tile':plan.fit,fallback:options.tiles?null:plan.fallback}});
  }
  return {source:{...source,format:meta.format,bytes:input.length,sha256:hash(input)},outputs};
}

// Stored ZIP entries: image codecs already compress, no need to DEFLATE again.
export function packImageZip(images:{path:string;bytes:Buffer}[]){
  if(!images.length||images.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
  const names=new Set<string>(),local:Buffer[]=[],central:Buffer[]=[];let offset=0,total=0;
  for(const image of images){
    imagePath(image.path);if(names.has(image.path))throw new Error('DUPLICATE_IMAGE_PATH');names.add(image.path);
    imageInfo(image.bytes);total+=image.bytes.length;if(total>32*1024*1024)throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
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
```
