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
