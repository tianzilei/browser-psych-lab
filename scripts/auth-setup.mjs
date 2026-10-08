import {readFile,writeFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {passwordHash} from '../src/server/auth.ts';
import {root} from './lib.mjs';
const role=process.argv[2]??'researcher';if(!['researcher','maintainer'].includes(role))throw new Error('Use researcher or maintainer.');
let password;
if(process.argv[3]==='--password-file'){password=(await readFile(resolve(process.argv[4]),'utf8')).trimEnd();}
else{
 if(!process.stdin.isTTY)throw new Error('Use a TTY or --password-file.');
 process.stdout.write(`Set ${role} password (12–256 characters): `);process.stdin.setRawMode(true);process.stdin.resume();
 try{password=await new Promise((resolve,reject)=>{let text='';const input=b=>{for(const c of b.toString()){if(c==='\u0003'){process.stdin.off('data',input);reject(new Error('Cancelled'));return;}if(c==='\r'||c==='\n'){process.stdin.off('data',input);resolve(text);return;}if(c==='\u007f')text=text.slice(0,-1);else text+=c;}};process.stdin.on('data',input);});}finally{
 process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
}
const hashed=await passwordHash(password);const path=resolve(root,'.env');let env='';try{env=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const key=role==='maintainer'?'MAINTAINER_PASSWORD_HASH':'ADMIN_PASSWORD_HASH';env=env.split('\n').filter(line=>!line.startsWith(`${key}=`)).join('\n').trimEnd()+`\n${key}=${hashed}\n`;
await writeFile(path,env,{mode:0o600});await chmod(path,0o600);console.log(`${role} password hash saved; restart the server.`);
