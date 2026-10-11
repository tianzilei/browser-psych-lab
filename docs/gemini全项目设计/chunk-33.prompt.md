全项目设计讨论，传输段 33，源码主题：本地账本与参加者生命周期（源包 11/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

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

```

### src/web/consent-gate.ts L1–L26

```
import {request} from './dom.js';
import {stableJSON,type Protocol} from '../shared/protocol.js';
import {sha256} from './local-store.js';
import type {Ledger} from './ledger.js';
import {mountConsent,showConsentDeclined} from './consent-page.js';
export interface ConsentReceipt {accepted:true;document_hash:string}

export async function requireConsent(ledger:Ledger):Promise<ConsentReceipt|undefined>{
  const consent=await request<{document:NonNullable<Protocol['consent']>;document_hash:string}|null>(`/api/participate/versions/${ledger.version}/consent`);
  if(!consent)return;
  if(await sha256(stableJSON(consent.document))!==consent.document_hash)throw new Error('知情同意书版本校验失败。');
  const old=(await ledger.state()).consent;
  if(old?.accepted===true&&old.document_hash===consent.document_hash)return old;
  const content=document.querySelector<HTMLElement>('#content')!,status=document.querySelector<HTMLElement>('#status')!;
  status.textContent='参加前请阅读知情同意书。';
  let dispose:()=>void=()=>{},cancel:()=>void=()=>{};
  try{
    await new Promise<void>((resolve,reject)=>{
      cancel=()=>{dispose();reject(new Error('页面已关闭。'));};window.addEventListener('pagehide',cancel,{once:true});
      const read=()=>{dispose();status.textContent='参加前请阅读知情同意书。';dispose=mountConsent(content,consent.document,resolve,()=>{dispose();status.textContent='未同意参加';showConsentDeclined(content,read);});};read();
    });
  }finally{dispose();window.removeEventListener('pagehide',cancel);}
  const receipt:ConsentReceipt={accepted:true,document_hash:consent.document_hash};
  await ledger.consent(receipt);status.textContent='已同意参加，正在准备问卷…';content.replaceChildren();return receipt;
}

```