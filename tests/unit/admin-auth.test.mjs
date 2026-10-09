import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {LabStore} from '../../src/server/lab-store.ts';
import {labRoutes} from '../../src/server/lab-routes.ts';
import {passwordHash} from '../../src/server/auth.ts';
import {digest} from '../../src/server/collection-store.ts';
import {ContractError} from '../../src/shared/contract.ts';

test('legacy role tokens migrate once with millisecond expiry and unified permissions',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());let now=1700000000000;
  db.exec("CREATE TABLE lab_admin_tokens(token_hash TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('researcher','maintainer')),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT");
  const records=['researcher','maintainer'].map(role=>({token:digest(role),csrf:randomUUID(),expiry:now+60000}));
  for(const [i,record] of records.entries())db.prepare('INSERT INTO lab_admin_tokens VALUES (?,?,?,?)').run(record.token,['researcher','maintainer'][i],record.csrf,record.expiry);
  db.prepare('INSERT INTO lab_admin_tokens VALUES (?,?,?,?)').run(digest('expired'),'maintainer',randomUUID(),now-1);
  const store=new LabStore(db,digest('runner'),()=>now);
  assert.deepEqual(db.pragma('table_info(lab_admin_tokens)').map(column=>column.name),['token_hash','csrf','expires_at']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lab_admin_tokens').get().n,2);
  for(const record of records){
    const call=(op,data={})=>store.execute({operation:`lab/${op}`,credential_hash:record.token,data});
    assert.deepEqual(call('admin.me'),{authenticated:true,csrf:record.csrf});
    assert.throws(()=>call('gate.close',{request_id:randomUUID()}),/CSRF_REJECTED/);
    assert.deepEqual(call('gate.close',{request_id:randomUUID(),csrf:record.csrf}),{status:'CLOSED'});
    assert.equal(db.prepare('SELECT expires_at FROM lab_admin_tokens WHERE token_hash=?').get(record.token).expires_at,record.expiry);
  }
  new LabStore(db,digest('runner'),()=>now);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lab_admin_tokens').get().n,2);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  now+=60001;
  assert.throws(()=>store.execute({operation:'lab/admin.me',credential_hash:records[0].token,data:{}}),/LOGIN_REQUIRED/);
});

test('password-only HTTP login keeps cookie, Origin, CSRF, logout and login limits',async t=>{
  const origin='http://localhost',savedOrigin=process.env.PUBLIC_ORIGIN,savedHash=process.env.ADMIN_PASSWORD_HASH;
  process.env.PUBLIC_ORIGIN=origin;process.env.ADMIN_PASSWORD_HASH=await passwordHash('TEST_ONLY-unified-password');
  t.after(()=>{for(const [key,value] of [['PUBLIC_ORIGIN',savedOrigin],['ADMIN_PASSWORD_HASH',savedHash]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const db=new Database(':memory:'),store=new LabStore(db),app=Fastify();
  t.after(async()=>{await app.close();db.close();});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ContractError?error.status:500).send({code:error.code??'FAILED'}));
  await labRoutes(app,{request:async command=>store.execute(command)},{path:'/unused',busy:false},'/unused');
  const login=payload=>app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload});
  assert.equal((await app.inject({url:'/api/auth/me'})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'http://foreign'},payload:{password:'TEST_ONLY-unified-password'}})).statusCode,403);
  assert.equal((await login({})).statusCode,400);
  assert.equal((await login({password:'TEST_ONLY-unified-password',role:'researcher'})).statusCode,400);
  assert.equal((await login({password:'wrong-password'})).statusCode,401);
  const success=await login({password:'TEST_ONLY-unified-password'});assert.equal(success.statusCode,200);
  const {authenticated,csrf}=success.json();assert.equal(authenticated,true);assert.ok(csrf);assert.equal('role' in success.json(),false);
  const setCookie=success.headers['set-cookie'];assert.match(setCookie,/HttpOnly; SameSite=Strict; Path=\/api; Max-Age=28800/);
  const cookie=setCookie.split(';')[0],headers={origin,cookie,'x-csrf-token':csrf};
  assert.deepEqual((await app.inject({url:'/api/auth/me',headers:{cookie}})).json(),{authenticated:true,csrf});
  assert.equal((await app.inject({method:'POST',url:'/api/lab/collection-gate/close',headers:{origin,cookie},payload:{request_id:randomUUID()}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/lab/collection-gate/close',headers,payload:{request_id:randomUUID()}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/auth/logout',headers:{origin,cookie},payload:{}})).statusCode,403);
  const logout=await app.inject({method:'POST',url:'/api/auth/logout',headers,payload:{}});assert.equal(logout.statusCode,200);assert.match(logout.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie}})).statusCode,401);
  assert.equal((await login({password:'wrong-password'})).statusCode,401);
  assert.equal((await login({password:'TEST_ONLY-unified-password'})).statusCode,429);
});
