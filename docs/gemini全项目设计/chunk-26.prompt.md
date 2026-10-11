全项目设计讨论，传输段 26，源码主题：图片包及冻结发行（源包 9/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    if(names.has(key))throw new Error('DUPLICATE_IMAGE_PATH');names.add(key);
    if(image.path.split('/').some(part=>/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||part.endsWith('.')))throw new Error('NON_PORTABLE_IMAGE_PATH');
    const info=imageInfo(image.bytes),ext=image.path.split('.').at(-1)!.toLowerCase();
    if(info.format!==({png:'png',webp:'webp',jpg:'jpeg',jpeg:'jpeg'} as Record<string,string>)[ext])throw new Error('IMAGE_EXTENSION_MISMATCH');
    total+=image.bytes.length;if(total>32*1024*1024)throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
    const name=Buffer.from(image.path),crc=crc32(image.bytes),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
    header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(image.bytes.length,18);
    header.writeUInt32LE(image.bytes.length,22);header.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);
    directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);
    directory.writeUInt32LE(image.bytes.length,20);directory.writeUInt32LE(image.bytes.length,24);
    directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,name,image.bytes);central.push(directory,name);offset+=header.length+name.length+image.bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(images.length,8);end.writeUInt16LE(images.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  if(offset+directory.length+end.length>8*1024*1024)throw new Error('ZIP_SIZE_EXCEEDED');
  return Buffer.concat([...local,directory,end]);
}

