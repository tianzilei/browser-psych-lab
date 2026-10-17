// Optional wire encoding. Stored event bytes and SHA-256 identities stay unchanged.
export const JSON_TRANSPORT = Object.freeze({
  threshold_bytes: 8 * 1024,
  maximum_ratio: 0.875,
  maximum_bytes: 1024 * 1024,
  decompression_concurrency: 4,
  stream_reserve_bytes: 128 * 1024,
  receive_timeout_ms: 15_000,
});

// Match URL paths in the browser and Fastify's route templates on the server.
// Binary image/ZIP uploads and authentication remain separate transports.
export function compressibleJsonPost(path:string) {
  return /^\/api\/participate\/sessions\/[^/]+\/(ingest|covariates|seal|reconcile|receipts)$/.test(path)
    || /^\/api\/lab\/studies\/[^/]+\/(save|import)$/.test(path);
}
