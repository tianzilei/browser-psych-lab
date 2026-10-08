// Preparation only. One original image at a time; no HTTP work enters the trial loop.
import {wait,overloadDelay} from './wait.js';
export const DOWNLOAD_POLICY = Object.freeze({
  stall_ms: 60_000,
  minimum_ms: 60_000,
  maximum_ms: 20 * 60_000,
  // A planning allowance, not an assertion about the connection's guaranteed speed.
  bytes_per_second: 3 * 1024,
});
export function downloadBudget(bytes: number) {
  return Math.min(DOWNLOAD_POLICY.maximum_ms, Math.max(DOWNLOAD_POLICY.minimum_ms,
    Math.ceil(bytes / DOWNLOAD_POLICY.bytes_per_second * 1000) + DOWNLOAD_POLICY.stall_ms));
}
export async function downloadOriginal(url: string, expectedBytes: number, signal: AbortSignal,
  progress: (bytes: number) => void, policy = {stall_ms: DOWNLOAD_POLICY.stall_ms, total_ms: downloadBudget(expectedBytes)}, headers:Record<string,string>={}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 8 * 1024 * 1024)
    throw new Error('图片字节预算无效。');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const total = setTimeout(() => controller.abort(new Error('图片下载超过准备预算，请重试或联系研究者。')), policy.total_ms);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('图片传输停滞，请检查网络后重试。')), policy.stall_ms);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    activity(); // Includes the time spent waiting for response headers.
    let response:Response;
    for(let attempt=0;;attempt++){
      activity();response=await fetch(url,{cache:'no-store',signal:controller.signal,headers});
      if((response.status!==503&&response.status!==429)||attempt>=7)break;
      await response.body?.cancel();await wait(overloadDelay(response,attempt),controller.signal);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`图片下载失败 (${response.status})，可重试准备。`); }
    if (!response.body) throw new Error('浏览器不支持流式图片下载。');
    reader = response.body.getReader();
    // Allocate once from the trusted frozen size; avoid a chunk list plus another full copy.
    const bytes = new Uint8Array(expectedBytes);
    let received = 0;
    for (;;) {
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      if (received + part.value.byteLength > expectedBytes) throw new Error('图片字节数超出清单。');
      bytes.set(part.value, received); received += part.value.byteLength;
      activity(); progress(received);
    }
    if (received !== expectedBytes) throw new Error('图片未完整下载。');
    return bytes;
  } catch (error) {
    controller.abort(error);
    await reader?.cancel().catch(() => {});
    throw controller.signal.reason ?? error;
  } finally {
    clearTimeout(total); clearTimeout(idle);
    signal.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}
