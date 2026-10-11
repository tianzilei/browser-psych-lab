import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from '../helpers/lab-fixture.mjs';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {DatabaseWriter} from '../../src/server/writer.ts';
import {Maintenance} from '../../src/server/maintenance.ts';
import {digest} from '../../src/server/collection-store.ts';
import {fileHash,safeDownload} from '../../src/server/private-files.ts';

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
  const f=fixture(t,protocol),sample={type:'pointerdown',at:12.5,raw_timestamp:12.5,context:{page_id:'page',question_id:'gate'},target:'=target',box:null,x:0,y:2,trusted:true};
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
    const answer=(id,sid=f.created.session_id,axis='')=>answers.find(row=>row.session_id===sid&&row.question_id===id&&row.axis_id===axis);
    assert.equal(answer('score').answer_numeric,'-1');assert.equal(answer('score').scale_label,'低');assert.equal(answer('score').answer_state,'ANSWERED');assert.equal(answer('score').session_state,'COMPLETED');
    assert.equal(answer('note').answer_text,"' =SUM(1,2)");assert.equal(JSON.parse(answer('note').answer_json),' =SUM(1,2)');assert.equal(answer('note').study_title,"'=研究标题");
    assert.deepEqual(JSON.parse(answer('multi').answer_json),['中文,"引号"\n下一行']);
    assert.equal(answer('axes',f.created.session_id,'left').answer_numeric,'0');assert.equal(answer('axes',f.created.session_id,'right').answer_state,'UNANSWERED');assert.equal(answer('axes',f.created.session_id,'right').answer_json,'null');
    assert.equal(answer('optional').answer_state,'UNANSWERED');assert.equal(answer('skipped').answer_state,'SKIPPED');assert.equal(answer('gate',created.session_id).answer_state,'UNCONFIRMED');assert.equal(answer('gate',interrupted.session_id).session_state,'TERMINATED');
    const trajectory=trajectories.find(row=>row.event_id===action.event_id);assert.equal(trajectory.time_origin,'1700000000123.5');assert.equal(trajectory.at,'12.5');assert.equal(trajectory.x,'0');assert.equal(trajectory.target,"'=target");assert.equal(trajectory.disposition,'ACCEPTED');assert.deepEqual(JSON.parse(trajectory.payload_json),sample);
    const rejected=trajectories.find(row=>row.event_id===invalid.event_id);assert.equal(rejected.disposition,'QUARANTINED');assert.equal(rejected.reason,'INVALID_INTERACTION_BATCH');assert.ok(rejected.payload_json.includes('interaction'));
    assert.equal(manifest.files['answers.csv'].rows,answers.length);assert.equal(manifest.files['trajectories.csv'].rows,trajectories.length);
    for(const file of ['answers.csv','trajectories.csv']){assert.equal(manifest.files[file].hash,await fileHash(join(directory,file)));assert.equal(manifest.files[file].bytes,(await readFile(join(directory,file))).length);const opened=await safeDownload(f.root,exported.job_id,file,'research-exports');await opened.close();}
    assert.ok(answers.every(row=>row.snapshot_id===manifest.snapshot_id));assert.ok(trajectories.every(row=>row.snapshot_id===manifest.snapshot_id));assert.equal(manifest.csv_hash,await fileHash(join(directory,'data.csv')));
    assert.ok(!Object.keys(answers[0]).some(key=>key.includes('credential')));assert.ok(!Object.keys(trajectories[0]).some(key=>key.includes('credential')));
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
    const state=(sid,q)=>rows.find(row=>row.session_id===sid&&row.question_id===q).answer_state;
    assert.equal(state(f.created.session_id,'gate'),'ANSWERED');assert.equal(state(f.created.session_id,'hidden_answer'),'SKIPPED');assert.equal(state(f.created.session_id,'future_answer'),'UNCONFIRMED');
    assert.equal(state(created.session_id,'gate'),'UNCONFIRMED');assert.equal(state(created.session_id,'hidden_answer'),'NOT_REACHED');assert.equal(state(created.session_id,'future_answer'),'NOT_REACHED');
  }finally{await maintenance.close();await writer.close();}
});
