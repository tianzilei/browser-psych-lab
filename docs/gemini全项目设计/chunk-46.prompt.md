全项目设计讨论，传输段 46，源码主题：运维工具和部署（源包 15/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

  let previous=null;const wire=rows.map(({event})=>{event.previous=previous;const raw=JSON.stringify(event),row={event_id:event.event_id,hash:digest(raw),raw};previous={event_id:row.event_id,hash:row.hash};return row;});
  const diagnostics=[];
  for(let chunk=0;chunk<80;chunk++){
    const samples=Array.from({length:64},(_,i)=>({type:'pointermove',at:chunk*100+i,raw_timestamp:chunk*100+i,rt_ms:i,context:{instance_id:plan.roots[chunk%32].root_id+':1',item:chunk%6,phase:'rating',asset_id:plan.roots[chunk%32].asset_id},target:'#rating-axis',box:{x:16,y:680,width:358,height:48},x:30+i*4,y:700,pointer_id:1,pointer_type:'touch',button:0,buttons:1,pressure:.5,trusted:false}));
    const event={event_schema_version:'lab-events-v1',event_id:randomUUID(),session_id:member.sid,version_id:fixture.version.version_id,protocol_hash:fixture.version.hash,...member.fence,scope:`d-ui-capacity-${chunk}`,sequence:0,previous:null,clock_epoch:'capacity-synthetic',time_ms:chunk*100,kind:'INPUT_DIAGNOSTIC',payload:{interaction:{schema:'interaction-v1',time_origin:Date.now(),samples}}};const raw=JSON.stringify(event);diagnostics.push({event_id:event.event_id,hash:digest(raw),raw});
  }
  return {wire,diagnostics};
}
const percentile=(v,q)=>[...v].sort((a,b)=>a-b)[Math.max(0,Math.ceil(v.length*q)-1)]??0;
async function wave(concurrency){
  metrics=[];retries=[];members=[];const started=performance.now();console.log(JSON.stringify({stage:'wave-start',concurrency}));
  const errors=[];const users=await Promise.allSettled(Array.from({length:concurrency},create));
  for(const result of users)if(result.status==='rejected')errors.push(String(result.reason));
  const prepared=users.filter(r=>r.status==='fulfilled').map(r=>r.value);
  console.log(JSON.stringify({stage:'download-complete',concurrency,prepared:prepared.length,elapsed_ms:performance.now()-started}));
  const results=await Promise.allSettled(prepared.map(async member=>{
    const {wire,diagnostics}=evidence(member);member.raw_bytes=[...wire,...diagnostics].reduce((n,e)=>n+Buffer.byteLength(e.raw),0);
    for(let i=0;i<diagnostics.length;i+=4)await member.run('ingest',{batch_id:randomUUID(),events:diagnostics.slice(i,i+4)});
    for(let i=0;i<wire.length;i+=32)await member.run('ingest',{batch_id:randomUUID(),events:wire.slice(i,i+32)});
    const start=performance.now(),seal=await member.run('seal',{request_id:randomUUID(),...member.fence,manifest:{manifest_id:randomUUID(),scope:member.permit.scope,path:[member.permit.plan.group_id],events:wire.map(({event_id,hash})=>({event_id,hash}))}});
    member.seal_ms=performance.now()-start;if(seal.status!=='SEALED')throw new Error('SEAL_NOT_COMPLETE');
    const done=await member.run('finalize',{request_id:randomUUID(),...member.fence,seal_ids:[seal.seal_id]});if(done.status!=='COMPLETED')throw new Error('SESSION_NOT_COMPLETE');
    return done;
  }));
  for(const result of results)if(result.status==='rejected')errors.push(String(result.reason));
  const stats=(await call('/api/lab/operations')).value,control=metrics.filter(r=>!r.path.endsWith('/seal')).map(r=>r.ms),overload=retries.filter(r=>r.code!=='MAINTENANCE_BUSY');
  const result={concurrency,completed:results.filter(r=>r.status==='fulfilled').length,elapsed_ms:performance.now()-started,preparation_p95_ms:percentile(prepared.map(m=>m.preparation_ms),.95),control_p95_ms:percentile(control,.95),seal_p95_ms:percentile(prepared.map(m=>m.seal_ms??90000),.95),requests:metrics.length,retry_count:retries.length,overload_count:overload.length,overload_fraction:overload.length/(metrics.length+retries.length),image_bytes:prepared.reduce((n,m)=>n+m.image_bytes,0),raw_bytes:prepared.reduce((n,m)=>n+(m.raw_bytes??0),0),server_memory_bytes:stats.process.rss,errors};
  result.pass=!errors.length&&result.completed===concurrency&&result.preparation_p95_ms<60000&&result.control_p95_ms<2000&&result.seal_p95_ms<30000&&result.overload_fraction<.01&&stats.process.rss<500*1024*1024;
  for(const member of members)await member.run('terminate',{request_id:randomUUID(),reason:'TEST_ONLY_CAPACITY_PROBE'}).catch(()=>{});
  console.log(JSON.stringify(result));return result;
}
const report={schema:'ecs-capacity-v1',mode:'TEST_ONLY',measured_at:new Date().toISOString(),scope:'External HTTPS to isolated ECS process/database, same production code/settings and 102 private images; 32 image downloads + 32 synthetic six-item rating trials + 5120 recorded actions per session. Does not measure physical rendering or real users.',criteria:{preparation_p95_ms:60000,control_p95_ms:2000,seal_p95_ms:30000,max_overload_fraction:.01,max_rss_bytes:500*1024*1024},waves:[]};
try{
  let passed=0,failed=null;
  for(const n of [1,2,4,8,16,24,32,48,64,96,128]){const result=await wave(n);report.waves.push(result);await writeFile(output,JSON.stringify(report,null,2));if(result.pass)passed=n;else{failed=n;break;}await delay(2500);}
  if(failed){while(failed-passed>1){const n=Math.floor((failed+passed)/2);await delay(2500);const result=await wave(n);report.waves.push(result);if(result.pass)passed=n;else failed=n;await writeFile(output,JSON.stringify(report,null,2));}}
  // Confirm the last stable size and the 80% operating size independently.
  await delay(2500);const confirm=await wave(passed);report.waves.push(confirm);
  if(!confirm.pass){passed=Math.max(1,Math.floor(passed*.8));await delay(2500);const fallback=await wave(passed);report.waves.push(fallback);if(!fallback.pass)throw new Error('Capacity confirmation unstable');}
  report.measured_stable_concurrency=passed;report.first_unstable_concurrency=failed;report.operating_concurrency=Math.max(1,Math.floor(passed*.8));
  await delay(2500);const operating=await wave(report.operating_concurrency);report.waves.push(operating);if(!operating.pass)throw new Error('Operating size verification failed');report.verified=true;
  await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({stable:passed,operating:report.operating_concurrency,first_unstable:failed}));
}finally{for(const member of members)await member.run('terminate',{request_id:randomUUID(),reason:'TEST_ONLY_CAPACITY_TEARDOWN'}).catch(()=>{});}

