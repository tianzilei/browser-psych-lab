全项目设计讨论，传输段 47，源码主题：运维工具和部署（源包 15/18）。这是按行分段的完整源码，跨段函数请等待后续上下文。先吸收本段；中文回复最多200字，只标出业务作用和一项最有价值的设计建议（若上下文不足则待定），不要展开重写、不要外部搜索。全部源码发送完后再综合讨论。

    const upper = text(element.upperLabel?.default) || '最高';
    return { id, type: 'scale', title, required, min, max, min_label: lower, max_label: upper, labels: scaleLabels(min, max, lower, upper) };
  }
  return { skipped: { id: element.id, type: element.type, title, reason: 'UNSUPPORTED_ELEMENT_TYPE' } };
}

function canonicalQuestions(row) {
  const questions = [];
  const skipped = [];
  for (const block of parseBlocks(row.blocks)) for (const element of block.elements ?? []) {
    const q = questionFromElement(element, questions.length);
    if (q?.skipped) skipped.push(q.skipped);
    else if (q) questions.push(q);
  }
  return { questions, skipped };
}

function makeSurvey(row, questions) {
  const pages = [];
  for (let start = 0, pageNo = 1; start < questions.length; start += PAGE_SIZE, pageNo += 1) {
    pages.push({
      id: `page_${String(pageNo).padStart(2, '0')}`,
      title: `${text(row.name)}��\u7b2c ${pageNo} \u9875��`,
      instruction: '请根据你的实际情况作答。每页提交后继续。',
      questions: questions.slice(start, start + PAGE_SIZE),
    });
  }
  return {
    schema: 'questionnaire-v1',
    title: text(row.name),
    background: '#e5e5e5',
    orientation: 'portrait',
    consent: {
      title: '\u77e5\u60c5\u540c\u610f',
      text: '这份问卷由旧 Formbricks 问卷转换而来。请阅读题目并根据你的实际情况作答。你可以随时停止参与；提交后答案会保存到本项目的数据记录中。',
    },
    ending: { title: '感谢参与', text: '你的答案已保存。现在可以关闭页面。' },
    pages,
  };
}

const rows = parseCsv(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
const seen = new Map();
const surveys = [];
const rejected = [];
for (const row of rows) {
  const { questions, skipped } = canonicalQuestions(row);
  if (!questions.length) {
    rejected.push({ id: row.id, name: text(row.name), source_element_count: skipped.length, skipped, reason: 'NO_SUPPORTED_QUESTIONS' });
    continue;
  }
  const signature = JSON.stringify(questions.map(({ id: _id, ...q }) => q));
  if (seen.has(signature)) continue;
  seen.set(signature, row.id);
  surveys.push({ row, questions, skipped });
}

fs.mkdirSync(outputDir, { recursive: true });
// Remove files produced by an earlier conversion so rejected or deduplicated
// surveys cannot remain in the import directory and look current.
const previousManifestPath = path.join(outputDir, 'manifest.json');
if (fs.existsSync(previousManifestPath)) {
  try {
    const previous = JSON.parse(fs.readFileSync(previousManifestPath, 'utf8').replace(/^\uFEFF/, ''));
    for (const item of [...(previous.kept ?? []), ...(previous.rejected ?? [])]) {
      const file = item.file ?? (item.id ? `${item.id}.json` : null);
      if (file) fs.rmSync(path.join(outputDir, file), { force: true });
    }
  } catch { /* regenerate the manifest below */ }
}
const manifest = { source: path.relative(process.cwd(), input).replaceAll('\\', '/'), kept: [], duplicates: [], rejected };
const firstBySignature = new Map();
for (const row of rows) {
  const { questions } = canonicalQuestions(row);
  const signature = JSON.stringify(questions.map(({ id: _id, ...q }) => q));
  if (!firstBySignature.has(signature)) firstBySignature.set(signature, row.id);
  else manifest.duplicates.push({ id: row.id, duplicate_of: firstBySignature.get(signature), name: text(row.name) });
}
for (const { row, questions, skipped } of surveys) {
  const filename = `${row.id}.json`;
  fs.writeFileSync(path.join(outputDir, filename), `${JSON.stringify(makeSurvey(row, questions), null, 2)}\n`);
  manifest.kept.push({ id: row.id, name: text(row.name), file: filename, source_element_count: questions.length + skipped.length, question_count: questions.length, skipped });
}
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`converted ${manifest.kept.length} surveys; removed ${manifest.duplicates.length} duplicates`);

