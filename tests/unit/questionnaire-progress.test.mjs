import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverQuestionnaireProgress} from '../../src/shared/questionnaire-progress.ts';
import {questionnaireCapacity,requireQuestionnaireEditCapacity,QUESTIONNAIRE_CAPACITY} from '../../src/shared/questionnaire-capacity.ts';
const first={id:'first',title:'',instruction:'',questions:[
  {id:'a',type:'single',title:'A',required:true,choices:['yes','no']},
  {id:'h',type:'single',title:'H',required:true,choices:['foo','bar'],condition:{op:'eq',question:'a',value:'yes'}}
]};
const pages=[first,{id:'branch',title:'',instruction:'',condition:{op:'eq',question:'h',value:'foo'},questions:[{id:'b',type:'single',title:'B',required:true,choices:['yes','no']}]},
  {id:'last',title:'',instruction:'',questions:[{id:'c',type:'single',title:'C',required:true,choices:['yes','no']}]}];
const local={page_values:{first:{a:'no',h:'foo'},last:{c:'yes'}},pending:{first:{manifest:{scope:'first',path:['first']}}}};
test('pending snapshot recovery normalizes hidden values, skips conditions, preserves raw drafts and canonical path',()=>{
  const original=JSON.stringify(local),r=recoverQuestionnaireProgress(pages,{answers:{},path:[],page_index:0},local);
  assert.deepEqual(r,{answers:{a:'no',h:null,b:null},path:['first'],page_index:2});assert.equal(JSON.stringify(local),original);
});
test('sealed server answers take precedence over all old local values and lost local seal acknowledgements',()=>{
  assert.deepEqual(recoverQuestionnaireProgress(pages,{answers:{a:'no',h:null,b:null},path:['first'],page_index:2},local),
    {answers:{a:'no',h:null,b:null},path:['first'],page_index:2});
});
test('recovery rejects contradictory pending paths without rewriting raw state',()=>{
  const corrupt=structuredClone(local);corrupt.pending.first.manifest.path=['wrong','first'];const bytes=JSON.stringify(corrupt);
  assert.throws(()=>recoverQuestionnaireProgress(pages,{answers:{},path:[],page_index:0},corrupt),/LOCAL_QUESTIONNAIRE_PATH_CONFLICT/);assert.equal(JSON.stringify(corrupt),bytes);
  corrupt.pending.first.manifest.path=['first'];corrupt.pending.branch={manifest:{scope:'branch',path:['first','branch']}};
  assert.throws(()=>recoverQuestionnaireProgress(pages,{answers:{},path:[],page_index:0},corrupt),/LOCAL_QUESTIONNAIRE_PATH_CONFLICT/);
});
test('revision capacity reserves the final snapshot at count and exact UTF-8 byte boundaries',()=>{
  const limit=QUESTIONNAIRE_CAPACITY;
  assert.equal(questionnaireCapacity({events:4500,bytes:0}).warning,true);
  assert.doesNotThrow(()=>requireQuestionnaireEditCapacity({events:4998,bytes:0},1000));
  assert.throws(()=>requireQuestionnaireEditCapacity({events:4999,bytes:0},1000),/LOCAL_QUESTIONNAIRE_EDIT_LIMIT/);
  const usage={events:100,bytes:limit.maximum_bytes-limit.event_bytes-1000};
  assert.doesNotThrow(()=>requireQuestionnaireEditCapacity(usage,1000));assert.throws(()=>requireQuestionnaireEditCapacity(usage,1001),/LOCAL_QUESTIONNAIRE_EDIT_LIMIT/);
  assert.equal(questionnaireCapacity({events:4999,bytes:0}).readonly,true);
});