```

### scripts/capacity-probe-seed.mjs L1–L31

```
// Run on the ECS host, against a NEW isolated database. Production is read-only.
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash,scryptSync} from 'node:crypto';
const [release,rootArg]=process.argv.slice(2),root=resolve(rootArg);
const {openDatabase}=await import(`file://${release}/dist/server/database.js`);
const {LabStore}=await import(`file://${release}/dist/server/lab-store.js`);
const {default:Database}=await import(`${release}/node_modules/better-sqlite3/lib/index.js`);
const source=new Database('/var/lib/browser-psych-lab/database/browser-psych-lab.sqlite',{readonly:true});
const frozen=source.prepare('SELECT protocol FROM lab_versions WHERE version_id=?').get('32c9e562-6072-45cf-b469-a8ab56065343');
const protocol=JSON.parse(frozen.protocol);protocol.title='TEST_ONLY isolated ECS capacity';delete protocol.consent;
await mkdir(join(root,'research-assets'),{recursive:true,mode:0o700});
const db=openDatabase(join(root,'database.sqlite'));
const runnerHash=JSON.parse(await readFile(join(release,'dist/release.json'),'utf8')).runnerHash;
const store=new LabStore(db,runnerHash,Date.now,10000),token=randomUUID(),csrf=randomUUID();
const digest=v=>createHash('sha256').update(v).digest('hex');store.execute({operation:'lab/admin.issue',data:{token_hash:digest(token),csrf}});
const admin=(op,data)=>store.execute({operation:`lab/${op}`,credential_hash:digest(token),data:{csrf,...data}});
const study=admin('study.create',{request_id:randomUUID()});
for(const asset of new Set(protocol.groups.flatMap(g=>g.trials.map(t=>t.asset_id)))){
  const row=source.prepare('SELECT * FROM lab_assets WHERE asset_id=?').get(asset);
  await copyFile(`/var/lib/browser-psych-lab/research-assets/${asset}.bin`,join(root,'research-assets',`${asset}.bin`));
  db.prepare("INSERT INTO lab_assets VALUES (?,?,?,'READY',?,?,?,?,?,?,0)").run(asset,study.study_id,row.name,row.hash,row.bytes,row.width,row.height,row.format,randomUUID());
}
const saved=admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol});
const version=admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});
admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
const password=randomUUID(),salt=randomUUID().replaceAll('-',''),hash=`scrypt:${salt}:${scryptSync(password,salt,64).toString('hex')}`;
await writeFile(join(root,'probe.env'),`NODE_ENV=production\nHOST=127.0.0.1\nPORT=3310\nPUBLIC_ORIGIN=https://example.invalid\nDATABASE_PATH=${root}/database.sqlite\nSTORAGE_ROOT=${root}\nSESSION_CONCURRENCY=10000\nPREPARATION_CONCURRENCY=10000\nLOG_LEVEL=error\nADMIN_PASSWORD_HASH=${hash}\n`,{mode:0o600});
await writeFile(join(root,'fixture.json'),JSON.stringify({version,study,assets:source.prepare('SELECT asset_id,hash,bytes FROM lab_assets WHERE study_id=? AND state=\'READY\'').all('3dccccfe-1186-49de-a90f-94556059f4d1'),password}),{mode:0o600});
db.close();source.close();console.log(JSON.stringify({root,study:study.study_id,version:version.version_id,images:protocol.groups[0].trials.length}));

