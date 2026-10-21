#!/usr/bin/env node
// Local durable alert record + optional webhook/Healthchecks delivery. It never
// includes participant data; only unit state, status counters and paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const root=process.env.STORAGE_ROOT??'/var/lib/browser-psych-lab';
const unit=(process.env.BACKUP_ALERT_UNIT??'manual').replace(/[^a-zA-Z0-9._-]/g,'_');
const alertsDir=path.join(root,'alerts');
fs.mkdirSync(alertsDir,{recursive:true,mode:0o700});try{fs.chmodSync(alertsDir,0o700);}catch{}
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'').replace('T','-');
const statusPath=path.join(root,'backup-status.json');
let status=null;try{status=JSON.parse(fs.readFileSync(statusPath,'utf8'));}catch{}
const show=spawnSync('systemctl',['show',unit,'-p','ActiveState','-p','Result','-p','ExecMainStatus','-p','InvocationID'],{encoding:'utf8'});
const state=Object.fromEntries((show.stdout??'').split('\n').filter(Boolean).map(line=>{const i=line.indexOf('=');return i<0?[line,'']:[line.slice(0,i),line.slice(i+1)];}));
const alert={schema:'backup-alert-v1',at:new Date().toISOString(),host:os.hostname(),unit,state,status:unit.includes('backup-monitor')?status:null};
const file=path.join(alertsDir,`${stamp}-${unit}.json`);
fs.writeFileSync(file,JSON.stringify(alert,null,2)+'\n',{mode:0o600});fs.chmodSync(file,0o600);
fs.appendFileSync(path.join(alertsDir,'alerts.log'),JSON.stringify({at:alert.at,unit,state,status:alert.status?.status??null,file})+'\n',{mode:0o600});
const delivery=[];
if(process.env.BACKUP_ALERT_WEBHOOK){
  const r=spawnSync('curl',['-fsS','-m','10','-X','POST','-H','Content-Type: application/json','--data-binary',`@${file}`,process.env.BACKUP_ALERT_WEBHOOK],{encoding:'utf8'});
  delivery.push({target:'webhook',ok:r.status===0,detail:(r.stderr||r.stdout||'').trim().slice(0,300)});
}
if(process.env.BACKUP_ALERT_HEALTHCHECK_FAIL_URL){
  const r=spawnSync('curl',['-fsS','-m','10',process.env.BACKUP_ALERT_HEALTHCHECK_FAIL_URL],{encoding:'utf8'});
  delivery.push({target:'healthcheck_fail',ok:r.status===0,detail:(r.stderr||r.stdout||'').trim().slice(0,300)});
}
if(delivery.length){alert.delivery=delivery;fs.writeFileSync(file,JSON.stringify(alert,null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify({file,unit,state,delivery,status:alert.status?.status??null},null,2));
if(delivery.some(d=>!d.ok))process.exitCode=1;
