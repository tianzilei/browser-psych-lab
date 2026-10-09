import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compileQuestionnaire} from '../../src/shared/questionnaire-json.ts';
import {sampleProtocol,parseProtocol,pageSnapshot,evaluate,copyAnswer} from '../../src/shared/protocol.ts';
import {fixture} from '../helpers/lab-fixture.mjs';

function source(){return {schema:'questionnaire-v1',title:'多坐标测试',orientation:'portrait',ending:{title:'谢谢',text:'数据已保存。'},pages:[{id:'survey',questions:[
  {id:'feel',type:'scales',title:'当前感受',axes:[{id:'ease',title:'方便',min:-1,labels:['不方便','一般','方便']},{id:'clear',title:'清晰',min:0,labels:['不清晰','一般','清晰']}]},
  {id:'optional',type:'scales',title:'选填',required:false,axes:[{id:'left',title:'左',min:0,labels:['低','中','高']},{id:'right',title:'右',min:0,labels:['低','中','高']}]},
  {id:'follow',type:'single',title:'后续题',choices:['是','否'],condition:{op:'eq',question:'feel',axis:'ease',value:0}}
]}]};}
test('multi-axis JSON, selectors and ending are strict; legacy protocol hashes keep their shape',()=>{
  const input=source(),p=compileQuestionnaire(input);assert.deepEqual(p.ending,input.ending);assert.equal(p.pages[0].questions[0].axes[1].max,2);
  assert.equal(evaluate(p.pages[0].questions[2].condition,{feel:{ease:0,clear:1}}),true);
  assert.equal(evaluate(p.pages[0].questions[2].condition,{feel:{ease:null,clear:1}}),false);
  assert.equal(evaluate({op:'neq',question:'feel',value:0},{feel:{ease:0,clear:1}}),false);
  const legacy=sampleProtocol();assert.deepEqual(parseProtocol(legacy),legacy);assert.equal('ending' in parseProtocol(legacy),false);
  for(const edit of [s=>s.pages[0].questions[0].axes.pop(),s=>s.pages[0].questions[0].axes.push({...s.pages[0].questions[0].axes[0]}),s=>s.pages[0].questions[0].axes[0].max=5,s=>s.pages[0].questions[2].condition.axis='missing',s=>delete s.pages[0].questions[2].condition.axis,s=>s.ending.text='',s=>s.ending.html='<b>x</b>']){
    const invalid=source();edit(invalid);assert.throws(()=>compileQuestionnaire(invalid));
  }
});
test('axis answers preserve zero, require each mandatory dimension and normalize optional missing values',()=>{
  const page=compileQuestionnaire(source()).pages[0],values={feel:{ease:0,clear:1},optional:{left:0},follow:'是'};
  const result=pageSnapshot(page,{},values);assert.deepEqual(result.optional,{state:'ANSWERED',answer:{left:0,right:null}});assert.equal(result.feel.answer.ease,0);
  for(const feel of [{ease:0},{ease:0,clear:1,unknown:1},{ease:0.5,clear:1},{ease:-2,clear:1},[0,1],'0',null])assert.throws(()=>pageSnapshot(page,{}, {...values,feel}));
  const skipped=pageSnapshot(page,{}, {feel:{ease:1,clear:2},optional:null});assert.deepEqual(skipped.optional,{state:'UNANSWERED',answer:{left:null,right:null}});assert.equal(skipped.follow.state,'SKIPPED');
  const copied=copyAnswer(values.feel);values.feel.clear=2;assert.equal(copied.clear,1);
});
test('partial axis revisions persist but final seals require complete mandatory axes',t=>{
  const f=fixture(t,compileQuestionnaire(source()));
  const partial=f.wire('survey','PAGE_REVISION',{question_id:'feel',answer:{ease:0,clear:null}});assert.equal(f.ingest([partial]).receipts[0].disposition,'ACCEPTED');
  const final=f.wire('survey','PAGE_SNAPSHOT',{answers:{feel:{ease:0,clear:2},optional:{left:0},follow:'是'}});assert.equal(f.ingest([final]).receipts[0].disposition,'ACCEPTED');
  const seal=f.seal('survey',[partial,final],['survey']);assert.equal(seal.status,'SEALED');assert.deepEqual(f.call('view').answers.optional,{left:0,right:null});
  assert.equal(f.call('finalize',{request_id:randomUUID(),...f.fence,seal_ids:[seal.seal_id]}).status,'COMPLETED');
  assert.deepEqual(f.call('view').frozen.protocol.ending,{title:'谢谢',text:'数据已保存。'});
});
