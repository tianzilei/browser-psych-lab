import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {digest} from '../../src/server/collection-store.ts';
import {retainRelease} from '../../src/server/release.ts';
import {runnerEncodings} from '../../src/server/runner-encoding.ts';
import {RunnerAssetPolicy} from '../../src/server/runner-asset-policy.ts';
test('runner content negotiation honors q, wildcard, identity and refusal',()=>{
  assert.deepEqual(runnerEncodings(undefined),['identity']);
  assert.deepEqual(runnerEncodings('gzip, br'),['br','gzip','identity']);
  assert.deepEqual(runnerEncodings('br;q=0, gzip;q=1, *;q=0'),['gzip']);
  assert.deepEqual(runnerEncodings('gzip;q=0.5, identity;q=0'),['gzip']);
  assert.deepEqual(runnerEncodings('br;q=0, gzip;q=0, identity;q=0'),[]);
  assert.deepEqual(runnerEncodings('br;q=invalid, *;q=0'),[]);
  assert.deepEqual(runnerEncodings('br;q=0, br;q=1'),['identity']);
});
test('archived representations match canonical code and restart skips existing disk writes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-runner-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dist=join(root,'dist');await mkdir(join(dist,'web/assets'),{recursive:true,mode:0o700});
  const original=Buffer.from('console.log("immutable code");'.repeat(100)),path='assets/run.js';
  const files=[{path,hash:digest(original)}],runnerHash=digest(JSON.stringify(files)),representations=[];
  await writeFile(join(dist,'web',path),original);
  for(const [encoding,extension,encode] of [['gzip','gz',gzipSync],['br','br',brotliCompressSync]]){
    const bytes=encode(original);await writeFile(join(dist,'web',`${path}.${extension}`),bytes);
    representations.push({path:`${path}.${extension}`,encoding,hash:digest(bytes),original:path,original_bytes:original.length});
  }
  const release={runnerHash,runnerVersion:'canvas-v1',files,representations};await writeFile(join(dist,'release.json'),JSON.stringify(release));
  assert.equal(await retainRelease(root,dist),runnerHash);const archived=join(root,'research-assets/runners',runnerHash,path),before=await stat(archived);
  if(process.platform!=='win32'){assert.equal(before.mode&0o777,0o600);for(const ext of ['gz','br'])assert.equal((await stat(`${archived}.${ext}`)).mode&0o777,0o600);}
  assert.equal(await new RunnerAssetPolicy(root).get(runnerHash),'legacy');
  await retainRelease(root,dist);assert.equal((await stat(archived)).mtimeMs,before.mtimeMs);
  assert.equal((await readFile(`${archived}.gz`)).length,(await readFile(join(dist,'web',`${path}.gz`))).length);
  const bad=gzipSync('different code');await writeFile(join(dist,'web',`${path}.gz`),bad);release.representations[0].hash=digest(bad);await writeFile(join(dist,'release.json'),JSON.stringify(release));
  await assert.rejects(retainRelease(root,dist),/CONTENT_MISMATCH/);
  // Older releases lacking representations remain valid and use identity.
  const old={runnerHash,runnerVersion:'canvas-v1',files};await writeFile(join(dist,'release.json'),JSON.stringify(old));
  assert.equal(await retainRelease(join(root,'older'),dist),runnerHash);
});
test('runner capability is canonical, bounded and rejects corrupt or unsupported declarations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dist=join(root,'dist');await mkdir(join(dist,'web'),{recursive:true,mode:0o700});
  async function archive(contract){const bytes=JSON.stringify(contract),files=[{path:'runner-contract.json',hash:digest(bytes)}],runnerHash=digest(JSON.stringify(files));
    await writeFile(join(dist,'web/runner-contract.json'),bytes);await writeFile(join(dist,'release.json'),JSON.stringify({runnerHash,runnerVersion:'canvas-v1',files}));await retainRelease(root,dist);return runnerHash;}
  const hash=await archive({schema:'runner-assets-v1',preparation_queue:true});assert.equal(await new RunnerAssetPolicy(root).get(hash),'ticket');
  const unsupported=await archive({schema:'future-schema',preparation_queue:true});await assert.rejects(new RunnerAssetPolicy(root).get(unsupported),/UNSUPPORTED/);
  await writeFile(join(root,'research-assets/runners',hash,'runner-contract.json'),'tampered');await assert.rejects(new RunnerAssetPolicy(root).get(hash),/HASH_MISMATCH/);
  await assert.rejects(new RunnerAssetPolicy(root).get('../unsafe'),/INVALID_RUNNER/);
});
test('concurrent policy reads share validated I/O and failed reads can retry',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=JSON.stringify({schema:'runner-assets-v1',preparation_queue:true}),files=[{path:'runner-contract.json',hash:digest(bytes)}],hash=digest(JSON.stringify(files));
  const directory=join(root,'research-assets/runners',hash);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'release.json'),JSON.stringify({runnerHash:hash,files}));await writeFile(join(directory,'runner-contract.json'),'corrupt');
  const policy=new RunnerAssetPolicy(root),read=policy.read.bind(policy);let reads=0;
  t.mock.method(policy,'read',async(...args)=>{reads++;return read(...args);});
  const failed=await Promise.allSettled(Array.from({length:20},()=>policy.get(hash)));
  assert.equal(reads,2);assert.ok(failed.every(r=>r.status==='rejected'&&/HASH_MISMATCH/.test(r.reason.message)));
  await writeFile(join(directory,'runner-contract.json'),bytes);
  assert.deepEqual(await Promise.all(Array.from({length:20},()=>policy.get(hash))),Array(20).fill('ticket'));assert.equal(reads,4);
  assert.equal(await policy.get(hash),'ticket');assert.equal(reads,4);
});
test('distinct runner policy loads have a finite budget without blocking shared reads',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bpl-policy-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const hashes=[];for(let i=0;i<17;i++){
    const files=[{path:`legacy-${i}.js`,hash:digest(String(i))}],hash=digest(JSON.stringify(files));hashes.push(hash);
    const directory=join(root,'research-assets/runners',hash);await mkdir(directory,{recursive:true});await writeFile(join(directory,'release.json'),JSON.stringify({runnerHash:hash,files}));
  }
  const policy=new RunnerAssetPolicy(root),read=policy.read.bind(policy);let resume;
  const gate=new Promise(resolve=>{resume=resolve;});t.mock.method(policy,'read',async(...args)=>{await gate;return read(...args);});
  const pending=hashes.slice(0,16).map(hash=>policy.get(hash)),shared=policy.get(hashes[0]);
  await assert.rejects(policy.get(hashes[16]),error=>error.status===503&&error.code==='RUNNER_POLICY_BUSY');
  resume();assert.deepEqual(await Promise.all([...pending,shared]),Array(17).fill('legacy'));assert.equal(await policy.get(hashes[16]),'legacy');
});
