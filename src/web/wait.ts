export function wait(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});}
export function overloadDelay(response:Response,attempt:number){
  const header=response.headers.get('Retry-After'),seconds=header===null?NaN:Number(header);
  return (Number.isFinite(seconds)&&seconds>=0?Math.min(5000,Math.max(250,seconds*1000)):Math.min(5000,250*2**attempt))+Math.random()*250;
}
