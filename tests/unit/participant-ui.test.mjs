import test from 'node:test';
import assert from 'node:assert/strict';
import {pageIntroduction,participantError,isConnectionFailure,interruptionMessage,ui} from '../../src/web/participant-ui.ts';
import {RequestError} from '../../src/web/request-error.ts';

test('display deduplication keeps authored instructions and their exact whitespace',()=>{
  assert.equal(pageIntroduction('项目','项目','请作答。\n\n保留段落。'),'请作答。\n\n保留段落。');
  assert.equal(pageIntroduction('项目',' 作答\n说明 ','作答 说明'),' 作答\n说明 ');
  assert.equal(pageIntroduction('项目','项目',' 项目 '),' 项目 ');
  assert.equal(pageIntroduction('项目','其他','项目'),'其他\n\n项目');
  assert.equal(pageIntroduction('项目','项目',''),'');
  assert.equal(pageIntroduction('项目','说明','说明\n请作答'),'说明\n\n说明\n请作答');
});
test('capacity, expired admission, network failure and storage failure have distinct truthful copy',()=>{
  const full=new RequestError('SESSION_CAPACITY_FULL',409,{limit:2});
  assert.equal(participantError(full),ui.capacity);assert.equal(isConnectionFailure(full),false);
  assert.equal(full.code,'SESSION_CAPACITY_FULL');assert.equal(full.status,409);assert.deepEqual(full.details,{limit:2});
  assert.match(participantError(new RequestError('ADMISSION_EXPIRED',409)),/过期/);
  assert.doesNotMatch(participantError(new RequestError('WRITER_FENCED',409)),/名额/);
  assert.match(participantError(new TypeError('Failed to fetch')),/保存尚未确认/);
  assert.equal(isConnectionFailure(new TypeError('Failed to fetch')),true);
  assert.match(participantError(new DOMException('Full','QuotaExceededError')),/存储空间不足/);
  assert.doesNotMatch(participantError(new DOMException('Full','QuotaExceededError')),/已保存|仍保留/);
  assert.doesNotMatch(participantError(new RequestError('TEST_UNKNOWN_CODE',400)),/TEST_UNKNOWN_CODE/);
  assert.match(participantError(new Error('请联系研究者。')),/请联系研究者/);
});
test('task interruption distinguishes participant idle, connection and rendering problems',()=>{
  assert.match(interruptionMessage('USER_IDLE_TIMEOUT'),/2 分钟/);
  assert.match(interruptionMessage('CONNECTION_TIMEOUT'),/连接/);
  assert.match(interruptionMessage('VISUAL_VIEWPORT_CHANGED'),/显示区域/);
  assert.match(interruptionMessage(new Error('LONG_FRAME')),/显示节奏/);
});
