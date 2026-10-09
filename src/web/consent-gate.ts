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
