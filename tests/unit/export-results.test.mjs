import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from '../helpers/lab-fixture.mjs';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {DatabaseWriter} from '../../src/server/writer.ts';
import {Maintenance} from '../../src/server/maintenance.ts';
import {digest} from '../../src/server/collection-store.ts';
import {fileHash,safeDownload} from '../../src/server/private-files.ts';
import {exportDateTime} from '../../src/server/export-csv.ts';

// Parse quoted multiline CSV to verify actual cells rather than substring approximations.
function csvRows(text){
  const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\r'&&text[i+1]==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';i++;}else cell+=c;
  }
  const header=rows.shift();header[0]=header[0].replace(/^\uFEFF/,'');return rows.map(row=>Object.fromEntries(header.map((key,i)=>[key,row[i]])));
}
test('result and trajectory CSVs preserve answer states, source clocks, safe text and snapshot hashes',async t=>{
  const protocol=compileQuestionnaire({schema:'questionnaire-v1',title:'=研究标题',orientation:'portrait',pages:[{id:'page',questions:[
    {id:'gate',type:'single',title:'选择',choices:['是','否']},
    {id:'score',type:'scale',title:'评分',min:-1,labels:['低','中','高']},
    {id:'note',type:'text',input_purpose:'personal',title:'个人信息',max_length:100},
    {id:'multi',type:'multi',title:'多选',choices:['中文,"引号"\n下一行','B']},
    {id:'axes',type:'scales',title:'多坐标',required:false,axes:[{id:'left',title:'左',min:0,labels:['低','中','高']},{id:'right',title:'右',min:0,labels:['低','中','高']}]},
    {id:'optional',type:'single',title:'选填',required:false,choices:['A','B']},
    {id:'skipped',type:'single',title:'分支题',choices:['A','B'],condition:{op:'eq',question:'gate',value:'否'}},
  ]}]});
  const f=fixture(t,protocol),sample={type:'pointerdown',at:12.5,raw_timestamp:12.5,context:{page_id:'page',question_id:'gate'},target:'=target',box:null,x:0,y:2,trusted:true,data:'无损压缩测试'.repeat(1000)};
  const action=f.wire('d-ui-test','INPUT_DIAGNOSTIC',{interaction:{schema:'interaction-v1',time_origin:1700000000123.5,samples:[sample]}},{sequence:0,previous:null});assert.equal(f.ingest([action]).receipts[0].disposition,'ACCEPTED');
  const final=f.wire('page','PAGE_SNAPSHOT',{answers:{gate:'是',score:-1,note:' =SUM(1,2)',multi:['中文,"引号"\n下一行'],axes:{left:0},optional:null}},{sequence:0,previous:null});f.ingest([final]);const seal=f.seal('page',[final],['page']);f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:[seal.seal_id]});
  // Export even a completed session with later quarantined diagnostic evidence.
  const invalid=f.wire('d-ui-bad','INPUT_DIAGNOSTIC',{interaction:{schema:'interaction-v1',time_origin:0,samples:[{}]}},{sequence:0,previous:null});assert.equal(f.ingest([invalid]).receipts[0].disposition,'QUARANTINED');
  const created=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),credential_hash:digest('new-session')}});
  const interrupted=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),credential_hash:digest('interrupted')}});
  f.store.execute({operation:'lab/participant.terminate',session_id:interrupted.session_id,credential_hash:digest('interrupted'),data:{request_id:randomUUID(),reason:'USER_LEFT'}});
  const writer=new DatabaseWriter(f.path);await writer.start();const maintenance=new Maintenance(writer,f.path,f.root);
  try{
    const exported=await maintenance.run('EXPORT',{study_id:f.study.study_id}),directory=join(f.root,'research-exports',exported.job_id),manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
    const answers=csvRows(await readFile(join(directory,'answers.csv'),'utf8')),trajectories=csvRows(await readFile(join(directory,'trajectories.csv'),'utf8'));
    const full=csvRows(await readFile(join(directory,'data.csv'),'utf8'));
    assert.equal(JSON.parse(full.find(row=>row.table==='events'&&JSON.parse(row.data_json).event_id===action.event_id).data_json).envelope,action.raw);
    assert.equal(JSON.parse(full.find(row=>row.table==='raw'&&JSON.parse(row.data_json).event_id===action.event_id).data_json).raw_utf8,action.raw);
    assert.equal(answers.length,3);assert.equal(new Set(answers.map(row=>row.session_id)).size,3);
    const answer=(id,sid=f.created.session_id,axis='')=>{const row=answers.find(row=>row.session_id===sid),field=manifest.answer_columns.find(col=>col.question_id===id&&col.axis_id===axis);return {...row,answer_numeric:row[field.value_column],answer_text:row[field.value_column],answer_state:row[field.state_column],answer_json:field.json_column?row[field.json_column]:row[field.value_column]||'null',scale_label:row[field.label_column]};};
    assert.equal(answer('score').answer_numeric,'-1');assert.equal(answer('score').scale_label,'低');assert.equal(answer('score').answer_state,'ANSWERED');assert.equal(answer('score').session_state,'COMPLETED');
    assert.equal(answer('note').answer_text,"' =SUM(1,2)");assert.equal(JSON.parse(answer('note').answer_json),' =SUM(1,2)');assert.equal(answer('note').study_title,"'=研究标题");
    assert.deepEqual(JSON.parse(answer('multi').answer_json),['中文,"引号"\n下一行']);
    assert.equal(answer('axes',f.created.session_id,'left').answer_numeric,'0');assert.equal(answer('axes',f.created.session_id,'right').answer_state,'UNANSWERED');assert.equal(answer('axes',f.created.session_id,'right').answer_json,'null');
    assert.equal(answer('optional').answer_state,'UNANSWERED');assert.equal(answer('skipped').answer_state,'SKIPPED');assert.equal(answer('gate',created.session_id).answer_state,'UNCONFIRMED');assert.equal(answer('gate',interrupted.session_id).session_state,'TERMINATED');
    assert.equal(answers[0].session_created_at,'1970-01-01 08:00:01.000');assert.equal(answers[0].last_received_at,'1970-01-01 08:00:01.000');assert.equal(answers[0].time_zone,'Asia/Shanghai');
    assert.equal(manifest.answers_layout,'one-session-per-row-v1');assert.equal(manifest.answers_time_zone,'Asia/Shanghai');
    const trajectory=trajectories.find(row=>row.event_id===action.event_id);assert.equal(trajectory.time_origin,'1700000000123.5');assert.equal(trajectory.at,'12.5');assert.equal(trajectory.x,'0');assert.equal(trajectory.target,"'=target");assert.equal(trajectory.disposition,'ACCEPTED');assert.deepEqual(JSON.parse(trajectory.payload_json),sample);
    const rejected=trajectories.find(row=>row.event_id===invalid.event_id);assert.equal(rejected.disposition,'QUARANTINED');assert.equal(rejected.reason,'INVALID_INTERACTION_BATCH');assert.ok(rejected.payload_json.includes('interaction'));
    assert.equal(manifest.files['answers.csv'].rows,answers.length);assert.equal(manifest.files['trajectories.csv'].rows,trajectories.length);
    for(const file of ['answers.csv','trajectories.csv']){assert.equal(manifest.files[file].hash,await fileHash(join(directory,file)));assert.equal(manifest.files[file].bytes,(await readFile(join(directory,file))).length);}
    const opened=await safeDownload(f.root,exported.job_id,'answers.csv','research-exports');await opened.close();
    await assert.rejects(safeDownload(f.root,exported.job_id,'trajectories.csv','research-exports'),error=>error.code==='TRAJECTORY_DOWNLOAD_DISABLED'&&error.status===410);
    assert.ok(answers.every(row=>row.snapshot_id===manifest.snapshot_id));assert.ok(trajectories.every(row=>row.snapshot_id===manifest.snapshot_id));assert.equal(manifest.csv_hash,await fileHash(join(directory,'data.csv')));
    assert.ok(!Object.keys(answers[0]).some(key=>key.includes('credential')));assert.ok(!Object.keys(trajectories[0]).some(key=>key.includes('credential')));
    const lightweight=await maintenance.run('EXPORT',{study_id:f.study.study_id,format:'answers'}),lightDirectory=join(f.root,'research-exports',lightweight.job_id);
    assert.deepEqual((await readdir(lightDirectory)).sort(),['answers.csv','manifest.json','preparations.csv']);
    assert.equal(lightweight.result.format,'answers');assert.equal(lightweight.result.csv_hash,undefined);
    const withoutSnapshot=rows=>rows.map(({snapshot_id,...row})=>row);
    assert.deepEqual(withoutSnapshot(csvRows(await readFile(join(lightDirectory,'answers.csv'),'utf8'))),withoutSnapshot(answers));
    assert.equal(lightweight.result.files['answers.csv'].hash,await fileHash(join(lightDirectory,'answers.csv')));
    await assert.rejects(safeDownload(f.root,exported.job_id,'answers.csv','research-backups'),/INVALID_DOWNLOAD_OBJECT/);
    const second=await maintenance.run('EXPORT',{study_id:f.study.study_id});assert.notEqual(second.result.snapshot_id,manifest.snapshot_id);
  }finally{await maintenance.close();await writer.close();}
});
test('multi-page exports distinguish skipped, current unconfirmed and future not-reached questions',async t=>{
  const protocol=compileQuestionnaire({schema:'questionnaire-v1',title:'多页问卷',orientation:'portrait',pages:[
    {id:'first',questions:[{id:'gate',type:'single',title:'分支选择',choices:['是','否']}]},
    {id:'hidden',condition:{op:'eq',question:'gate',value:'否'},questions:[{id:'hidden_answer',type:'single',title:'分支题',choices:['A','B']}]},
    {id:'future',questions:[{id:'future_answer',type:'single',title:'后续题',choices:['A','B']}]},
  ]});
  const f=fixture(t,protocol),final=f.wire('first','PAGE_SNAPSHOT',{answers:{gate:'是'}});f.ingest([final]);f.seal('first',[final],['first']);
  const created=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),credential_hash:digest('not-started')}});
  const writer=new DatabaseWriter(f.path);await writer.start();const maintenance=new Maintenance(writer,f.path,f.root);
  try{
    const exported=await maintenance.run('EXPORT',{study_id:f.study.study_id}),rows=csvRows(await readFile(join(f.root,'research-exports',exported.job_id,'answers.csv'),'utf8'));
    assert.equal(rows.length,2);const state=(sid,q)=>rows.find(row=>row.session_id===sid)[exported.result.answer_columns.find(col=>col.question_id===q).state_column];
    assert.equal(state(f.created.session_id,'gate'),'ANSWERED');assert.equal(state(f.created.session_id,'hidden_answer'),'SKIPPED');assert.equal(state(f.created.session_id,'future_answer'),'UNCONFIRMED');
    assert.equal(state(created.session_id,'gate'),'UNCONFIRMED');assert.equal(state(created.session_id,'hidden_answer'),'NOT_REACHED');assert.equal(state(created.session_id,'future_answer'),'NOT_REACHED');
  }finally{await maintenance.close();await writer.close();}
});

