全项目设计讨论，传输段 25，源码主题：图片包及冻结发行（源包 9/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### src/server/image-package.ts L1–L65

```
import {inflateRawSync,crc32} from 'node:zlib';
import {imagePath} from '../shared/questionnaire-json.js';

// Header/container validation only. No decoder, resize or re-encoding on the server.
export function imageInfo(b:Buffer){
  let width=0,height=0,format:'png'|'jpeg'|'webp';
  if(b.length<24||b.length>8*1024*1024)throw new Error('INVALID_IMAGE_BYTES');
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    format='png';let pos=8,ended=false,hasData=false;
    while(pos+12<=b.length){const size=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8),end=pos+12+size;if(end>b.length)throw new Error('TRUNCATED_PNG');
      if(crc32(b.subarray(pos+4,end-4))!==b.readUInt32BE(end-4))throw new Error('PNG_CRC_MISMATCH');
      if(pos===8){if(type!=='IHDR'||size!==13)throw new Error('INVALID_PNG_HEADER');width=b.readUInt32BE(pos+8);height=b.readUInt32BE(pos+12);}
      if(type==='acTL'||type==='eXIf')throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if(type==='IDAT')hasData=true;
      if(type==='IEND'){if(size!==0||end!==b.length||!hasData)throw new Error('INVALID_PNG_END');ended=true;break;}pos=end;
    }if(!ended)throw new Error('TRUNCATED_PNG');
  }else if(b[0]===255&&b[1]===216){
    format='jpeg';let pos=2,foundSof=false,foundScan=false;const sof=[0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf];
    if(b.at(-2)!==255||b.at(-1)!==217)throw new Error('TRUNCATED_JPEG');
    while(pos+4<=b.length){if(b[pos++]!==255)throw new Error('INVALID_JPEG_MARKER');while(pos<b.length&&b[pos]===255)pos++;if(pos+3>b.length)throw new Error('TRUNCATED_JPEG');const marker=b[pos++]!;
      if(marker===0xda){const size=b.readUInt16BE(pos);if(size<6||pos+size>b.length-2)throw new Error('INVALID_JPEG_SCAN');foundScan=true;break;}if(marker===0xd8||marker===1||marker>=0xd0&&marker<=0xd7)continue;
      const size=b.readUInt16BE(pos);if(size<2||pos+size>b.length)throw new Error('TRUNCATED_JPEG');
      if(marker===0xe1&&b.toString('ascii',pos+2,pos+6)==='Exif')throw new Error('IMAGE_EXIF_NOT_ALLOWED');
      if(sof.includes(marker)){if(foundSof||size<8)throw new Error('INVALID_JPEG_SOF');foundSof=true;height=b.readUInt16BE(pos+3);width=b.readUInt16BE(pos+5);}pos+=size;
    }if(!foundSof||!foundScan)throw new Error('INVALID_JPEG_STRUCTURE');
  }else if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
    format='webp';if(b.readUInt32LE(4)+8!==b.length)throw new Error('TRUNCATED_WEBP');let pos=12,canvasWidth=0,canvasHeight=0,foundPixels=false;
    while(pos+8<=b.length){const type=b.toString('ascii',pos,pos+4),size=b.readUInt32LE(pos+4),start=pos+8,end=start+size;
      if(end>b.length)throw new Error('TRUNCATED_WEBP');
      if(type==='ANIM'||type==='ANMF'||type==='EXIF')throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if(type==='VP8X'){if(pos!==12||size!==10||(b[start]!&2))throw new Error('STATIC_IMAGE_REQUIRED');canvasWidth=1+b.readUIntLE(start+4,3);canvasHeight=1+b.readUIntLE(start+7,3);}
      if(type==='VP8 '||type==='VP8L'){if(foundPixels)throw new Error('INVALID_WEBP_STRUCTURE');foundPixels=true;}
      if(type==='VP8 '){if(size<10||b.toString('hex',start+3,start+6)!=='9d012a')throw new Error('INVALID_WEBP');width=b.readUInt16LE(start+6)&0x3fff;height=b.readUInt16LE(start+8)&0x3fff;}
      if(type==='VP8L'){if(size<5||b[start]!==0x2f)throw new Error('INVALID_WEBP');const bits=b.readUInt32LE(start+1);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
      pos=end+(size&1);
    }if(pos!==b.length||!foundPixels||canvasWidth&&(canvasWidth!==width||canvasHeight!==height))throw new Error('INVALID_WEBP_STRUCTURE');
  }else throw new Error('PNG_JPEG_WEBP_REQUIRED');
  if(!width||!height||width>4096||height>4096||width*height>4_000_000)throw new Error('IMAGE_PIXEL_BUDGET_EXCEEDED');
  return {width,height,format,validation:'container-header-v1'};
}
export function unpackImages(b:Buffer){
  if(b.length>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
  let eocd=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){eocd=i;break;}
  if(eocd<0||b.readUInt16LE(eocd+4)||b.readUInt16LE(eocd+6)||b.readUInt16LE(eocd+8)!==b.readUInt16LE(eocd+10))throw new Error('STANDARD_ZIP_REQUIRED');
  const count=b.readUInt16LE(eocd+10),central=b.readUInt32LE(eocd+16),size=b.readUInt32LE(eocd+12);
  if(!count||count>200||central+size!==eocd)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
  const images:{path:string;bytes:Buffer;info:ReturnType<typeof imageInfo>}[]=[],names=new Set<string>();let pos=central,total=0;
  for(let i=0;i<count;i++){
    if(pos+46>eocd||b.readUInt32LE(pos)!==0x02014b50)throw new Error('INVALID_ZIP_DIRECTORY');
    const flags=b.readUInt16LE(pos+8),method=b.readUInt16LE(pos+10),crc=b.readUInt32LE(pos+16),compressed=b.readUInt32LE(pos+20),expanded=b.readUInt32LE(pos+24),nameLen=b.readUInt16LE(pos+28),extra=b.readUInt16LE(pos+30),comment=b.readUInt16LE(pos+32),external=b.readUInt32LE(pos+38),local=b.readUInt32LE(pos+42);
    const next=pos+46+nameLen+extra+comment;if(next>eocd||flags&1||![0,8].includes(method)||b.readUInt16LE(pos+34)||((external>>>16)&0xf000)===0xa000)throw new Error('UNSUPPORTED_ZIP_ENTRY');
    const nameBytes=b.subarray(pos+46,pos+46+nameLen),name=nameBytes.toString('utf8');if(!Buffer.from(name).equals(nameBytes)||names.has(name))throw new Error('DUPLICATE_OR_INVALID_ZIP_PATH');names.add(name);
    const directory=name.endsWith('/');if(directory){if(name.slice(0,-1).split('/').some(p=>!p||p==='.'||p==='..'||!/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p))||expanded!==0)throw new Error('INVALID_ZIP_PATH');}else imagePath(name);
    if(local+30>central||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)throw new Error('INVALID_ZIP_LOCAL_HEADER');
    const localName=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28),start=local+30+localName+localExtra;
    if(localName!==nameLen||!b.subarray(local+30,local+30+localName).equals(nameBytes)||start+compressed>central)throw new Error('INVALID_ZIP_LOCAL_HEADER');
    total+=expanded;if(expanded>8*1024*1024||total>32*1024*1024||images.length>=100&&!directory)throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
    if(!(flags&8)&&(b.readUInt32LE(local+14)!==crc||b.readUInt32LE(local+18)!==compressed||b.readUInt32LE(local+22)!==expanded))throw new Error('ZIP_HEADER_MISMATCH');
    if(flags&8){let descriptor=start+compressed;if(descriptor+4<=central&&b.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;if(descriptor+12>central||b.readUInt32LE(descriptor)!==crc||b.readUInt32LE(descriptor+4)!==compressed||b.readUInt32LE(descriptor+8)!==expanded)throw new Error('ZIP_DESCRIPTOR_MISMATCH');}
    const packed=b.subarray(start,start+compressed),bytes=method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,expanded)});
    if(bytes.length!==expanded||crc32(bytes)!==crc)throw new Error('ZIP_CRC_OR_LENGTH_MISMATCH');
    if(!directory){const info=imageInfo(bytes),ext=name.split('.').at(-1)!.toLowerCase();if(info.format!==({jpg:'jpeg',jpeg:'jpeg',png:'png',webp:'webp'} as Record<string,string>)[ext])throw new Error('IMAGE_EXTENSION_MISMATCH');images.push({path:name,bytes,info});}pos=next;
  }if(pos!==eocd||!images.length)throw new Error('INVALID_ZIP_DIRECTORY');return images;
}

```

