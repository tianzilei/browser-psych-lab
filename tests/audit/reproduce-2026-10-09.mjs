import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from '@playwright/test';
import {sampleProtocol,parseProtocol} from '../../src/shared/protocol.ts';
import {Scheduler} from '../../src/shared/scheduler.ts';
import {RunReplay} from '../../src/shared/run-replay.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/server/database.ts';
import {CollectionStore} from '../../src/server/collection-store.ts';
import {DatabaseWriter} from '../../src/server/writer.ts';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {once} from 'node:events';
import {realizeTrials} from '../../src/shared/trial-design.ts';

const results=[];
function protocol(commit=40,duration=200){
  const p=sampleProtocol();p.pages=[];p.budget.commit_ms=commit;
  p.groups=[{id:'task',title:'Audit',choices:['left','right'],repeats:0,trials:[
    {root_id:'one',text:'ONE',image_ms:duration,isi_ms:0,correct:null},
    {root_id:'two',text:'TWO',image_ms:duration,isi_ms:0,correct:null}]}];
  p.variants[0].group_order=['task'];p.variants[0].trial_order={task:['one','two']};
  return parseProtocol(p);
}
const large=protocol(1000),startup=new Scheduler(large.groups[0].trials,0,1000,[1,2,3,4],large.budget);
assert.throws(()=>startup.stage('first',0,'audit'),/COMMIT_DEADLINE_UNSAFE/);
results.push({finding:'startup-budget',accepted_protocol:true,budget:large.budget.commit_ms+large.budget.activate_ms+large.budget.margin_ms,start:1000,error:startup.reason});

const short=protocol(40,10),quantized=realizeTrials(short.groups[0],short.groups[0].trials,[1,2,3,4],1000/60),next=new Scheduler(quantized.roots,0,1000,[1,2,3,4],short.budget);
next.stage('first',0,'audit');next.acknowledge('first',1);next.onset('one:1');
assert.throws(()=>next.stage('second',1000,'audit'),/COMMIT_DEADLINE_UNSAFE/);
results.push({finding:'short-static-trial',accepted_protocol:true,next_target:1000+quantized.roots[0].image_ms,frame_ms:1000/60,stage_at:1000,budget:short.budget.commit_ms+short.budget.activate_ms+short.budget.margin_ms,error:next.reason});

const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.setContent('<button style="width:200px;height:100px">Left</button>');
  const source=readFileSync(new URL('../../src/web/runner-input.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  await page.evaluate(async code=>{
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),module=await import(url);URL.revokeObjectURL(url);
    window.auditRecords=[];window.auditEvents=[];
    for(const name of ['pointerdown','pointerup','pointermove'])window.addEventListener(name,e=>window.auditEvents.push({type:e.type,button:e.button,buttons:e.buttons}));
    window.auditOrigin=performance.now()-1000;
    module.bindRunnerInput({choices:['left','right'],geometry:{buttons:[{choice:'left',x:0,y:0,width:400,height:200}]}},window.auditOrigin,r=>window.auditRecords.push({...r,clock_origin:window.auditOrigin}));
  },js);
  await page.mouse.move(50,50);await page.mouse.down({button:'left'});await page.mouse.down({button:'right'});
  await page.mouse.up({button:'left'});await page.mouse.up({button:'right'});
  const trace=await page.evaluate(()=>({events:window.auditEvents,records:window.auditRecords}));
  assert.deepEqual(trace.records.map(r=>r.action),['down']);
  await page.mouse.click(50,50);
  const records=await page.evaluate(()=>window.auditRecords),accepted=[];
  const plan={group_id:'task',scope:'audit',seed:[1,2,3,4],roots:[{root_id:'one',text:'ONE',image_ms:10000,isi_ms:0,correct:null}],choices:['left','right'],repeats:0,start:1000,budget:sampleProtocol().budget,
    geometry:{buttons:[{choice:'left',x:0,y:0,width:400,height:200}]}};
  const replay=new RunReplay(plan),sourceScheduler=new Scheduler(plan.roots,0,1000,plan.seed,plan.budget),clock_origin=records[0].clock_origin;
  replay.apply({type:'OP',at:0,clock_origin,operation:sourceScheduler.stage('initial',0,'audit')});
  replay.apply({type:'COMMIT',at:1,clock_origin,op_id:'initial'});
  replay.apply({type:'ONSET',at:1000,clock_origin,draw_time:1000,instance_id:'one:1'});
  for(const r of records){r.valid=r.action==='down'&&!replay.pointers.has(r.pointer_id)&&replay.pointers.size===0&&r.choice!==null;
    if(r.action==='down')accepted.push(r.valid);replay.apply(r);}
  assert.deepEqual(accepted,[true,false]);
  assert.equal(replay.pointers.size,0);
  results.push({finding:'pointer-chord',trace,subsequent_press_accepted:accepted[1],validated_by:'RunReplay',held_after_next_release:replay.pointers.size});
}finally{await browser.close();}

// Fault injection models a stale owner row after the OS has reused its PID.
// This live audit process is not a database owner; no production data is used.
const directory=await mkdtemp(join(tmpdir(),'bpl-audit-owner-'));
try{
  const path=join(directory,'db.sqlite'),db=openDatabase(path);new CollectionStore(db);
  db.prepare("INSERT INTO p0_meta VALUES ('app_instance',?)").run(JSON.stringify({pid:process.pid,owner:'previous-crashed-owner'}));db.close();
  const writer=new DatabaseWriter(path);
  try{await assert.rejects(writer.start(),/DATABASE_ALREADY_OWNED/);await writer.waitForExit();}
  finally{await writer.close();}
  results.push({finding:'stale-owner-pid-reuse',fault_injection:true,active_database_owner:false,error:'DATABASE_ALREADY_OWNED'});
}finally{await rm(directory,{recursive:true,force:true});}

// Run the exact preview HTTP callback in an isolated child: the full preview
// server requires POSIX storage, but this redirect callback has no DB dependency.
const preview=readFileSync(new URL('../../scripts/preview-questionnaire.mjs',import.meta.url),'utf8');
const callback=preview.slice(preview.indexOf('redirect=createServer('),preview.indexOf('  redirect.headersTimeout='));
const child=spawn(process.execPath,['--input-type=module','-e',
  "import {createServer} from 'node:http'; let redirect; const origin='https://127.0.0.1:3082',ip='127.0.0.1',tlsPort=3082; "+callback+
  "redirect.listen(0,'127.0.0.1',()=>console.log(redirect.address().port));"],{stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',b=>errors+=b.toString());
const exited=once(child,'exit');
try{
  const [chunk]=await once(child.stdout,'data'),port=Number(chunk.toString().trim()),socket=connect(port,'127.0.0.1');
  socket.on('error',()=>{});await once(socket,'connect');
  socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  const timeout=setTimeout(()=>child.kill(),5000);const [code]=await exited;clearTimeout(timeout);
  assert.equal(code,1);assert.match(errors,/ERR_INVALID_URL/);
  results.push({finding:'preview-malformed-url-crash',isolated_real_handler:true,raw_http_target:'http://[',exit_code:code,error:'ERR_INVALID_URL'});
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}}
console.log(JSON.stringify(results,null,2));
