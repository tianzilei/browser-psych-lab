全项目设计讨论，传输段 45，源码主题：运维工具和部署（源包 15/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

### deploy/1c2g.conf L1–L8

```
# Optional systemd drop-in for an ECS 1 vCPU / 2 GiB pilot.
# Install as /etc/systemd/system/browser-psych-lab.service.d/1c2g.conf.
# These limits are starting points; measure RSS/OOM on the actual host.
# Set SESSION_CONCURRENCY=1 and PREPARATION_CONCURRENCY=1 in the env file.
[Service]
Environment=UV_THREADPOOL_SIZE=1
MemoryMax=1024M

```

### deploy/Caddyfile L1–L29

```
# Browser Psych Lab reverse proxy.
# Replace study.example with the public DNS name of this server.
# Caddy obtains and renews the HTTPS certificate automatically.

study.example {
	# The application enforces an 8 MiB upload limit as well.
	request_body {
		max_size 8MB
	}

	# Keep response bodies unchanged. The application already serves its
	# precompressed public assets and private data must pass through exactly.
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Forwarded-Proto https
	}
}

# Optional local-network testing without a public DNS name:
#
# 192.168.1.50 {
#	 tls internal
#	 request_body {
#		 max_size 8MB
#	 }
#	 reverse_proxy 127.0.0.1:3000 {
#		 header_up X-Forwarded-Proto https
#	 }
# }

```

### deploy/browser-psych-lab-backup.service L1–L14

```
[Unit]
Description=Browser Psych Lab joint backup
After=browser-psych-lab.service
[Service]
Type=oneshot
User=psychlab
Group=psychlab
WorkingDirectory=/opt/browser-psych-lab/current
EnvironmentFile=/etc/browser-psych-lab.env
Environment=BACKUP_PASSWORD_FILE=/etc/browser-psych-lab-backup-password
ExecStart=/opt/node/bin/node scripts/backup.mjs
UMask=0077
NoNewPrivileges=true

```

### deploy/browser-psych-lab-backup.timer L1–L9

```
[Unit]
Description=Browser Psych Lab daily joint backup
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target

```

### deploy/browser-psych-lab.service L1–L29

```
[Unit]
Description=Browser Psych Lab
After=network.target
[Service]
Type=simple
User=psychlab
Group=psychlab
WorkingDirectory=/opt/browser-psych-lab/current
EnvironmentFile=/etc/browser-psych-lab.env
ExecStart=/opt/node/bin/node dist/server/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
# Leave CPU capacity for nginx, SQLite fsync and kernel I/O on a 2 vCPU host.
Environment=UV_THREADPOOL_SIZE=2
CPUWeight=100
IOWeight=100
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/browser-psych-lab /mnt/psychlab-backup
LimitNOFILE=4096
MemoryMax=1536M
TasksMax=64
[Install]
WantedBy=multi-user.target

```

### deploy/nginx.conf L1–L37

```
# Replace study.example and certificate paths with the actual deployed host.
server {
    listen 80;
    server_name study.example;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name study.example;
    ssl_certificate /etc/letsencrypt/live/study.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/study.example/privkey.pem;
    client_max_body_size 8m;
    keepalive_timeout 75s;
    keepalive_requests 1000;
    # Private responses and original image bytes must pass through unchanged.
    gzip off;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
        proxy_read_timeout 150s;
        proxy_send_timeout 30s;
        proxy_buffering off;
    }
    # Public hashed JS/CSS have compressed alternatives served by Fastify.
    location ~ ^/(assets/|runners/[a-f0-9]{64}/assets/) {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_max_temp_file_size 0;
    }
}

```

### deploy/production.env.example L1–L20

```
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://study.example
# Optional direct TLS; configure both together. Leave unset behind a TLS proxy.
# TLS_KEY_PATH=/protected/server-key.pem
# TLS_CERT_PATH=/protected/server.pem
DATABASE_PATH=/var/lib/browser-psych-lab/database/browser-psych-lab.sqlite
STORAGE_ROOT=/var/lib/browser-psych-lab
# Different mounted filesystem, owned by psychlab, private permissions.
BACKUP_ROOT=/mnt/psychlab-backup
LOG_LEVEL=info
# Image/timed-task sessions: floor(0.8 * measured stable capacity). No waiting queue.
# Questionnaires without task groups do not consume these slots.
SESSION_CONCURRENCY=2
# Image preparation: floor(0.8 * measured download capacity), minimum 1.
PREPARATION_CONCURRENCY=1
# Generate the single admin hash with auth:setup, then copy it to this protected file.
ADMIN_PASSWORD_HASH=

```

### scripts/auth-setup.mjs L1–L18

```
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

```

### scripts/backup.mjs L1–L11

```
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

```

### scripts/browser-server.mjs L1–L17

```
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const {passwordHash}=await import('../dist/server/auth.js');
process.env.ADMIN_PASSWORD_HASH=await passwordHash('TEST_ONLY-browser-password');
process.env.SESSION_CONCURRENCY='2';
process.env.PREPARATION_CONCURRENCY='1';
const directory = await mkdtemp(join(tmpdir(), 'bpl-browser-'));
process.env.DATABASE_PATH = join(directory, 'database.sqlite');
process.env.STORAGE_ROOT = directory;
for (const bucket of ['research-assets', 'research-exports', 'research-backups'])
  await mkdir(join(directory, bucket), { mode: 0o700 });
process.once('exit', () => { rmSync(directory, { recursive: true, force: true }); });
try { await import('../dist/server/main.js'); }
catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }

```

