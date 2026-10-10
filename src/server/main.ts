import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { DatabaseWriter, WriterError } from './writer.js';
import { collectionRoutes } from './collection-routes.js';
import { ContractError } from '../shared/contract.js';
import { labRoutes } from './lab-routes.js';
import { Maintenance } from './maintenance.js';
import { privateRoot } from './private-files.js';
import { retainRelease } from './release.js';
import { access,readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!process.env.DATABASE_PATH) throw new Error('Run npm run setup or configure DATABASE_PATH.');
const tlsKey=process.env.TLS_KEY_PATH,tlsCert=process.env.TLS_CERT_PATH;
if(!!tlsKey!==!!tlsCert)throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must be configured together.');
const tls=tlsKey&&tlsCert?{key:await readFile(tlsKey),cert:await readFile(tlsCert)}:undefined;

const storageRoot = await privateRoot(resolve(process.env.STORAGE_ROOT ?? './var'));
for(const bucket of ['research-assets','research-exports','research-backups']) await privateRoot(resolve(storageRoot,bucket));
const runnerHash = await retainRelease(storageRoot);
const sessionConcurrency=Number(process.env.SESSION_CONCURRENCY??2);
if(!Number.isSafeInteger(sessionConcurrency)||sessionConcurrency<1||sessionConcurrency>10000)throw new Error('INVALID_SESSION_CONCURRENCY');
const writer = new DatabaseWriter(resolve(process.env.DATABASE_PATH),{workerData:{runnerHash,sessionConcurrency}});
await writer.start();
export const app = Fastify({
  ...(tls?{https:tls}:{}),
  trustProxy:'127.0.0.1',
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  },
  logController: new LogController({ disableRequestLogging: true }),
});
const maintenance = new Maintenance(writer,resolve(process.env.DATABASE_PATH),storageRoot);
app.setErrorHandler((error, _request, reply) => {
  const known = error instanceof ContractError || error instanceof WriterError;
  const status = known ? error.status : ((error as { statusCode?: number }).statusCode ?? 500);
  if (status === 503) reply.header('Retry-After', '1');
  if (known && ['SESSION_CAPACITY_FULL','PREPARATION_CAPACITY_FULL'].includes(error.code)) reply.header('Retry-After','1800');
  return reply.code(status).send({ code: known ? error.code : 'REQUEST_FAILED',
    ingestion: error instanceof WriterError ? error.ingestion : 'NOT_INGESTED',
    details: known ? error.details : null });
});
app.addHook('onRequest', async (request, reply) => {
  const frameAncestors=request.url.split('?')[0]==='/simulate.html'?"'self'":"'none'";
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'`);
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});
app.addHook('onResponse', async (request, reply) => {
  if (reply.statusCode >= 400) {
    // No raw URL, cookies or submitted data. Durable business audit belongs in DB.
    app.log.warn({ requestId: request.id, statusCode: reply.statusCode }, 'HTTP request failed');
  }
});

app.get('/api/health/live', async () => ({ status: 'ok', mode: 'TEST_ONLY' }));
app.get('/api/health/ready', async (_request, reply) => {
  try {
    const result = await writer.request({ operation: 'health', data: {} }) as { version: string };
    for (const bucket of ['research-assets', 'research-exports', 'research-backups']) {
      await access(resolve(storageRoot, bucket));
    }
    return { status: 'ok', mode: 'TEST_ONLY', database: `SQLite ${result.version}`, storage: 'ready' };
  } catch {
    reply.code(503);
    return { status: 'unavailable', mode: 'TEST_ONLY' };
  }
});

// Only Vite output is public; research storage has no static route.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, {
    root: webRoot,
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply, path) {
      const assetPath = relative(webRoot, path).replaceAll('\\', '/');
      reply.header('Cache-Control', assetPath.startsWith('assets/')
        ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}
await collectionRoutes(app, writer);
await labRoutes(app,writer,maintenance,storageRoot);
app.addHook('onClose', async () => { await maintenance.close(); await writer.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}
try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) }); }
catch (error) { await app.close(); throw error; }
