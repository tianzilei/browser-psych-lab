// Run on the ECS host, against a NEW isolated database. Production is read-only.
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash,scryptSync} from 'node:crypto';
const [release,rootArg]=process.argv.slice(2),root=resolve(rootArg);
const {openDatabase}=await import(`file://${release}/dist/server/database.js`);
const {LabStore}=await import(`file://${release}/dist/server/lab-store.js`);
const {default:Database}=await import(`${release}/node_modules/better-sqlite3/lib/index.js`);
const source=new Database('/var/lib/browser-psych-lab/database/browser-psych-lab.sqlite',{readonly:true});
const frozen=source.prepare('SELECT protocol FROM lab_versions WHERE version_id=?').get('32c9e562-6072-45cf-b469-a8ab56065343');
const protocol=JSON.parse(frozen.protocol);protocol.title='TEST_ONLY isolated ECS capacity';delete protocol.consent;
await mkdir(join(root,'research-assets'),{recursive:true,mode:0o700});
const db=openDatabase(join(root,'database.sqlite'));
const runnerHash=JSON.parse(await readFile(join(release,'dist/release.json'),'utf8')).runnerHash;
const store=new LabStore(db,runnerHash,Date.now,10000),token=randomUUID(),csrf=randomUUID();
const digest=v=>createHash('sha256').update(v).digest('hex');store.execute({operation:'lab/admin.issue',data:{token_hash:digest(token),csrf}});
const admin=(op,data)=>store.execute({operation:`lab/${op}`,credential_hash:digest(token),data:{csrf,...data}});
const study=admin('study.create',{request_id:randomUUID()});
for(const asset of new Set(protocol.groups.flatMap(g=>g.trials.map(t=>t.asset_id)))){
  const row=source.prepare('SELECT * FROM lab_assets WHERE asset_id=?').get(asset);
  await copyFile(`/var/lib/browser-psych-lab/research-assets/${asset}.bin`,join(root,'research-assets',`${asset}.bin`));
  db.prepare("INSERT INTO lab_assets VALUES (?,?,?,'READY',?,?,?,?,?,?,0)").run(asset,study.study_id,row.name,row.hash,row.bytes,row.width,row.height,row.format,randomUUID());
}
const saved=admin('study.save',{request_id:randomUUID(),study_id:study.study_id,revision:1,protocol});
const version=admin('study.publish',{request_id:randomUUID(),study_id:study.study_id,revision:saved.revision});
admin('study.admission',{request_id:randomUUID(),study_id:study.study_id,paused:false});
const password=randomUUID(),salt=randomUUID().replaceAll('-',''),hash=`scrypt:${salt}:${scryptSync(password,salt,64).toString('hex')}`;
await writeFile(join(root,'probe.env'),`NODE_ENV=production\nHOST=127.0.0.1\nPORT=3310\nPUBLIC_ORIGIN=https://example.invalid\nDATABASE_PATH=${root}/database.sqlite\nSTORAGE_ROOT=${root}\nSESSION_CONCURRENCY=10000\nPREPARATION_CONCURRENCY=10000\nLOG_LEVEL=error\nADMIN_PASSWORD_HASH=${hash}\n`,{mode:0o600});
await writeFile(join(root,'fixture.json'),JSON.stringify({version,study,assets:source.prepare('SELECT asset_id,hash,bytes FROM lab_assets WHERE study_id=? AND state=\'READY\'').all('3dccccfe-1186-49de-a90f-94556059f4d1'),password}),{mode:0o600});
db.close();source.close();console.log(JSON.stringify({root,study:study.study_id,version:version.version_id,images:protocol.groups[0].trials.length}));
