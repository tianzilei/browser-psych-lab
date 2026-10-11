import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

test('HTTP crypto fallback hashes only supplied bytes and never fabricates Web Locks',async()=>{
  const source=readFileSync(new URL('../../src/web/compat.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const crypto={getRandomValues:array=>webcrypto.getRandomValues(array)},navigator={};
  const context=vm.createContext({crypto,navigator,ArrayBuffer,Uint8Array,DataView,DOMException});
  vm.runInContext(code,context);
  assert.equal(navigator.locks,undefined);
  assert.match(crypto.randomUUID(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for(const size of [0,3,55,56,63,64,65,1024]){
    const input=Uint8Array.from({length:size+10},(_,i)=>i%251),slice=input.subarray(3,3+size);
    const expected=createHash('sha256').update(slice).digest('hex');
    for(const data of [slice,new DataView(input.buffer,3,size),slice.slice().buffer]){
      const actual=Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
      assert.equal(actual,expected,`length ${size}`);
    }
  }
  await assert.rejects(crypto.subtle.digest('SHA-1',new ArrayBuffer(0)),{name:'NotSupportedError'});
});