test('wide answers preserve cross-version columns, quoted headers and absent questions',async t=>{
  const first=compileQuestionnaire({schema:'questionnaire-v1',title:'版本一',orientation:'portrait',pages:[{id:'page',questions:[
    {id:'common',type:'scale',title:'相同,"题名"\n下一行',min:0,labels:['低','高']},
    {id:'legacy',type:'text',title:'相同,"题名"\n下一行',input_purpose:'personal',max_length:20},
  ]}]});
  const f=fixture(t,first),snapshot=f.wire('page','PAGE_SNAPSHOT',{answers:{common:0,legacy:'old value'}});f.ingest([snapshot]);f.seal('page',[snapshot],['page']);
  const second=compileQuestionnaire({schema:'questionnaire-v1',title:'版本二',orientation:'portrait',pages:[{id:'page',questions:[
    {id:'common',type:'scale',title:'新题名',min:0,labels:['旧','新']},
    {id:'added',type:'single',title:'新增',choices:['A','B']},
  ]}]});
  const saved=f.admin('study.save',{request_id:randomUUID(),study_id:f.study.study_id,revision:2,protocol:second});
  const version=f.admin('study.publish',{request_id:randomUUID(),study_id:f.study.study_id,revision:saved.revision});
  const created=f.store.execute({operation:'lab/participant.create',data:{...f.admission,request_id:randomUUID(),version_id:version.version_id,credential_hash:digest('new-version')}});
  const writer=new DatabaseWriter(f.path);await writer.start();const maintenance=new Maintenance(writer,f.path,f.root);
  try{
    const exported=await maintenance.run('EXPORT',{study_id:f.study.study_id,format:'answers'}),rows=csvRows(await readFile(join(f.root,'research-exports',exported.job_id,'answers.csv'),'utf8'));
    const field=id=>exported.result.answer_columns.find(col=>col.question_id===id),old=rows.find(r=>r.session_id===f.created.session_id),fresh=rows.find(r=>r.session_id===created.session_id);
    assert.equal(rows.length,2);assert.equal(old[field('common').value_column],'0');assert.equal(old[field('common').label_column],'低');assert.equal(old[field('legacy').value_column],'old value');
    assert.equal(old[field('added').state_column],'NOT_IN_VERSION');assert.equal(fresh[field('legacy').state_column],'NOT_IN_VERSION');assert.equal(fresh[field('added').state_column],'UNCONFIRMED');
    assert.ok(field('legacy').value_column.includes('相同,"题名"\n下一行'));assert.equal(new Set(exported.result.files['answers.csv'].columns).size,exported.result.files['answers.csv'].columns.length);
    assert.equal(field('common').definitions.length,2);
  }finally{await maintenance.close();await writer.close();}
});