```

### scripts/dev.mjs L1–L30

```
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root, loadEnv } from './lib.mjs';

loadEnv();
const commands = [
  [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'src/server/main.ts'],
  [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts'],
];
const groupSignals = process.platform !== 'win32';
const children = commands.map(args => spawn(process.execPath, args, {
  cwd: root, env: process.env, stdio: 'inherit', detached: groupSignals,
}));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (groupSignals && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const child of children) {
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}

```

### scripts/doctor.mjs L1–L60

```
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { root, run, loadEnv } from './lib.mjs';
import { openDatabase } from '../src/server/database.ts';

loadEnv();
let failures = 0;
async function check(label, callback) {
  try { console.log(`${label}: ${await callback()}`); }
  catch { failures++; console.error(`${label}: FAILED`); }
}
await check('Node', async () => {
  const expected = (await readFile(resolve(root, '.nvmrc'), 'utf8')).trim();
  if (process.versions.node !== expected) throw new Error('Use nvm use');
  return process.version;
});
await check('Dependencies', async () => {
  await run('npm', ['ls', '--depth=0'], { cwd: root });
  return 'installed';
});
await check('SQLite', async () => {
  if (!process.env.DATABASE_PATH) throw new Error('Missing .env');
  await access(resolve(root, process.env.DATABASE_PATH));
  const db = openDatabase(resolve(root, process.env.DATABASE_PATH));
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Integrity failure');
    return `${db.prepare('SELECT sqlite_version() AS v').get().v}; WAL / FULL / foreign keys`;
  } finally { db.close(); }
});
for (const bucket of ['research-assets', 'research-exports', 'research-backups']) {
  await check(bucket, async () => {
    await access(resolve(root, process.env.STORAGE_ROOT ?? 'var', bucket), constants.R_OK | constants.W_OK);
    return 'readable/writable (same-machine development storage)';
  });
}
const manifest = JSON.parse(await readFile(resolve(root, 'references/manifest.lock.json'), 'utf8'));
for (const repo of manifest.repositories) {
  await check(`Reference ${repo.name}`, async () => {
    const cwd = resolve(root, 'references/checkouts', repo.name);
    const actual = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (actual !== repo.commit) throw new Error('Commit mismatch');
    if ((await run('git', ['status', '--porcelain'], { cwd })).stdout.trim()) throw new Error('Dirty reference');
    for (const license of repo.licenses ?? []) {
      const bytes = await readFile(resolve(cwd, license.path));
      if (createHash('sha256').update(bytes).digest('hex') !== license.sha256) throw new Error('License mismatch');
    }
    return actual.slice(0, 12);
  });
}
for (const file of manifest.files ?? []) {
  await check(`Source ${file.path}`, async () => {
    const bytes = await readFile(resolve(root, 'references', file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Digest mismatch');
    return file.sha256.slice(0, 12);
  });
}
process.exitCode = failures ? 1 : 0;

```

### scripts/image-output.mjs L1–L30

```
import {open,lstat,mkdir,mkdtemp,rename,rm,unlink,realpath} from 'node:fs/promises';
import {dirname,resolve,join,basename} from 'node:path';

async function requireMissing(path){
  try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error('IMAGE_OUTPUT_ALREADY_EXISTS');
}
// One CLI publisher at a time per destination. Only a complete staging tree
// becomes visible; failures preserve existing output and permit a fresh retry.
export async function publishImageOutput(output,write){
  output=resolve(output);await mkdir(dirname(output),{recursive:true});
  const parent=await realpath(dirname(output));output=join(parent,basename(output));
  const lockPath=`${output}.lock`,lock=await open(lockPath,'wx');let staging;
  try{
    await requireMissing(output);
    staging=await mkdtemp(join(parent,`.${basename(output)}.tmp-`));
    await write(staging);await requireMissing(output);
    await rename(staging,output);staging=undefined;
  }finally{
    try{
      if(staging){
        // Validate the exact generated absolute path before recursive cleanup.
        const actual=await realpath(staging);
        if(actual!==staging||dirname(actual)!==parent||!basename(actual).startsWith(`.${basename(output)}.tmp-`))throw new Error('UNSAFE_IMAGE_STAGING_PATH');
        await rm(actual,{recursive:true,force:true});
      }
    }finally{await lock.close();await unlink(lockPath);}
  }
}

```

### scripts/lib.mjs L1–L18

```
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const run = promisify(execFile);
export function loadEnv() {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
export function fail(error) {
  // Do not echo command arguments or database credentials from subprocess errors.
  console.error(error.message?.split('\n')[0] ?? 'Operation failed.');
  process.exitCode = 1;
}

```

### scripts/precompress.mjs L1–L21

```
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { root } from './lib.mjs';

const gz = promisify(gzip);
const br = promisify(brotliCompress);
const directory = resolve(root, 'dist/web/assets');
let count = 0;
// Build-time compression of public bundles only. Research storage is excluded.
for (const name of await readdir(directory)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const path = resolve(directory, name);
  const bytes = await readFile(path);
  await writeFile(`${path}.gz`, await gz(bytes, { level: 9 }));
  await writeFile(`${path}.br`, await br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
  count++;
}
console.log(`Precompressed ${count} public JS/CSS bundles (gzip + brotli).`);

```

### scripts/prepare-images.mjs L1–L92

```
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {optimizeImage,packImageZip,validateVariantOptions} from '../src/server/offline-image.ts';
import {IMAGE_PRESETS} from '../src/shared/image-plan.ts';
import {packageName} from '../src/shared/questionnaire-json.ts';
import {fail} from './lib.mjs';
import {publishImageOutput} from './image-output.mjs';

const keys=['scene','viewport','deviceDpr','density','saveData','zoom','fit','content','focus','protectedRegion','maxPixels','format','quality','minQuality','budgetBytes','tiles','tileHeight'];
function record(value,allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('INVALID_IMAGE_CONFIG_FIELDS');
  return value;
}
function options(value={}){
  record(value,keys);
  if(Object.values(value).some(v=>v===null))throw new Error('NULL_IMAGE_OPTION');
  for(const k of ['saveData','zoom','tiles'])if(k in value&&typeof value[k]!=='boolean')throw new Error('INVALID_IMAGE_CONFIG_BOOLEAN');
  if(value.scene!==undefined&&!Object.hasOwn(IMAGE_PRESETS,value.scene))throw new Error('INVALID_IMAGE_SCENE');
  if(value.content!==undefined&&!['photo','text'].includes(value.content))throw new Error('INVALID_IMAGE_CONTENT');
  for(const [key,fields] of [['viewport',['width','height']],['focus',['x','y']],['protectedRegion',['x','y','width','height']]]){
    if(key in value){record(value[key],fields);if(fields.some(k=>typeof value[key][k]!=='number'))throw new Error('INVALID_IMAGE_CONFIG_REGION');}
  }
  return value;
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){
    console.log('npm run images:prepare -- <config.json> <new-output-directory>\nSee docs/移动端图片处理.md and examples/images/mobile-plan.json');return;
  }
  if(args.length!==2)throw new Error('Usage: npm run images:prepare -- <config.json> <new-output-directory>');
  const configPath=resolve(args[0]),text=await readFile(configPath,'utf8');
  if(Buffer.byteLength(text)>512*1024)throw new Error('IMAGE_CONFIG_TOO_LARGE');
  const config=record(JSON.parse(text.replace(/^\uFEFF/,'')),['schema','package','defaults','images']);
  if(config.schema!=='mobile-images-v1')throw new Error('INVALID_IMAGE_CONFIG_SCHEMA');
  packageName(config.package);const defaults=options(config.defaults);
  if(!Array.isArray(config.images)||!config.images.length||config.images.length>100)throw new Error('INVALID_IMAGE_CONFIG_LIST');
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(config.package))throw new Error('RESERVED_DEVICE_NAME');
  const planned=[],plannedPaths=new Set();
  // Validate the entire configuration before opening sources or encoding.
  for(const item of config.images){
    record(item,['source','variants']);
    if(typeof item.source!=='string'||!Array.isArray(item.variants)||!item.variants.length||item.variants.length>20)throw new Error('INVALID_IMAGE_VARIANTS');
    for(const variant of item.variants){
      record(variant,['name',...keys]);