### src/server/offline-image.ts L1–L119

```
// Imported only by the local packer, never by HTTP routes or maintenance jobs.
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
  const target=resolveImageTarget(options); // Validate geometry even with an explicit byte budget.
  if(options.format!==undefined&&!['webp','jpeg','png'].includes(options.format))throw new Error('INVALID_OUTPUT_FORMAT');
  if(options.tiles!==undefined&&typeof options.tiles!=='boolean')throw new Error('INVALID_IMAGE_BOOLEAN');
  if(options.tileHeight!==undefined&&(!Number.isSafeInteger(options.tileHeight)||options.tileHeight<32||options.tileHeight>4096))throw new Error('INVALID_TILE_HEIGHT');
  const quality=options.quality??88,minQuality=options.minQuality??78;
  if(!Number.isInteger(quality)||quality<1||quality>100||!Number.isInteger(minQuality)||minQuality<1||minQuality>quality)throw new Error('INVALID_IMAGE_QUALITY_RANGE');
  const budget=options.budgetBytes??target.budget;
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
      crop:geometry.crop,cropSpace:tiles?'normalized-source-mapped':'normalized-source-exact',
      fit:options.tiles?'tile':plan.fit,fallback:options.tiles?null:plan.fallback,
      encodeAttempts,rasterBytes:raster.data.length,outputRegion:{left:0,top:geometry.outputTop,...geometry.output}}});
  }
  return {source:{...source,format:meta.format,bytes:input.length,sha256:hash(input)},outputs};
}

// Stored ZIP entries: image codecs already compress, no need to DEFLATE again.
export function packImageZip(images:{path:string;bytes:Buffer}[]){
  if(!images.length||images.length>100)throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');
  const names=new Set<string>(),local:Buffer[]=[],central:Buffer[]=[];let offset=0,total=0;
  for(const image of images){
    imagePath(image.path);const key=image.path.toLowerCase();