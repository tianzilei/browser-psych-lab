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
