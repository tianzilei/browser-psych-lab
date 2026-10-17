import {readdir,lstat,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateRoot} from './private-files.js';
export async function cleanRecordingDownloads(root:string,cutoff=Date.now()-3600000){
  const directory=await privateRoot(join(root,'research-recording-downloads'));let removed=0;
  for(const name of await readdir(directory))if(/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(name)){
    const path=join(directory,name),stat=await lstat(path);
    if(!stat.isSymbolicLink()&&stat.isDirectory()&&stat.mtimeMs<cutoff){await rm(path,{recursive:true});removed++;}
  }
  return {removed,bucket:'research-recording-downloads',cutoff:new Date(cutoff).toISOString()};
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.argv[2]??process.env.STORAGE_ROOT;if(!root)throw new Error('STORAGE_ROOT_REQUIRED');console.log(JSON.stringify(await cleanRecordingDownloads(root)));
}
