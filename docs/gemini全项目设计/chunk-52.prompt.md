全项目设计讨论，传输段 52，源码主题：运维工具和部署（源包 16/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    if (!/^[a-zA-Z0-9._-]+$/.test(repo.name) || !/^[0-9a-f]{40}$/.test(repo.commit)) {
      throw new Error('Invalid locked identity');
    }
    const cwd = resolve(base, repo.name);
    await mkdir(cwd, { recursive: true });
    try { await access(resolve(cwd, '.git')); } catch {
      await run('git', ['init', '--quiet', cwd]);
      await run('git', ['remote', 'add', 'origin', repo.url], { cwd });
    }
    const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim();
    if (remote !== repo.url) throw new Error('Unexpected remote; directory left untouched');
    const changes = (await run('git', ['status', '--porcelain'], { cwd })).stdout.trim();
    if (changes) throw new Error('Local changes; directory left untouched');
    let current;
    try { current = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(); } catch {}
    if (current && current !== repo.commit) throw new Error('Different checkout; directory left untouched');
    if (!current) {
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--depth=1', 'origin', repo.commit],
        { cwd, timeout: 180000, maxBuffer: 1024 * 1024 });
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', repo.commit], { cwd });
    }
    const actual = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (actual !== repo.commit) throw new Error('Commit verification failed');
    for (const license of repo.licenses ?? []) {
      const bytes = await readFile(resolve(cwd, license.path));
      if (createHash('sha256').update(bytes).digest('hex') !== license.sha256) {
        throw new Error('License evidence mismatch');
      }
    }
    console.log(`${repo.name}: ${actual.slice(0, 12)} ready`);
  } catch (error) {
    console.error(`${repo.name}: fetch/verification failed (${error.code ?? 'check failed'}). Rerun to retry.`);
    failed = true;
  }
}
for (const file of manifest.files ?? []) {
  const bytes = await readFile(resolve(root, 'references', file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    console.error(`${file.path}: digest mismatch`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;

```

### scripts/release.mjs L1–L23

```
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './lib.mjs';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
const hash=b=>createHash('sha256').update(b).digest('hex');const files=[];
// The transport contract participates in canonical runner identity. Old frozen
// archives without this file retain their original asset request contract.
await writeFile(join(root,'dist/web/runner-contract.json'),JSON.stringify({schema:'runner-assets-v1',preparation_queue:true,session_admission:true,task_activity:'idle120-offline300-v1'})+'\n');
async function scan(directory,prefix=''){for(const name of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,name.name),key=prefix?`${prefix}/${name.name}`:name.name;
 if(name.isDirectory())await scan(path,key);else if(!/\.(br|gz)$/.test(key))files.push({path:key,hash:hash(await readFile(path))});}}
await scan(join(root,'dist/web'));const runnerHash=hash(JSON.stringify(files));
const representations=[];
for(const file of files){if(!/^assets\/.*\.(js|css)$/.test(file.path))continue;
  const original=await readFile(join(root,'dist/web',file.path));
  for(const [encoding,extension,decode] of [['br','br',brotliDecompressSync],['gzip','gz',gunzipSync]]){
    const path=`${file.path}.${extension}`,bytes=await readFile(join(root,'dist/web',path));
    if(hash(decode(bytes,{maxOutputLength:original.length}))!==file.hash)throw new Error('INVALID_COMPRESSED_BUILD');
    representations.push({path,encoding,hash:hash(bytes),original:file.path,original_bytes:original.length});
  }
}
await writeFile(join(root,'dist/release.json'),JSON.stringify({runnerHash,runnerVersion:'canvas-v1',files,representations},null,2)+'\n');

```