test('CSV dates use Beijing time across midnight and preserve milliseconds',()=>{
  assert.equal(exportDateTime(Date.parse('2026-10-15T16:00:00.123Z')),'2026-10-16 00:00:00.123');
  assert.equal(exportDateTime(0),'1970-01-01 08:00:00.000');assert.equal(exportDateTime(null),null);
});

test('failed exports preserve partial files without blocking the next maintenance job',async t=>{
  const f=fixture(t),job=randomUUID(),directory=join(f.root,'research-exports',job);
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,'data.csv'),'partial export',{mode:0o600});
  const writer=new DatabaseWriter(f.path);await writer.start();const maintenance=new Maintenance(writer,f.path,f.root);
  try{
    await writer.request({operation:'lab/internal.job.begin',data:{job_id:job,kind:'EXPORT',study_id:f.study.study_id,config:{study_id:f.study.study_id}}});
    await assert.rejects(maintenance.run('EXPORT',{study_id:f.study.study_id},job),/EEXIST/);
    assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(job).state,'FAILED');
    assert.equal(maintenance.busy,false);
    assert.equal(await readFile(join(directory,'data.csv'),'utf8'),'partial export');
    const exported=await maintenance.run('EXPORT',{study_id:f.study.study_id});
    assert.equal(f.db.prepare('SELECT state FROM lab_jobs WHERE job_id=?').get(exported.job_id).state,'READY');
    assert.equal(f.db.prepare("SELECT value FROM lab_meta WHERE key='resource_barrier'").get().value,'');
  }finally{await maintenance.close();await writer.close();}
});

