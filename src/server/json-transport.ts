import type {FastifyInstance,FastifyRequest} from 'fastify';
import {Transform,pipeline} from 'node:stream';
import {createGunzip} from 'node:zlib';
import {ContractError} from '../shared/contract.js';
import {JSON_TRANSPORT} from '../shared/transport.js';

function decodedLength(request:FastifyRequest) {
  const value = request.headers['x-uncompressed-length'];
  if (typeof value !== 'string' || !/^[1-9]\d{0,6}$/.test(value)) throw new ContractError('INVALID_DECODED_LENGTH',400);
  const length = Number(value);
  if (length > JSON_TRANSPORT.maximum_bytes) throw new ContractError('REQUEST_TOO_LARGE',413);
  return length;
}

// Called by receive admission before allocating a decompressor or JSON parser.
export function jsonReceiveCharge(request:FastifyRequest, wireBytes:number) {
  return request.headers['content-encoding'] === 'gzip'
    ? decodedLength(request) * 2 + wireBytes + JSON_TRANSPORT.stream_reserve_bytes + 1024
    : wireBytes * 2 + 1024;
}

export function installJsonTransport(app:FastifyInstance) {
  const active = new Map<FastifyRequest,()=>void>();
  const release = (request:FastifyRequest) => {active.get(request)?.();active.delete(request);};
  app.addHook('onRequest',async request => {
    if (!request.url.startsWith('/api/')) return;
    const encoding = request.headers['content-encoding'];
    if (encoding === undefined || encoding === 'identity') return;
    if (encoding !== 'gzip' || request.method !== 'POST'
        || !/^\/api\/participate\/sessions\/:session\/(ingest|covariates)$/.test(request.routeOptions.url ?? ''))
      throw new ContractError('UNSUPPORTED_CONTENT_ENCODING',415);
    decodedLength(request);
    if (active.size >= JSON_TRANSPORT.decompression_concurrency) throw new ContractError('RECEIVE_QUEUE_FULL',503);
    active.set(request,()=>{});
  });
  app.addHook('preParsing',async (request,reply,payload) => {
    if (!active.has(request)) return payload;
    const limit = decodedLength(request);
    let encodedBytes = 0, decodedBytes = 0;
    const output = new Transform({
      transform(chunk:Buffer,_encoding,done) {
        decodedBytes += chunk.length;
        done(decodedBytes > limit ? new ContractError('DECOMPRESSED_LIMIT_EXCEEDED',413) : null,chunk);
      },
      flush(done) {done(decodedBytes !== limit ? new ContractError('DECOMPRESSED_LENGTH_MISMATCH',400) : null);},
    }) as Transform & {receivedEncodedLength:number};
    output.receivedEncodedLength = 0;
    const wire = new Transform({transform(chunk:Buffer,_encoding,done) {
      encodedBytes += chunk.length;output.receivedEncodedLength = encodedBytes;
      done(encodedBytes > JSON_TRANSPORT.maximum_bytes ? new ContractError('REQUEST_TOO_LARGE',413) : null,chunk);
    }});
    const gunzip = createGunzip();
    const timeout=setTimeout(()=>output.destroy(new ContractError('REQUEST_BODY_TIMEOUT',408)),JSON_TRANSPORT.receive_timeout_ms);
    output.once('end',()=>clearTimeout(timeout));
    // zlib reports malformed/truncated streams and gzip's CRC32 failure as 400.
    gunzip.on('error',() => {
      if (!output.destroyed) output.destroy(new ContractError('INVALID_GZIP',400));
    });
    const sourceError = (error:Error) => wire.destroy(error);
    payload.on('error',sourceError);
    const abort = () => release(request);
    request.raw.once('aborted',abort);
    reply.raw.once('close',abort);
    active.set(request,() => {
      clearTimeout(timeout);
      payload.unpipe(wire);payload.removeListener('error',sourceError);
      request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);
      wire.destroy();gunzip.destroy();output.destroy();
    });
    // Keep the HTTP socket outside pipeline: parser errors can still send a 4xx.
    pipeline(wire,gunzip,output,error => {
      payload.unpipe(wire);
      if (error) {
        reply.header('Connection','close');payload.pause();
        // Write the error response before closing an unfinished upload. Do not drain it without a bound.
        const discard=()=>{if (!request.raw.complete) request.raw.destroy();};
        if (reply.raw.writableFinished) discard();else reply.raw.once('finish',discard);
      }
    });
    payload.pipe(wire);
    return output;
  });
  app.addHook('onError',async request => release(request));
  app.addHook('onResponse',async request => release(request));
  app.addHook('onRequestAbort',async request => release(request));
  app.addHook('onClose',async () => {for (const request of active.keys()) release(request);});
}
