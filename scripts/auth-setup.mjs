import {readFile,writeFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {passwordHash} from '../src/server/auth.ts';
import {root} from './lib.mjs';
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--password-file'))throw new Error('Use auth:setup or auth:setup -- --password-file PATH.');
let password;
if(args[0]==='--password-file'){password=(await readFile(resolve(args[1]),'utf8')).trimEnd();}
else{
 if(!process.stdin.isTTY)throw new Error('Use a TTY or --password-file.');
 process.stdout.write('Set admin password (12–256 characters): ');process.stdin.setRawMode(true);process.stdin.resume();
 try{password=await new Promise((resolve,reject)=>{let text='';const input=b=>{for(const c of b.toString()){if(c==='\u0003'){process.stdin.off('data',input);reject(new Error('Cancelled'));return;}if(c==='\r'||c==='\n'){process.stdin.off('data',input);resolve(text);return;}if(c==='\u007f')text=text.slice(0,-1);else text+=c;}};process.stdin.on('data',input);});}finally{
 process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
}
const hashed=await passwordHash(password);const path=resolve(root,'.env');let env='';try{env=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
env=env.split('\n').filter(line=>!/^\s*(?:ADMIN_PASSWORD_HASH|MAINTAINER_PASSWORD_HASH)=/.test(line)).join('\n').trimEnd()+`\nADMIN_PASSWORD_HASH=${hashed}\n`;
await writeFile(path,env,{mode:0o600});await chmod(path,0o600);console.log('Admin password hash saved; restart the server.');
