import {open,lstat,mkdir,mkdtemp,rename,rm,unlink,realpath} from 'node:fs/promises';
import {dirname,resolve,join,basename} from 'node:path';

async function requireMissing(path){
  try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error('IMAGE_OUTPUT_ALREADY_EXISTS');
}
// One CLI publisher at a time per destination. Only a complete staging tree
// becomes visible; failures preserve existing output and permit a fresh retry.
export async function publishImageOutput(output,write){
  output=resolve(output);await mkdir(dirname(output),{recursive:true});
  const parent=await realpath(dirname(output));output=join(parent,basename(output));
  const lockPath=`${output}.lock`,lock=await open(lockPath,'wx');let staging;
  try{
    await requireMissing(output);
    staging=await mkdtemp(join(parent,`.${basename(output)}.tmp-`));
    await write(staging);await requireMissing(output);
    await rename(staging,output);staging=undefined;
  }finally{
    try{
      if(staging){
        // Validate the exact generated absolute path before recursive cleanup.
        const actual=await realpath(staging);
        if(actual!==staging||dirname(actual)!==parent||!basename(actual).startsWith(`.${basename(output)}.tmp-`))throw new Error('UNSAFE_IMAGE_STAGING_PATH');
        await rm(actual,{recursive:true,force:true});
      }
    }finally{await lock.close();await unlink(lockPath);}
  }
}
