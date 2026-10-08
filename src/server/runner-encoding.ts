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
