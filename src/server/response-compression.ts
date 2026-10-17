import type {FastifyInstance} from 'fastify';
import {Readable,pipeline} from 'node:stream';
import {createGzip,gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {ContractError} from '../shared/contract.js';
import {runnerEncodings} from './runner-encoding.js';

const zip=promisify(gzip);
export const RESPONSE_COMPRESSION=Object.freeze({threshold_bytes:8*1024,maximum_json_bytes:4*1024*1024,concurrency:2,level:4});

// Compress serialized JSON and streamed CSV; never buffer an export in memory
// or change the stored artifact, its hash, or an image's original bytes.
export function installResponseCompression(app:FastifyInstance) {
  let active=0;
  app.addHook('onSend',async(request,reply,payload)=>{
    if(!/^\/api\/(lab|participate|questionnaires)(\/|$)/.test(request.url)
      || request.url.split('?')[0]!.endsWith('/reanswer') || request.method==='HEAD'
      || reply.statusCode!==200 || reply.hasHeader('Content-Encoding'))return payload;
    const type=String(reply.getHeader('Content-Type')??'').split(';')[0];
    const json=type==='application/json'&&(typeof payload==='string'||Buffer.isBuffer(payload));
    const csv=type==='text/csv'&&payload instanceof Readable;
    if(!json&&!csv)return payload;
    const vary=String(reply.getHeader('Vary')??'').split(',').map(value=>value.trim()).filter(Boolean);
    if(!vary.some(value=>value.toLowerCase()==='accept-encoding')&&!vary.includes('*'))vary.push('Accept-Encoding');
    reply.header('Vary',vary.join(', '));
    const encodings=runnerEncodings(request.headers['accept-encoding']).filter(value=>value!=='br');
    if(!encodings.length){if(csv)(payload as Readable).destroy();throw new ContractError('ENCODING_NOT_ACCEPTABLE',406);}
    if(encodings[0]!=='gzip')return payload;
    const identity=encodings.includes('identity'),bytes=json?Buffer.byteLength(payload as string|Buffer):0;
    if(json&&identity&&(bytes<RESPONSE_COMPRESSION.threshold_bytes||bytes>RESPONSE_COMPRESSION.maximum_json_bytes))return payload;
    if(active>=RESPONSE_COMPRESSION.concurrency||json&&bytes>RESPONSE_COMPRESSION.maximum_json_bytes){
      if(identity)return payload;
      if(csv)(payload as Readable).destroy();
      throw new ContractError('RESPONSE_COMPRESSION_BUSY',503);
    }
    active++;let released=false;
    const release=()=>{if(!released){released=true;active--;}};
    if(json){
      try{
        const body=await zip(payload as string|Buffer,{level:RESPONSE_COMPRESSION.level});
        if(identity&&body.length>=bytes)return payload;
        reply.removeHeader('Content-Length');reply.header('Content-Encoding','gzip');return body;
      }finally{release();}
    }
    const source=payload as Readable,compressed=createGzip({level:RESPONSE_COMPRESSION.level});
    // Pipeline propagates read faults and backpressure. A disconnected client
    // destroys gzip, which also closes the private file and frees this slot.
    compressed.once('end',release);compressed.once('close',release);
    pipeline(source,compressed,()=>release());
    reply.removeHeader('Content-Length');reply.header('Content-Encoding','gzip');return compressed;
  });
}
