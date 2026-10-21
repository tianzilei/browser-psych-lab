import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {fixture} from '../helpers/lab-fixture.mjs';
import {labRoutes} from '../../src/server/lab-routes.ts';
import {passwordHash} from '../../src/server/auth.ts';
import {ContractError} from '../../src/shared/contract.ts';

test('a failed upload body marks the job and asset failed instead of wedging maintenance',async t=>{
  const origin='http://localhost',savedOrigin=process.env.PUBLIC_ORIGIN,savedHash=process.env.ADMIN_PASSWORD_HASH,password='TEST_ONLY-upload-recovery';
  process.env.PUBLIC_ORIGIN=origin;process.env.ADMIN_PASSWORD_HASH=await passwordHash(password);
  const root=mkdtempSync(join(tmpdir(),'bpl-upload-recovery-')),f=fixture({after(){}}),app=Fastify();
  t.after(async()=>{await app.close();f.db.close();rmSync(root,{recursive:true,force:true});rmSync(f.root,{recursive:true,force:true});
    if(savedOrigin===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=savedOrigin;
    if(savedHash===undefined)delete process.env.ADMIN_PASSWORD_HASH;else process.env.ADMIN_PASSWORD_HASH=savedHash;});
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ContractError?error.status:500).send({code:error.code??'FAILED'}));
  await labRoutes(app,{request:async command=>f.store.execute(command)},{path:'/unused',busy:false},root);
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password}});
  assert.equal(login.statusCode,200,login.body);
  const {csrf}=login.json(),cookie=String(login.headers['set-cookie']).split(';')[0],requestId=randomUUID();
  const body=new Readable({read(){this.push(Buffer.from([1,2,3]));this.destroy(new Error('BODY_FAILED'));}});
  const response=app.inject({method:'POST',url:`/api/lab/studies/${f.study.study_id}/upload`,headers:{origin,cookie,'x-csrf-token':csrf,'x-request-id':requestId,'x-file-name':'broken.png','content-type':'image/png'},payload:body});
  await assert.rejects(response,/BODY_FAILED/);
  for(let attempt=0;attempt<20;attempt++){
    if(f.admin('job.get',{job_id:requestId}).state==='FAILED')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(f.admin('job.get',{job_id:requestId}).state,'FAILED');
  assert.equal(f.db.prepare("SELECT state FROM lab_assets WHERE upload_id=?").get(requestId).state,'FAILED');
});
