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
    await copyFile(source,temp);await chmod(temp,0o600);const copied=await openPrivate(temp);try{await copied.sync();}finally{await copied.close();}
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
