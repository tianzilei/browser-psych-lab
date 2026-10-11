本轮设计落地后请做静态挑战，勿搜索、勿声称运行验证。先纠正上一条意见：项目没有“硬实时”；media queries不能严格区分触控板/鼠标；一次clock三值不能证明漂移/跨设备精确对齐。pointer/hover/colorDepth/timeOrigin已经原有。环境记录不是consent表。原生API可只做timeout竞速，AbortSignal不能取消多数浏览器API。IDB行添加可选byte_length/hash不改变对象仓库和索引，也不需要schema升级；旧行fallback，外发仍只raw/hash/event_id。接收保留decoded*2以覆盖JSON字符串/parse/clone，不采用decoded单份的预算降低；128KiB额外流预算+全局最多4个gzip、15sec接收deadline，原32/20MiB预算仍生效。

环境扩展：browserState同步snapshot、locale、只读clock、windowouter/screenxy、API支持、navigation数值阶段和paint，不含全URL；10个权限状态 query并行各250ms，只读query不触发任何获取权限/读取传感器；unsupported/blocked/timeout区分。第一次同意后一次环境采样，后续生命周期事件才状态采样。无设备枚举、外站、视频/字体/Audio指纹或连续轮询。

interaction仍v1额外可选字段：coalesced每派发只调用一次读一次box/context并保留逐样本坐标/pressure/tilt/twist/contact/modifiers；keyboardrepeat/location/composition、beforeinput/inputdata、compositionupdate、wheel、copy/cut/paste类型(不读clipboard)。root事件普通非move/wheel的快照请求同microtask合并，显式page/stimulus screen仍同步，稀疏focus/blur/visibility/resize/fullscreen/orientation立即状态+screen，高频scroll只snapshot可RAF合并且capture标记；状态事件均保留不去重。flush100ms/64/90KB，raw128KB、队列64保持；stop补待拍screen并flush，drain包含以前未完成save不另建无界串行队列。pagehide最努力不能承诺落盘。1900节点cap显式nodes_truncated。当前有限逐题页面实际远小于cap。

传输源码:
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
      if (error) {reply.header('Connection','close');payload.resume();}
    });
    payload.pipe(wire);
    return output;
  });
  app.addHook('onError',async request => release(request));
  app.addHook('onResponse',async request => release(request));
  app.addHook('onRequestAbort',async request => release(request));
  app.addHook('onClose',async () => {for (const request of active.keys()) release(request);});
}
import {JSON_TRANSPORT} from '../shared/transport.js';

const encoder = new TextEncoder();
export async function prepareJsonPost(url:string, json:string) {
  const plain = {body:json as BodyInit, headers:{'Content-Type':'application/json'} as Record<string,string>};
  // Three UTF-8 bytes per UTF-16 code unit is the upper bound, including surrogates.
  if (!/^\/api\/participate\/sessions\/[^/]+\/(ingest|covariates)$/.test(url)
      || typeof CompressionStream === 'undefined' || json.length * 3 < JSON_TRANSPORT.threshold_bytes) return plain;
  const bytes = encoder.encode(json);
  if (bytes.length < JSON_TRANSPORT.threshold_bytes || bytes.length > JSON_TRANSPORT.maximum_bytes) return plain;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const body = await new Response(stream).arrayBuffer();
    if (body.byteLength > bytes.length * JSON_TRANSPORT.maximum_ratio) return plain;
    return {body, headers:{...plain.headers, 'Content-Encoding':'gzip', 'X-Uncompressed-Length':String(bytes.length)}};
  } catch {
    // Compression is an optimization; local raw records remain the retry authority.
    return plain;
  }
}
// Optional wire encoding. Stored event bytes and SHA-256 identities stay unchanged.
export const JSON_TRANSPORT = Object.freeze({
  threshold_bytes: 8 * 1024,
  maximum_ratio: 0.875,
  maximum_bytes: 1024 * 1024,
  decompression_concurrency: 4,
  stream_reserve_bytes: 128 * 1024,
  receive_timeout_ms: 15_000,
});


native gzip corruption/length/abort/4 decoder cap/timeout/overload identical-buffer tests7项已过，真实浏览器100coalesced样本每次1rect读取已过主体，Float32压力断言现已按原生返回值精确比较。完整check进行中。请报告具体可靠性/兼容性/开销问题，确认预算头不可信仍被流式实测硬限限制、bodyparser不会在gzip完整性检查前提交。
