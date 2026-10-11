全项目设计讨论，传输段 12，源码主题：数据库、RPC、认证及准入（源包 4/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    if(this.pinned(sid))throw new ContractError('RUN_LOCKED',409);
    this.db.prepare("UPDATE lab_session_queue SET status='LEFT',lease_until=0 WHERE session_id=?").run(sid);this.sweep();return {status:'LEFT' as const};
  }
  ended(sid:string){this.db.prepare("UPDATE lab_session_queue SET status='ENDED',lease_until=0 WHERE session_id=?").run(sid);this.sweep();}
  stats(){this.sweep();const rows=this.db.prepare("SELECT status,count(*) AS n FROM lab_session_queue WHERE status IN ('ACTIVE','QUEUED') GROUP BY status").all() as {status:string;n:number}[];
    const active=rows.find(r=>r.status==='ACTIVE')?.n??0;const limitedActive=this.entries('ACTIVE').length;return {active,unlimited_active:active-limitedActive,limited_active:limitedActive,queued:0,limit:this.limit,capacity:this.limit,over_limit:Math.max(0,limitedActive-this.limit),pinned:(this.db.prepare("SELECT count(*) AS n FROM lab_session_queue q WHERE q.status='ACTIVE' AND EXISTS(SELECT 1 FROM lab_permits p WHERE p.session_id=q.session_id AND p.state='ISSUED')").get() as {n:number}).n};}
}

```

### src/server/auth.ts L1–L25

```
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ContractError } from '../shared/contract.js';
const derive=promisify(scrypt);
export async function passwordHash(password:string) {
  if(password.length<12||password.length>256)throw new Error('Password must contain 12–256 characters.');
  const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password:string,stored:string|undefined) {
  if(!stored||!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)||password.length>256)return false;
  const [,salt,key]=stored.split(':');const actual=await derive(password,salt!,64) as Buffer;return timingSafeEqual(actual,Buffer.from(key!,'hex'));
}
export class RateLimits {
  private buckets=new Map<string,{tokens:number;time:number}>();
  constructor(private cap=2000){}
  take(key:string,burst:number,perSecond:number) {
    const now=Date.now();
    for(const [k,v]of this.buckets)if(now-v.time>300000)this.buckets.delete(k);
    if(!this.buckets.has(key)&&this.buckets.size>=this.cap)throw new ContractError('RATE_LIMIT_CAPACITY',503);
    const b=this.buckets.get(key)??{tokens:burst,time:now};b.tokens=Math.min(burst,b.tokens+(now-b.time)/1000*perSecond);b.time=now;
    this.buckets.set(key,b);if(b.tokens<1)throw new ContractError('RATE_LIMITED',429);b.tokens--;
  }
}

```