```

### scripts/convert-formbricks-csv.mjs L1–L187

```
import fs from 'node:fs';
import path from 'node:path';

const input = path.resolve('examples/fromoldserver/all_surveys_schema.csv');
const outputDir = path.resolve('examples/fromoldserver/converted');
const PAGE_SIZE = 30;

function parseCsv(source) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((key, i) => [key, r[i] ?? ''])));
}

function parseBlocks(value) {
  // Formbricks exports `blocks` as `{\"<JSON block>\",\"<JSON block>\"}`.
  // The export is not valid JSON when a block contains escaped editor markup, so
  // split the quoted keys at the only top-level delimiter and decode each key.
  const source = value.trim();
  const result = [];
  let i = source[0] === '{' ? 1 : 0;
  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? '')) i += 1;
    if (source[i] === '}') break;
    if (source[i] !== '"') throw new Error('invalid Formbricks blocks export');
    const start = i;
    i += 1;
    let escaped = false;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') break;
    }
    const encoded = source.slice(start, i + 1);
    result.push(JSON.parse(JSON.parse(encoded)));
    i += 1;
  }
  return result;
}

function text(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n').trim();
}

function scaleLabels(min, max, lower, upper) {
  const labels = [lower, ...Array.from({ length: max - min - 1 }, (_, i) => String(min + i + 1)), upper];
  return labels;
}

function maxLength(element) {
  const rules = element.validation?.rules ?? [];
  const maxRule = rules.find(rule => rule.type === 'maxLength' && Number.isInteger(rule.params?.max));
  return Math.max(1, Math.min(4000, maxRule?.params?.max ?? 200));
}

function isPersonalText(title) {
  // The questionnaire contract intentionally permits free text only for
  // personal fields.  Keep the common identifier fields from the old server;
  // report other open-text prompts instead of silently changing their meaning.
  return /(\u59d3\u540d|\u540d\u5b57|\u6635\u79f0|\u7535\u8bdd|\u624b\u673a|\u8054\u7cfb\u65b9\u5f0f|\u90ae\u7bb1|\u90ae\u4ef6|\u95ee\u5377\u7f16\u53f7|\u7f16\u53f7|\u53d7\u8bd5\u8005|\u88ab\u8bd5|name|phone|mobile|email|participant|subject|id)/i.test(title);
}

function questionFromElement(element, index) {
  const id = `q_${String(index + 1).padStart(3, '0')}_${element.id}`;
  const title = text(element.headline?.default) || '\u8865\u5145\u8bf4\u660e\uff08\u53ef\u9009\uff09';
  const required = element.required !== false;
  if (element.type === 'openText') {
    if (!isPersonalText(title)) return { skipped: { id: element.id, type: element.type, title, reason: 'NON_PERSONAL_TEXT_NOT_SUPPORTED' } };
    return { id, type: 'text', title, required, input_purpose: 'personal', max_length: maxLength(element) };
  }
  if (element.type === 'multipleChoiceSingle') {
    const choices = (element.choices ?? []).map(choice => text(choice.label?.default)).filter(Boolean);
    if (choices.length >= 2 && new Set(choices).size === choices.length) {
      return { id, type: 'single', title, required, choices };
    }
    return { skipped: { id: element.id, type: element.type, title, reason: 'INVALID_CHOICE_SET' } };
  }
  if (element.type === 'rating') {
    const min = 1;
    const max = Number.isInteger(element.range) ? element.range : 5;
    if (max < 2 || max > 20) return { skipped: { id: element.id, type: element.type, title, reason: 'INVALID_RATING_RANGE' } };
    const lower = text(element.lowerLabel?.default) || '最低';