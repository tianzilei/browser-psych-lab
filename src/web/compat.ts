// Compatibility layer for local HTTP testing on iOS browsers. Production HTTPS
// deployments continue to use the native Web Crypto and Web Locks APIs.
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sha256(data: ArrayBuffer): ArrayBuffer {
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const input=new Uint8Array(data), bit=input.length*8, len=((input.length+9+63)>>6)<<6, bytes=new Uint8Array(len);bytes.set(input);bytes[input.length]=128;
  const view=new DataView(bytes.buffer);view.setUint32(len-4,bit>>>0);view.setUint32(len-8,Math.floor(bit/0x100000000));
  let a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  const ro=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for(let off=0;off<len;off+=64){const w=new Uint32Array(64);for(let i=0;i<16;i++)w[i]=view.getUint32(off+i*4);for(let i=16;i<64;i++){const s0=ro(w[i-15]!,7)^ro(w[i-15]!,18)^(w[i-15]!>>>3),s1=ro(w[i-2]!,17)^ro(w[i-2]!,19)^(w[i-2]!>>>10);w[i]=(w[i-16]!+s0+w[i-7]!+s1)>>>0;}let A=a,B=b,C=c,D=d,E=e,F=f,G=g,H=h;for(let i=0;i<64;i++){const S1=ro(E,6)^ro(E,11)^ro(E,25),ch=(E&F)^(~E&G),t1=(H+S1+ch+k[i]!+w[i]!)>>>0,S0=ro(A,2)^ro(A,13)^ro(A,22),maj=(A&B)^(A&C)^(B&C),t2=(S0+maj)>>>0;H=G;G=F;F=E;E=(D+t1)>>>0;D=C;C=B;B=A;A=(t1+t2)>>>0;}a=(a+A)>>>0;b=(b+B)>>>0;c=(c+C)>>>0;d=(d+D)>>>0;e=(e+E)>>>0;f=(f+F)>>>0;g=(g+G)>>>0;h=(h+H)>>>0;}
  const out=new ArrayBuffer(32),o=new DataView(out);[a,b,c,d,e,f,g,h].forEach((v,i)=>o.setUint32(i*4,v));return out;
}
if (!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:uuid, configurable:true});
if (!crypto.subtle) {
  const digest = async (_algorithm: string, data: BufferSource) => {
    const name = typeof _algorithm === 'string' ? _algorithm : (_algorithm as Algorithm).name;
    if (name.toUpperCase() !== 'SHA-256') throw new DOMException('Only SHA-256 is supported.', 'NotSupportedError');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return sha256(bytes.slice().buffer);
  };
  Object.defineProperty(crypto, 'subtle', { value: { digest }, configurable: true });
}
// Web Locks cannot be emulated by granting every caller a lock. The participant
// entry points require the native API; LAN testing must use the HTTPS preview.
