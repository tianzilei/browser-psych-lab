import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const origin=process.env.BACKUP_API_ORIGIN??'http://127.0.0.1:3000';
const passwordFile=process.env.BACKUP_PASSWORD_FILE;
if(!passwordFile)throw new Error('Set BACKUP_PASSWORD_FILE to a private admin password file.');
const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{Origin:process.env.PUBLIC_ORIGIN??origin,'Content-Type':'application/json'},body:JSON.stringify({password:(await readFile(passwordFile,'utf8')).trimEnd()})});
if(!login.ok)throw new Error(`LOGIN_FAILED_${login.status}`);const {csrf}=await login.json(),cookie=login.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('LOGIN_COOKIE_MISSING');
try{const response=await fetch(`${origin}/api/lab/jobs/backup`,{method:'POST',headers:{Origin:process.env.PUBLIC_ORIGIN??origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({request_id:randomUUID(),job_id:randomUUID()}),signal:AbortSignal.timeout(150000)});const result=await response.json();if(!response.ok)throw new Error(`BACKUP_FAILED_${result.code}`);console.log(JSON.stringify(result));}
finally{await fetch(`${origin}/api/auth/logout`,{method:'POST',headers:{Origin:process.env.PUBLIC_ORIGIN??origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:'{}'});}