```

### src/server/release.ts L1–L54

```
import {readFile,mkdir,copyFile,link,unlink,chmod} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {gunzip,brotliDecompress} from 'node:zlib';
import {digest} from './collection-store.js';
import {privateRoot,fileHash,syncDirectory,writeDurable,openPrivate} from './private-files.js';
interface ReleaseFile {path:string;hash:string}
interface Representation extends ReleaseFile {encoding:'gzip'|'br';original:string;original_bytes:number}
interface Release {runnerHash:string;runnerVersion:string;files:ReleaseFile[];representations?:Representation[]}
const safePath=(path:string)=>typeof path==='string'&&/^[a-zA-Z0-9._/-]+$/.test(path)&&!path.split('/').some(x=>x==='..'||!x);
const gz=promisify(gunzip),br=promisify(brotliDecompress);
async function retainFile(source:string,target:string,hash:string){
  try{if(await fileHash(target)!==hash)throw new Error('RETAINED_ARTIFACT_HASH_MISMATCH');return;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(dirname(target),{recursive:true,mode:0o700});const temp=join(dirname(target),`.tmp-${randomUUID()}`);
  try{
    await copyFile(source,temp);await chmod(temp,0o600);const copied=await openPrivate(temp);try{try{await copied.sync();}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}finally{await copied.close();}
    if(await fileHash(temp)!==hash)throw new Error('COPIED_ARTIFACT_HASH_MISMATCH');
    try{await link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await fileHash(target)!==hash)throw error;}
  }finally{await unlink(temp).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
  await syncDirectory(dirname(target));
}
export async function retainRelease(root:string,distOverride?:string) {
  const dist=distOverride??fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../dist/':'../',import.meta.url));let release:Release;
  try{release=JSON.parse(await readFile(join(dist,'release.json'),'utf8')) as Release;}
  catch(error){if(process.env.NODE_ENV==='production')throw error;return digest('TEST_ONLY-development');}
  if(!/^[a-f0-9]{64}$/.test(release.runnerHash)||!Array.isArray(release.files)||release.files.length>500||digest(JSON.stringify(release.files))!==release.runnerHash)throw new Error('INVALID_RELEASE_MANIFEST');
  const destination=await privateRoot(join(root,'research-assets','runners',release.runnerHash)),originals=new Map<string,string>();
  for(const file of release.files){if(!safePath(file.path)||originals.has(file.path)||!/^[a-f0-9]{64}$/.test(file.hash))throw new Error('INVALID_RELEASE_PATH');originals.set(file.path,file.hash);
    const source=join(dist,'web',file.path);if(await fileHash(source)!==file.hash)throw new Error('BUILD_ARTIFACT_HASH_MISMATCH');
    await retainFile(source,join(destination,file.path),file.hash);
  }
  if(release.representations!==undefined){
    if(!Array.isArray(release.representations)||release.representations.length>1000)throw new Error('INVALID_RELEASE_REPRESENTATIONS');
    const paths=new Set<string>();
    for(const variant of release.representations){
      const suffix=variant.encoding==='br'?'br':variant.encoding==='gzip'?'gz':null;
      if(!suffix||!safePath(variant.path)||variant.path!==`${variant.original}.${suffix}`||!/^assets\/.*\.(js|css)$/.test(variant.original)||!originals.has(variant.original)||paths.has(variant.path)||!Number.isSafeInteger(variant.original_bytes)||variant.original_bytes<1||variant.original_bytes>16*1024*1024)throw new Error('INVALID_RELEASE_REPRESENTATION');paths.add(variant.path);
      const source=join(dist,'web',variant.path),compressed=await readFile(source);
      if(digest(compressed)!==variant.hash)throw new Error('COMPRESSED_ARTIFACT_HASH_MISMATCH');
      const decoded=await (variant.encoding==='br'?br:gz)(compressed,{maxOutputLength:variant.original_bytes});
      if(decoded.length!==variant.original_bytes||digest(decoded)!==originals.get(variant.original))throw new Error('COMPRESSED_ARTIFACT_CONTENT_MISMATCH');
      await retainFile(source,join(destination,variant.path),variant.hash);
    }
  }
  const manifest=join(destination,'release.json'),serialized=JSON.stringify(release);
  try{await writeDurable(manifest,serialized);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(await fileHash(manifest)!==digest(serialized))throw new Error('RETAINED_MANIFEST_MISMATCH');}
  return release.runnerHash;
}

```

### src/server/runner-asset-policy.ts L1–L40

```
import {join} from 'node:path';
import {digest} from './collection-store.js';
import {openPrivate} from './private-files.js';
import {ContractError} from '../shared/contract.js';
type AssetPolicy='legacy'|'ticket';
export class RunnerAssetPolicy {
  private cache=new Map<string,AssetPolicy>();
  private pending=new Map<string,Promise<AssetPolicy>>();
  private activity=new Set<string>();
  constructor(private root:string){}
  private async read(path:string,maxBytes:number){
    const file=await openPrivate(path);
    try{if((await file.stat()).size>maxBytes)throw new Error('RUNNER_POLICY_BUDGET_EXCEEDED');return await file.readFile();}
    finally{await file.close();}
  }
  async get(hash:string){
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('INVALID_RUNNER_IDENTITY');
    const cached=this.cache.get(hash);if(cached){this.cache.delete(hash);this.cache.set(hash,cached);return cached;}
    const pending=this.pending.get(hash);if(pending)return pending;
    if(this.pending.size>=16)throw new ContractError('RUNNER_POLICY_BUSY',503);
    const load=this.load(hash);this.pending.set(hash,load);
    try{return await load;}finally{this.pending.delete(hash);}
  }
  private async load(hash:string):Promise<AssetPolicy>{
    const directory=join(this.root,'research-assets','runners',hash);
    const release=JSON.parse((await this.read(join(directory,'release.json'),256*1024)).toString()) as {runnerHash:string;files:{path:string;hash:string}[]};
    if(release.runnerHash!==hash||!Array.isArray(release.files)||release.files.length>500||digest(JSON.stringify(release.files))!==hash)throw new Error('RUNNER_POLICY_IDENTITY_MISMATCH');
    const contracts=release.files.filter(f=>f.path==='runner-contract.json');if(contracts.length>1)throw new Error('INVALID_RUNNER_CONTRACT');
    let policy:AssetPolicy='legacy';
    if(contracts.length){const bytes=await this.read(join(directory,'runner-contract.json'),1024);
      if(digest(bytes)!==contracts[0]!.hash)throw new Error('RUNNER_CONTRACT_HASH_MISMATCH');
      const contract=JSON.parse(bytes.toString()) as {schema:string;preparation_queue:boolean;task_activity?:string};
      if(contract.schema!=='runner-assets-v1'||contract.preparation_queue!==true)throw new Error('UNSUPPORTED_RUNNER_CONTRACT');policy='ticket';
      if(contract.task_activity==='idle120-offline300-v1')this.activity.add(hash);
    }
    if(this.cache.size>=64){const evicted=this.cache.keys().next().value!;this.cache.delete(evicted);this.activity.delete(evicted);}this.cache.set(hash,policy);return policy;
  }
  async requiresActivity(hash:string){await this.get(hash);return this.activity.has(hash);}
}

```

### src/server/runner-encoding.ts L1–L17

```
// Explicit q=0 overrides wildcard acceptance. Invalid weights are refused.
export function runnerEncodings(header: string | undefined): ('br'|'gzip'|'identity')[] {
  if (!header?.trim()) return ['identity'];
  const weights=new Map<string,number>();
  for(const item of header.split(',')){
    const [name,...parameters]=item.trim().toLowerCase().split(';'),coding=name!.trim();
    if(!['br','gzip','identity','*'].includes(coding))continue;
    let q=1;
    for(const parameter of parameters){const pair=parameter.trim().split('=');if(pair[0]!=='q')continue;
      q=/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(pair[1]??'')?Number(pair[1]):0;
    }
    weights.set(coding,Math.min(weights.get(coding)??1,q));
  }
  const quality=(coding:string)=>weights.get(coding)??(coding==='identity'?(weights.get('*')===0?0:1):(weights.get('*')??0));
  return (['br','gzip','identity'] as const).filter(c=>quality(c)>0).sort((a,b)=>quality(b)-quality(a));
}

```