### scripts/capacity-probe-client.mjs L1–L97

```
// External HTTPS load client; never points at the production API/database.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const fixture=JSON.parse(await readFile('.local/capacity-fixture.json','utf8'));
const origin='https://example.invalid',base=origin+'/__capacity_probe__';
const digest=v=>createHash('sha256').update(v).digest('hex'),delay=ms=>new Promise(r=>setTimeout(r,ms));
let cookie='',csrf='',metrics=[],retries=[],members=[];
const output=process.argv[2]??'.local/ecs-capacity.json';
async function call(path,data,c=cookie,admin=true){
  const started=performance.now();
  for(let attempt=0;;attempt++){
    const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:c,...(admin?{'X-CSRF-Token':csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(45000)});
    const value=await response.json();
    if([429,503].includes(response.status)&&attempt<100&&performance.now()-started<90000){retries.push({path,code:value.code});await delay(value.code==='MAINTENANCE_BUSY'?150+Math.random()*300:300+Math.random()*500);continue;}
    metrics.push({path,ms:performance.now()-started,status:response.status});
    if(!response.ok)throw new Error(`${path}: ${response.status} ${value.code}`);
    return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
}
const login=await call('/api/auth/login',{password:fixture.password},'',false);cookie=login.cookie;csrf=login.value.csrf;
const assetMap=new Map(fixture.assets.map(a=>[a.asset_id,a]));
async function create(){
  const created=await call('/api/participate/sessions',{request_id:randomUUID(),version_id:fixture.version.version_id,credential:digest(randomUUID())},'',false);
  const sid=created.value.session_id,c=created.cookie,path=`/api/participate/sessions/${sid}`;
  const member={sid,path,c},run=async(op,data)=>(await call(`${path}/${op}`,data,c,false)).value;member.run=run;members.push(member);
  await run('admission',{action:'join',ticket_id:randomUUID()});
  const writer_id=randomUUID(),session=await run('claim',{request_id:randomUUID(),writer_id}),fence={writer_id,writer_epoch:session.writer_epoch};member.fence=fence;member.session=session;
  const reservation=await run('reserve',{request_id:randomUUID(),...fence});member.reservation=reservation;
  const ticket_id=randomUUID();await run('preparation',{action:'join',ticket_id,...fence});
  const started=performance.now();let bytes=0;
  for(const root of reservation.selection.roots){const asset=assetMap.get(root.asset_id);
    for(let attempt=0;;attempt++){
      const response=await fetch(`${base}${path}/assets/${root.asset_id}`,{headers:{Cookie:c,'X-Preparation-Ticket':ticket_id,'X-Writer-Id':writer_id,'X-Writer-Epoch':String(session.writer_epoch)},signal:AbortSignal.timeout(120000)});
      if([429,503].includes(response.status)&&attempt<100){const value=await response.json();retries.push({path:'/assets',code:value.code});await delay(300+Math.random()*500);continue;}
      if(!response.ok)throw new Error(`asset HTTP ${response.status}`);
      const data=Buffer.from(await response.arrayBuffer());if(data.length!==asset.bytes||digest(data)!==asset.hash)throw new Error('IMAGE_HASH_MISMATCH');bytes+=data.length;break;
    }
  }
  member.preparation_ms=performance.now()-started;member.image_bytes=bytes;
  await run('preparation',{action:'release',ticket_id});
  const choices=session.frozen.protocol.groups[0].choices;
  member.permit=await run('permit',{request_id:randomUUID(),...fence,reservation_id:reservation.reservation_id,readiness:{frame_ms:1000/60,commit_ms:5,protocol_hash:fixture.version.hash,layout:'portrait',assets:Object.fromEntries(reservation.selection.roots.map(t=>[t.asset_id,assetMap.get(t.asset_id).hash])),geometry:{viewport:{width:390,height:844,dpr:1},canvas:{x:0,y:0,width:300,height:300/session.frozen.protocol.layout.aspect},buttons:choices.map((choice,i)=>({choice,x:i*40,y:600,width:40,height:48}))}}});
  return member;
}
function evidence(member){
  const plan=member.permit.plan,records=[];let at=plan.start;
  for(const root of plan.roots){const id=root.root_id+':1';records.push({type:'RATING_INTENT',at:at-1,instance_id:id},{type:'ONSET',at,draw_time:at,raf_time:at,instance_id:id});
    const count=plan.rating.items.length;for(let item=0;item<count;item++)records.push({type:'RATING_CHANGE',at:at+200+item*1000,instance_id:id,item,value:5});
    at+=10000;records.push({type:'RATING',at,draw_time:at,raf_time:at,input_time:at-1,instance_id:id,values:[...Array(count).fill(5),40]});at+=root.isi_ms;records.push({type:'END',at,instance_id:id});at+=10;
  }
  records.push({type:'CLOSING',at,unresolved:false});
  const rows=records.map((record,sequence)=>{const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:member.sid,version_id:fixture.version.version_id,protocol_hash:fixture.version.hash,...member.fence,scope:plan.scope,sequence,previous:null,clock_epoch:'capacity-synthetic',time_ms:record.at,kind:'GROUP_RECORD',payload:{record}};return {event,sequence};});