import { constants, createReadStream } from 'node:fs';
import { open, mkdir, realpath, lstat, link, unlink, readFile } from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type Readable } from 'node:stream';
import { ContractError, id } from '../shared/contract.js';
export async function syncDirectory(path: string) {const f=await open(path,constants.O_RDONLY);try{await f.sync();}finally{await f.close();}}
export async function privateRoot(path:string) {
  await mkdir(path,{recursive:true,mode:0o700});const target=resolve(path);
  let lexical=target;while(lexical!==parse(lexical).root){const st=await lstat(lexical);if(st.isSymbolicLink()&&st.uid!==0)throw new Error('PRIVATE_STORAGE_SYMLINK');lexical=dirname(lexical);}
  if((await lstat(target)).isSymbolicLink())throw new Error('PRIVATE_STORAGE_SYMLINK');
  const actual=await realpath(target);let current=actual;
  while(current!==parse(current).root){const st=await lstat(current);const trustedSticky=(st.mode&0o1000)&&st.uid===0;
    if(st.isSymbolicLink()||((st.mode&0o022)&&!trustedSticky))throw new Error('UNSAFE_PRIVATE_STORAGE_ANCESTOR');current=dirname(current);}
  return actual;
}
export async function assetPath(root:string,asset:string) {return join(await privateRoot(join(root,'research-assets')),`${id(asset)}.bin`);}
export async function openPrivate(path:string) {
  let ancestor=dirname(resolve(path));while(ancestor!==parse(ancestor).root){const st=await lstat(ancestor);if(st.isSymbolicLink()&&st.uid!==0)throw new Error('PRIVATE_FILE_ANCESTOR_SYMLINK');ancestor=dirname(ancestor);}
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await f.stat();
  if(!st.isFile()){await f.close();throw new Error('NOT_A_PRIVATE_FILE');}return f;
}
export async function fileHash(path:string) {const f=await openPrivate(path);try{const h=createHash('sha256');for await(const chunk of f.createReadStream({autoClose:false}))h.update(chunk);return h.digest('hex');}finally{await f.close();}}
export async function writeDurable(path:string,bytes:string|Uint8Array) {
  const f=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}await syncDirectory(dirname(path));
}
export async function receiveUpload(root:string,asset:string,body:Readable) {
  const directory=await privateRoot(join(root,'research-assets','.tmp'));const path=join(directory,`${id(asset)}-${randomUUID()}`);
  const f=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let bytes=0;
  try{for await(const chunk of body){bytes+=chunk.length;if(bytes>8*1024*1024)throw new ContractError('UPLOAD_TOO_LARGE',413);await f.writeFile(chunk);}await f.sync();}
  catch(error){await f.close();await unlink(path).catch(()=>{});throw error;}
  await f.close();await syncDirectory(directory);return {path,bytes};
}
export async function publishExclusive(temp:string,destination:string) {
  const h=await fileHash(temp);
  try{await link(temp,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await fileHash(destination)!==h)throw error;}
  await syncDirectory(dirname(destination));await unlink(temp);await syncDirectory(dirname(temp));return h;
}
export async function safeDownload(root:string,job:string,file:string,bucket:string) {
  if(!['research-exports','research-backups'].includes(bucket)||!['data.csv','manifest.json','database.sqlite'].includes(file))throw new ContractError('INVALID_DOWNLOAD_OBJECT');
  const directory=await privateRoot(join(root,bucket,id(job)));return openPrivate(join(directory,file));
}
export const fileBytes = readFile;
export const streamFile = createReadStream;
