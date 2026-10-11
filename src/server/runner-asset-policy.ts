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
