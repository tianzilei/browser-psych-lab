import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {crc32} from 'node:zlib';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {compileQuestionnaire,parseQuestionnaireText,questionnaireTemplate} from '../../src/shared/questionnaire-json.ts';
import {pageSnapshot,inputMatchRegex,parseProtocol,sampleProtocol,stableJSON} from '../../src/shared/protocol.ts';
import {unpackImages,imageInfo} from '../../src/server/image-package.ts';
import {LabStore} from '../../src/server/lab-store.ts';
import {digest} from '../../src/server/collection-store.ts';
test('human readable JSON is strict, compiles labels and image references, forbids ordinary text',()=>{
  const input=questionnaireTemplate(),p=compileQuestionnaire(input);assert.equal(p.layout.orientation,'portrait');assert.deepEqual(p.pages[0].questions[0].labels,input.pages[0].questions[0].labels);assert.equal(p.pages[0].questions[0].min_label,'非常不方便');
  assert.throws(()=>parseQuestionnaireText('{oops'),/语法错误/);assert.throws(()=>compileQuestionnaire({...input,extra:true}),/UNKNOWN_QUESTIONNAIRE_FIELD/);assert.throws(()=>compileQuestionnaire({...input,orientation:undefined}),/ORIENTATION_REQUIRED/);
  const q=input.pages[0].questions.find(q=>q.type==='text');delete q.input_purpose;assert.throws(()=>compileQuestionnaire(input),/PERSONAL_INPUT_ONLY/);
});
test('interaction capture is a strict optional boolean in both JSON schemas and preserves legacy protocol identity',()=>{
  const input=questionnaireTemplate();assert.equal(input.record_interactions,true);
  for(const enabled of [false,true]){
    const p=compileQuestionnaire({...input,record_interactions:enabled});assert.equal(p.record_interactions,enabled);
    assert.equal(compileQuestionnaire(p).record_interactions,enabled);
    assert.equal(parseProtocol(p).record_interactions,enabled);
  }
  for(const invalid of [null,'false','true',0,1,[],{}]){
    assert.throws(()=>compileQuestionnaire({...input,record_interactions:invalid}),/INVALID_RECORD_INTERACTIONS/);
    assert.throws(()=>parseProtocol({...sampleProtocol(),record_interactions:invalid}),/INVALID_RECORD_INTERACTIONS/);
  }
  delete input.record_interactions;assert.equal(Object.hasOwn(compileQuestionnaire(input),'record_interactions'),false);
  const legacy=sampleProtocol();assert.equal(Object.hasOwn(parseProtocol(legacy),'record_interactions'),false);
  assert.equal(digest(stableJSON(parseProtocol(legacy))),'371acc28e396d74e303b930228a8a18fef008ab93eeca3ba0168f928208b9029');
});
test('interaction switches are isolated by questionnaire and frozen version',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());const store=new LabStore(db),token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const call=(op,data={})=>store.execute({operation:`lab/${op}`,credential_hash:token,data:{...data,csrf}});
  const a=call('study.create',{request_id:randomUUID()}),b=call('study.create',{request_id:randomUUID()});
  const publish=(study,revision,enabled)=>call('study.import',{request_id:randomUUID(),study_id:study.study_id,revision,source:JSON.stringify({...questionnaireTemplate(),record_interactions:enabled})}).frozen;
  const disabled=publish(a,1,false),enabled=publish(b,1,true),replacement=publish(a,2,true);
  assert.equal(store.frozen(disabled.version_id).protocol.record_interactions,false);assert.equal(store.frozen(disabled.version_id).hash,disabled.hash);
  assert.equal(store.frozen(enabled.version_id).protocol.record_interactions,true);assert.equal(store.frozen(enabled.version_id).hash,enabled.hash);
  assert.equal(replacement.protocol.record_interactions,true);assert.notEqual(replacement.hash,disabled.hash);
});
test('adaptive sources automatically chunk long sections, retain IDs/order/conditions and preserve omitted legacy hashes',()=>{
  const input=questionnaireTemplate();input.pages=[{id:'long',title:input.title,instruction:'只读一次说明。',questions:Array.from({length:190},(_,i)=>({
    id:`q${i}`,type:'scale',title:`题目${i}`,labels:['低','2','3','4','高']
  }))}];input.questionnaire_layout='adaptive';
  const p=compileQuestionnaire(input);
  assert.equal(p.questionnaire_layout,'adaptive');assert.deepEqual(p.pages.map(page=>page.questions.length),[30,30,30,30,30,30,10]);
  assert.deepEqual(p.pages.flatMap(page=>page.questions.map(q=>q.id)),input.pages[0].questions.map(q=>q.id));
  assert.equal(p.pages[0].instruction,'只读一次说明。');assert.ok(p.pages.slice(1).every(page=>page.title===''&&page.instruction===''));
  assert.equal(stableJSON(parseProtocol(p)),stableJSON(p));
  input.pages[0].questions[31].condition={op:'eq',question:'q29',value:5};
  assert.deepEqual(compileQuestionnaire(input).pages[1].questions[1].condition,input.pages[0].questions[31].condition);
  for(const invalid of [null,false,0,{},['adaptive'],'auto'])assert.throws(()=>compileQuestionnaire({...questionnaireTemplate(),questionnaire_layout:invalid}),/INVALID_QUESTIONNAIRE_LAYOUT/);
  assert.throws(()=>compileQuestionnaire({...input,questionnaire_layout:'single'}),/INVALID_PROTOCOL_LIST/);
  input.pages[0].questions=Array.from({length:901},(_,i)=>({...input.pages[0].questions[0],id:`q${i}`}));
  assert.throws(()=>compileQuestionnaire(input),/INVALID_PROTOCOL_LIST/);
  const legacy=sampleProtocol();assert.equal(Object.hasOwn(parseProtocol(legacy),'questionnaire_layout'),false);
  assert.equal(digest(stableJSON(parseProtocol(legacy))),'371acc28e396d74e303b930228a8a18fef008ab93eeca3ba0168f928208b9029');
  const auto=compileQuestionnaire({...questionnaireTemplate(),questionnaire_layout:'adaptive',orientation:'auto'});
  assert.equal(auto.layout.orientation,undefined);assert.equal(auto.groups.length,0);
  assert.throws(()=>compileQuestionnaire({...questionnaireTemplate(),orientation:'auto'}),/ORIENTATION_REQUIRED/);
});
test('text input matching is strict, bounded and enforced in final snapshots',()=>{
  const input=questionnaireTemplate();
  const q=input.pages[0].questions.find(q=>q.type==='text');
  q.input_match={kind:'preset',preset:'alphanumeric',message:'请输入字母和数字。'};
  const p=compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[q]}]}), text=p.pages[0].questions[0];
  assert.equal(inputMatchRegex(text.input_match).test('ABC123'),true);
  assert.equal(inputMatchRegex(text.input_match).test('ABC-123'),false);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'(a+)+$'}}]}]}),/UNSAFE_INPUT_MATCH/);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'(a|aa)+'}}]}]}),/UNSAFE_INPUT_MATCH/);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'[A-Z]{1,}'}}]}]}),/UNSAFE_INPUT_MATCH/);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'[A-Z]{1,4}[0-9]{1,4}'}}]}]}),/UNSAFE_INPUT_MATCH/);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'[A-Z]+'}}]}]}),/UNSAFE_INPUT_MATCH/);
  assert.throws(()=>compileQuestionnaire({...input,pages:[{...input.pages[0],questions:[{...q,input_match:{kind:'regex',pattern:'[a-z]+',flags:'m'}}]}]}),/INVALID_INPUT_MATCH/);
  assert.throws(()=>pageSnapshot(p.pages[0],{}, {[q.id]:'ABC-123'}),/INVALID_ANSWER/);
  assert.doesNotThrow(()=>pageSnapshot(p.pages[0],{}, {[q.id]:'ABC123'}));
});
test('automatic segment IDs validate suffix length without truncating or colliding, including the 30-segment boundary',()=>{
  const input={...questionnaireTemplate(),questionnaire_layout:'adaptive',orientation:'auto',pages:[{id:'x'.repeat(92),questions:Array.from({length:900},(_,i)=>({
    id:`q${i}`,type:'scale',title:'评分',labels:['低','高']
  }))}]};
  const p=compileQuestionnaire(input);assert.equal(p.pages.length,30);assert.equal(p.pages.at(-1).id.length,100);
  const previous=JSON.stringify(input);input.pages[0].id='x'.repeat(93);
  assert.throws(()=>compileQuestionnaire(input),error=>error.code==='QUESTIONNAIRE_SEGMENT_ID_TOO_LONG'&&error.details.maximum_source_id_length===92);
  assert.equal(input.pages[0].id,'x'.repeat(93));input.pages[0].id='x'.repeat(92);assert.equal(JSON.stringify(input),previous);
  input.pages[0].questions=input.pages[0].questions.slice(0,31);input.pages[0].id='x'.repeat(93);assert.equal(compileQuestionnaire(input).pages[0].id.length,100);
});
test('ZIP produced by Python preserves bytes; rejects traversal, duplicate, forged CRC, symlink and pixel bombs',async t=>{
  const png=await readFile('examples/stimuli/mobile-card.png'),zip=await readFile('examples/stimuli/mobile-stimuli.zip');const images=unpackImages(zip);assert.equal(images[0].path,'images/mobile-card.png');assert.deepEqual(images[0].bytes,png);assert.deepEqual(imageInfo(png),{width:1080,height:720,format:'png',validation:'container-header-v1'});
  const root=await mkdtemp(join(tmpdir(),'bpl-zip-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const create=(kind)=>{const path=join(root,`${kind}.zip`);execFileSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['-c',`import zipfile,sys\nb= open(sys.argv[3],'rb').read()\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nname='../bad.png' if sys.argv[2]=='traversal' else 'good.png'\ninfo=zipfile.ZipInfo(name)\nif sys.argv[2]=='symlink': info.create_system=3; info.external_attr=0o120777<<16\nz.writestr(info,b)\nif sys.argv[2]=='duplicate': z.writestr(info,b)\nz.close()`,path,kind,'examples/stimuli/mobile-card.png'],{stdio:'pipe'});return path;};
  for(const kind of ['traversal','duplicate','symlink'])assert.throws(()=>unpackImages(readFileSync(create(kind))),/INVALID_IMAGE_PATH|DUPLICATE|UNSUPPORTED_ZIP_ENTRY/);
  const forged=Buffer.from(zip),central=forged.indexOf(Buffer.from([80,75,1,2]));forged.writeUInt32LE(0,central+16);forged.writeUInt32LE(0,14);assert.throws(()=>unpackImages(forged),/ZIP_CRC/);
  const bomb=Buffer.from(png);bomb.writeUInt32BE(10000,16);bomb.writeUInt32BE(crc32(bomb.subarray(12,29)),29);assert.throws(()=>imageInfo(bomb),/IMAGE_PIXEL_BUDGET_EXCEEDED/);
  for(const format of ['jpeg','webp']){const bytes=await sharp(png)[format]().toBuffer();assert.equal(imageInfo(bytes).format,format);assert.equal(imageInfo(bytes).width,1080);}
  assert.throws(()=>imageInfo(png.subarray(0,40)),/TRUNCATED_PNG/);assert.throws(()=>unpackImages(zip.subarray(0,zip.length-8)),/STANDARD_ZIP_REQUIRED/);
});
test('JSON import freezes new versions atomically and management deletion is forbidden',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());const store=new LabStore(db),token=digest('admin'),csrf=randomUUID();store.execute({operation:'lab/admin.issue',data:{token_hash:token,csrf}});
  const call=(op,data={})=>store.execute({operation:`lab/${op}`,credential_hash:token,data:{...data,csrf}}),s=call('study.create',{request_id:randomUUID()}),source=JSON.stringify(questionnaireTemplate());
  const v=call('study.import',{request_id:randomUUID(),study_id:s.study_id,revision:1,source});assert.equal(v.revision,2);const original=v.frozen.hash;
  assert.throws(()=>call('study.import',{request_id:randomUUID(),study_id:s.study_id,revision:2,source:'{'}),/语法错误/);assert.equal(call('study.get',{study_id:s.study_id}).revision,2);
  const next=questionnaireTemplate();next.background='#202020';call('study.import',{request_id:randomUUID(),study_id:s.study_id,revision:2,source:JSON.stringify(next)});assert.equal(store.frozen(v.frozen.version_id).hash,original);
  assert.throws(()=>call('study.delete',{request_id:randomUUID(),study_id:s.study_id}),error=>error.code==='QUESTIONNAIRE_DELETION_DISABLED'&&error.status===403);assert.equal(call('study.list').studies.length,1);assert.equal(call('study.get',{study_id:s.study_id}).versions.length,2);assert.equal(db.prepare('SELECT count(*) n FROM lab_archived_studies').get().n,0);
});
