import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ContractError, LIMITS, PROTOCOL, CONTRACT_VERSION, id, object } from '../shared/contract.js';
import { digest, type Command } from './collection-store.js';
import { DatabaseWriter } from './writer.js';

export async function collectionRoutes(app: FastifyInstance, writer: DatabaseWriter) {
  const origins = new Set(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).origin] : []);
  const originFor = (request: FastifyRequest) => `${request.protocol}://${request.host}`;
  const receiving = new Map<string, number>(); let receivingBytes = 0;
  const release = (request: FastifyRequest) => {
    const charged = receiving.get(request.id);
    if (charged !== undefined) { receivingBytes -= charged; receiving.delete(request.id); }
  };
  app.addHook('onResponse', async request => { release(request); });
  app.addHook('onRequestAbort', async request => { release(request); });
  app.get('/api/p0/protocol', async () => ({ mode: 'TEST_ONLY', contract_version: CONTRACT_VERSION,
    protocol: PROTOCOL, protocol_hash: digest(JSON.stringify(PROTOCOL)), limits: LIMITS }));
  // Admission occurs before body parsing; parser buffers cannot bypass the RPC bound.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/p0/') || request.method === 'GET') return;
    const origin = request.headers.origin;
    if (!origin || (origins.size ? !origins.has(origin) : origin !== originFor(request)))
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', ingestion: 'NOT_INGESTED' });
    if (!request.headers['content-type']?.startsWith('application/json'))
      return reply.code(415).send({ code: 'JSON_REQUIRED', ingestion: 'NOT_INGESTED' });
    const bulk = request.routeOptions.url?.endsWith('/ingest') ?? false;
    const max = LIMITS.queue_requests - (bulk ? LIMITS.control_reserve : 0);
    const byteLimit = Math.floor(LIMITS.queue_bytes * max / LIMITS.queue_requests);
    // Chunked bodies reserve the entire bounded body allowance; JSON parse/clone is charged twice.
    const length = request.headers['content-length'] ? Number(request.headers['content-length']) : LIMITS.request_bytes;
    if (!Number.isSafeInteger(length) || length < 0 || length > LIMITS.request_bytes)
      return reply.code(413).send({ code: 'REQUEST_TOO_LARGE', ingestion: 'NOT_INGESTED' });
    const charge = length * 2 + 1024;
    if (receiving.size >= max || receivingBytes + charge > byteLimit)
      return reply.header('Retry-After', '1').code(503).send({ code: 'RECEIVE_QUEUE_FULL', ingestion: 'NOT_INGESTED' });
    receiving.set(request.id, charge); receivingBytes += charge;
  });
  app.post('/api/p0/sessions', { bodyLimit: 1024 }, async (request, reply) => {
    const d = object(request.body); id(d.request_id);
    if (typeof d.credential !== 'string' || !/^[a-f0-9]{64}$/.test(d.credential)) throw new ContractError('INVALID_CREDENTIAL');
    const view = object(await writer.request({ operation: 'create', data: { request_id: d.request_id, credential_hash: digest(d.credential) } }));
    const sid = id(view.session_id);
    reply.header('Set-Cookie', `p0_${sid}=${d.credential}; Path=/api/p0/sessions/${sid}; HttpOnly; SameSite=Strict${
      (process.env.PUBLIC_ORIGIN ?? originFor(request)).startsWith('https:') ? '; Secure' : ''}`);
    return view;
  });
  const command = (request: FastifyRequest, operation: string, data: Record<string, unknown>): Command => {
    const sid = id((request.params as { session: string }).session);
    const prefix = `p0_${sid}=`;
    const credential = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(prefix))?.slice(prefix.length);
    if (!credential || !/^[a-f0-9]{64}$/.test(credential)) throw new ContractError('UNAUTHORIZED', 401);
    return { operation, session_id: sid, credential_hash: digest(credential), data };
  };
  app.get('/api/p0/sessions/:session', async request => writer.request(command(request, 'view', {})));
  for (const operation of ['claim', 'release', 'permit', 'ingest', 'receipts', 'seal', 'finalize', 'terminate', 'reconcile']) {
    app.post(`/api/p0/sessions/:session/${operation}`, { bodyLimit: LIMITS.request_bytes }, async request =>
      writer.request(command(request, operation, object(request.body)), operation !== 'ingest'));
  }
}
