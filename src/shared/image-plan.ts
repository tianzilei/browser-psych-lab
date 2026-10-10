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
  validateSource(source);
  const target=resolveImageTarget(options),preset=IMAGE_PRESETS[options.scene??'stimulus'];
  const requestedFit=options.fit??preset.fit;
  if(!['contain','cover'].includes(requestedFit))throw new Error('INVALID_IMAGE_FIT');
  let fit=requestedFit,reason:string|null=null;
  let region:Rect|undefined;
  if(options.protectedRegion){const r=options.protectedRegion;
    unit(r.x);unit(r.y);positive(r.width);positive(r.height);
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
  validateSource(source);
  if(!Number.isSafeInteger(tileHeight)||tileHeight<32||tileHeight>4096)throw new Error('INVALID_TILE_HEIGHT');
  const target=resolveImageTarget(options),width=Math.min(source.width,target.width);
  const heightLimit=Math.min(tileHeight,Math.floor((options.maxPixels??4_000_000)/width));
  const fullOutput={width,height:Math.max(1,Math.round(source.height*width/source.width))};
  // One bounded raster is resized before slicing. Per-tile resizing changes
  // filter phase and duplicates/loses destination rows at fractional scales.
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
