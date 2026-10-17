import {JSON_TRANSPORT,compressibleJsonPost} from '../shared/transport.js';

const encoder = new TextEncoder();
export async function prepareJsonPost(url:string, json:string) {
  const plain = {body:json as BodyInit, headers:{'Content-Type':'application/json'} as Record<string,string>};
  // Three UTF-8 bytes per UTF-16 code unit is the upper bound, including surrogates.
  if (!compressibleJsonPost(url)
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