test('evidence exports over 100 MiB retain all raw rows and verified CSV hashes',async t=>{
  const f=fixture(t),interaction={schema:'interaction-v1',time_origin:1000,samples:[{
    type:'input',at:1,context:{page_id:'welcome'},value:'x'.repeat(120*1024),
  }]};
  for(let i=0;i<230;i++)assert.equal(f.ingest([f.wire('d-ui-large','INPUT_DIAGNOSTIC',{interaction})]).receipts[0].disposition,'ACCEPTED');
  const writer=new DatabaseWriter(f.path);await writer.start();const maintenance=new Maintenance(writer,f.path,f.root);
  try{
    const exported=await maintenance.run('EXPORT',{study_id:f.study.study_id}),manifest=exported.result;
    const total=manifest.bytes+Object.values(manifest.files).reduce((sum,file)=>sum+file.bytes,0);
    assert.ok(total>100*1024*1024);
    assert.equal(manifest.tables.raw,230);assert.equal(manifest.tables.events,230);
    assert.equal(manifest.tables.interaction_actions,230);assert.equal(manifest.files['trajectories.csv'].rows,230);
    assert.equal(manifest.csv_hash,await fileHash(join(f.root,'research-exports',exported.job_id,'data.csv')));
    for(const [name,file]of Object.entries(manifest.files))assert.equal(file.hash,await fileHash(join(f.root,'research-exports',exported.job_id,name)));
    assert.equal(f.db.prepare('SELECT count(*) n FROM lab_raw').get().n,230);
    const light=await maintenance.run('EXPORT',{study_id:f.study.study_id,format:'answers'});
    assert.ok(light.result.files['answers.csv'].bytes<64*1024);
    assert.deepEqual(Object.keys(light.result.files),['answers.csv','preparations.csv']);
    assert.deepEqual((await readdir(join(f.root,'research-exports',light.job_id))).sort(),['answers.csv','manifest.json','preparations.csv']);
  }finally{await maintenance.close();await writer.close();}
});
