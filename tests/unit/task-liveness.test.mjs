import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskLiveness} from '../../src/web/task-liveness.ts';
function setup(t,online=true){
  const target=new EventTarget(),prior=globalThis.document;globalThis.document=target;t.after(()=>{globalThis.document=prior;});
  let now=0,calls=0;const errors=[];t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(!online)throw new Error('offline');return new Response('{"status":"ACTIVE"}');});
  const stop=taskLiveness({path:()=>'/activity',fence:()=>({writer_id:'test',writer_epoch:1})},e=>errors.push(e));t.after(stop);
  return {errors,activity:()=>{const e=new Event('pointerdown');Object.defineProperty(e,'isTrusted',{value:true});target.dispatchEvent(e);},tick:async ms=>{now+=ms;t.mock.timers.tick(ms);await new Promise(r=>setImmediate(r));},calls:()=>calls,stop};
}
test('idle limit interrupts after two minutes; one tiny renewal per minute and cleanup stops timers',async t=>{
  const f=setup(t);await f.tick(60000);assert.equal(f.calls(),1);assert.deepEqual(f.errors,[]);await f.tick(60000);assert(f.errors.includes('USER_IDLE_TIMEOUT'));f.stop();const before=f.calls();await f.tick(60000);assert.equal(f.calls(),before);
});
test('active disconnected task tolerates short loss and interrupts after five minutes',async t=>{
  const f=setup(t,false);for(let i=0;i<4;i++){f.activity();await f.tick(60000);assert.deepEqual(f.errors,[]);}f.activity();await f.tick(60000);assert(f.errors.includes('CONNECTION_TIMEOUT'));assert.equal(f.calls(),5);
});
