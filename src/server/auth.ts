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
