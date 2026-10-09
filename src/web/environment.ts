type ExtendedNavigator=Navigator&{deviceMemory?:number;globalPrivacyControl?:boolean;connection?:{effectiveType?:string;type?:string;downlink?:number;downlinkMax?:number;rtt?:number;saveData?:boolean};
  userAgentData?:{brands:unknown;mobile:boolean;platform:string;getHighEntropyValues:(keys:string[])=>Promise<unknown>};getBattery?:()=>Promise<{charging:boolean;level:number;chargingTime:number;dischargingTime:number}>};
const bounded=async(fn:()=>Promise<unknown>,ms=250)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([fn().then(value=>({status:'available',value}),()=>({status:'blocked-or-error',value:null})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout',value:null}),ms);})]);}catch{return {status:'blocked-or-error',value:null};}finally{clearTimeout(timer);}};
const optional=(fn:(()=>Promise<unknown>)|undefined)=>fn?bounded(fn):Promise.resolve({status:'unsupported',value:null});
const finite=(v:number|undefined)=>v!==undefined&&Number.isFinite(v)?v:null;
function inference(ua:string){
  const browser=[/(Edg|EdgiOS|EdgA)\/([\d.]+)/,/(OPR)\/([\d.]+)/,/(Firefox|FxiOS)\/([\d.]+)/,/(Chrome|CriOS)\/([\d.]+)/,/(Version)\/([\d.]+)/].map(pattern=>ua.match(pattern)).find(Boolean);
  const os=ua.match(/(Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|CrOS|Linux)/);
  return {source:'user-agent-heuristic',browser:browser?`${({Edg:'Edge',EdgiOS:'Edge',EdgA:'Edge',OPR:'Opera',FxiOS:'Firefox',CriOS:'Chrome',Version:'Safari'} as Record<string,string>)[browser[1]!]??browser[1]} ${browser[2]}`:'unknown',os:os?.[0]??'unknown',device:/Mobile|Android|iPhone|iPad/.test(ua)?'mobile-or-tablet':'desktop-or-unknown'};
}
export async function collectEnvironment(){
  const n=navigator as ExtendedNavigator,v=visualViewport,match=(q:string)=>matchMedia(q).matches;
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  let graphics:unknown={status:'unsupported',value:null};
  try{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl');if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');graphics={status:ext?'available':'masked',value:{vendor:gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL??gl.VENDOR),renderer:gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),version:gl.getParameter(gl.VERSION),shading_language:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),max_texture_size:gl.getParameter(gl.MAX_TEXTURE_SIZE)}};gl.getExtension('WEBGL_lose_context')?.loseContext();}}catch{graphics={status:'blocked-or-error',value:null};}
  const data={schema:'environment-v1',sampled_at:new Date().toISOString(),time_origin:performance.timeOrigin,sampled_performance_ms:performance.now(),
    user_agent:n.userAgent,user_agent_inferred:inference(n.userAgent),client_hints_low:n.userAgentData?{brands:n.userAgentData.brands,mobile:n.userAgentData.mobile,platform:n.userAgentData.platform}:null,
    platform:n.platform,vendor:n.vendor,app_version:n.appVersion,language:n.language,languages:[...(n.languages??[])],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timezone_offset_minutes:new Date().getTimezoneOffset(),
    hardware:{logical_processors:n.hardwareConcurrency??null,device_memory_gb:n.deviceMemory??null,max_touch_points:n.maxTouchPoints},
    screen:{width:screen.width,height:screen.height,available_width:screen.availWidth,available_height:screen.availHeight,color_depth:screen.colorDepth,pixel_depth:screen.pixelDepth,orientation_type:screen.orientation?.type??null,orientation_angle:screen.orientation?.angle??null},
    viewport:{width:innerWidth,height:innerHeight,document_width:document.documentElement.clientWidth,document_height:document.documentElement.clientHeight,dpr:devicePixelRatio,visual:v?{width:v.width,height:v.height,offset_left:v.offsetLeft,offset_top:v.offsetTop,scale:v.scale}:null},
    preferences:Object.fromEntries(['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)','(prefers-contrast: more)','(prefers-contrast: less)','(forced-colors: active)','(pointer: coarse)','(pointer: fine)','(hover: hover)','(any-pointer: coarse)','(any-pointer: fine)','(any-hover: hover)','(inverted-colors: inverted)','(display-mode: standalone)','(dynamic-range: high)','(color-gamut: srgb)','(color-gamut: p3)','(color-gamut: rec2020)'].map(q=>[q,match(q)])),
    network:{online:n.onLine,connection:n.connection?{type:n.connection.type??null,effective_type:n.connection.effectiveType??null,downlink_mbps:finite(n.connection.downlink),downlink_max_mbps:finite(n.connection.downlinkMax),rtt_ms:finite(n.connection.rtt),save_data:n.connection.saveData??null}:null},
    security:{secure_context:isSecureContext,cross_origin_isolated:crossOriginIsolated,cookie_enabled:n.cookieEnabled,do_not_track:n.doNotTrack??null,global_privacy_control:n.globalPrivacyControl??null,visibility:document.visibilityState},
    capabilities:{indexed_db:!!window.indexedDB,locks:!!n.locks,crypto:!!crypto.subtle,canvas:!!window.HTMLCanvasElement,create_image_bitmap:!!window.createImageBitmap,visual_viewport:!!v,pointer_event:!!window.PointerEvent,offscreen_canvas:typeof OffscreenCanvas!=='undefined',service_worker:'serviceWorker' in n,webgl:(graphics as {status:string}).status},
    navigation:nav?{type:nav.type,redirect_count:nav.redirectCount,next_hop_protocol:nav.nextHopProtocol,dom_interactive_ms:nav.domInteractive,response_end_ms:nav.responseEnd,transfer_bytes:nav.transferSize}:null,
    referrer_origin:(()=>{try{return document.referrer?new URL(document.referrer).origin:null;}catch{return null;}})(),graphics};
  const [hints,storage,persisted,battery]=await Promise.all([
    optional(n.userAgentData?()=>n.userAgentData!.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']):undefined),
    optional(n.storage?.estimate?()=>n.storage.estimate():undefined),optional(n.storage?.persisted?()=>n.storage.persisted():undefined),
    optional(n.getBattery?async()=>{const b=await n.getBattery!();return {charging:b.charging,level:b.level,charging_time_seconds:finite(b.chargingTime),discharging_time_seconds:finite(b.dischargingTime)};}:undefined)
  ]);
  return {...data,client_hints_high:hints,storage_estimate:storage,storage_persisted:persisted,battery};
}
