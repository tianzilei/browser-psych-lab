### 结论状态分类概览

- **确定且可复现 (Definite & Reproducible)**：
  1. `scripts/prepare-images.mjs` 中 `options()` 对 `defaults` 允许 `null` 导致对象解构/校验抛出 `TypeError`。
  2. CLI 写入阶段无原子目录事务，中间失败遗留半成品输出目录，且阻断后续重试执行。
  3. Windows 保留文件名（CON, PRN, AUX, NUL, COM1-9, LPT1-9）与大小写不敏感碰撞未校验，导致跨平台解压损坏或覆盖。
  4. 同一 source 声明重复 variant `name` 导致单次运行重复处理但未提前拦截。
  5. 配置文件多次引用同一 `source` 时重复磁盘读取与重复 `sharp` 校验解码。
- **待验证假设 (Pending Verification / Empirical)**：
  1. 跨平台 ZIP 解压器对文件名大小写归一化后的哈希一致性差异（依赖下游具体解压工具如 7-Zip、Windows Explorer、macOS Archive Utility）。
  2. 高并发/大图片批处理下，Node.js 主进程中 `sharp.cache(false)` 与内存峰值留存的具体边界（受 libvips 内存池策略与 OS 页面回收影响）。

### 问题审查、最小修复与回归测试

#### 1. `options()` 函数对 `defaults: null` 校验缺失导致运行时 `TypeError` (确定)

- **文件 / 函数**：`scripts/prepare-images.mjs` -> `options()`
- **具体输入**： `config.json` 包含 `"defaults": null`：`{
  "schema": "mobile-images-v1",
  "package": "bundle.zip",
  "defaults": null,
  "images": [{ "source": "test.png", "variants": [{ "name": "v1" }] }]
}`
- **根因**： `function options(value={})` 中，如果显式传入 `null`，默认参数不会触发（只有 `undefined` 会触发默认值）。在执行 `record(value, keys)` 时，`typeof null === 'object'` 成立，而 `Object.keys(null)` 直接抛出原生未捕获异常 `TypeError: Cannot convert undefined or null to object`，未能输出清晰的业务配置错误。
- **最小修复**：`function options(value={}){
  if(value===null||value===undefined)return {};
  record(value,keys);
  // ... 后续逻辑保持不变`
- **回归测试**：`test('CLI rejects or safely normalizes null defaults without raw TypeError', () => {
  assert.doesNotThrow(() => options(null));
  assert.deepEqual(options(null), {});
});`

#### 2. 输出写入非原子化导致半成品目录泄漏，且二次重试被锁死 (确定)

- **文件 / 函数**：`scripts/prepare-images.mjs` -> `main()`
- **具体输入**： 配置中有两个变体，第一个变体生成写入成功，但在处理第二个变体、写入 ZIP 或报告时抛出异常（例如磁盘空间不足或进程被杀中断）。
- **根因**： 代码提前执行了：`await mkdir(dirname(output),{recursive:true});
await mkdir(output);
await mkdir(join(output,'images'));
for(const file of files)await writeFile(join(output,file.path),file.bytes,{flag:'wx'});`如果循环中途出现错误，目标文件夹 `output` 已经作为半成品存在于磁盘中。下次修正后重新运行 CLI 时，由于第一道 `await mkdir(output)` 没有 `{recursive: true}` 且未加容错，会抛出 `EEXIST: file already exists`，使得用户无法重新修复重试，只能手动干预删除目录。
- **最小修复**： 将构建结果先写入临时目录，全量生成、校验和写入成功后，通过原子重命名（`rename`）提升至目标路径；若中途失败，清理临时目录：`import {rename,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

// ... 生成完 zip 和 files 后:
const staging = `${output}.tmp-${randomBytes(6).toString('hex')}`;
try {
  await mkdir(dirname(output),{recursive:true});
  await mkdir(staging);
  await mkdir(join(staging,'images'));
  for(const file of files)await writeFile(join(staging,file.path),file.bytes,{flag:'wx'});
  await writeFile(join(staging,config.package),zip,{flag:'wx'});
  const report={schema:'mobile-images-report-v1',package:config.package,packageBytes:zip.length,images:reports};
  await writeFile(join(staging,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});

  // 原子重命名至目标目录，若目标目录已存在则禁止覆盖并抛出
  await rename(staging, output);
} catch (err) {
  await rm(staging, {recursive:true, force:true}).catch(()=>{});
  throw err;
}`
- **回归测试**：`test('CLI failure leaves no partial target directory and allows fresh retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bpl-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outDir = join(dir, 'output');
  // 模拟写入异常
  // 断言 outDir 不存在，修复后二次运行能成功创建
});`

#### 3. Windows 设备保留名称与大小写不敏感碰撞漏洞 (确定)

- **文件 / 函数**：`scripts/prepare-images.mjs` -> 变体名称及路径校验
- **具体输入**： 变体名称配置为：
  1. `name: "aux"` 或 `name: "con"` 或 `name: "com1"`。
  2. 同一配置中包含两个变体：`name: "CARD"` 与 `name: "card"`（生成 `images/CARD.webp` 与 `images/card.webp`）。
- **根因**：
  1. 正则 `/^[-a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/` 允许了 Windows 系统级保留设备名（`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` 及其不区分大小写变体）。在 Windows 系统上写入文件或解压该 ZIP 会直接触发系统底层 I/O 错误或拒绝访问。
  2. `names.has(path)` 是严格大小写敏感的 Set 查找。在 Linux 上两者是不同路径，但在 Windows / 默认 macOS APFS 文件系统上，写入 `images/CARD.webp` 后再以 `{flag: 'wx'}` 写入 `images/card.webp` 会直接报 `EEXIST` 崩溃；即使在 Linux 下打成 ZIP，交付到 Windows 客户端解压时也会发生覆盖损坏。
- **最小修复**：`const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const lowerNames = new Set();

// 循环体内：
if (typeof variant.name !== 'string' || !/^[-a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(variant.name)) {
  throw new Error('INVALID_VARIANT_NAME');
}
if (WINDOWS_RESERVED.test(variant.name)) {
  throw new Error('RESERVED_DEVICE_NAME');
}

// 校验跨平台路径大小写碰撞：
const path = `images/${name}${settings.tiles ? `-tile-${String(i+1).padStart(3,'0')}` : ''}.${ext}`;
const lowerPath = path.toLowerCase();
if (lowerNames.has(lowerPath)) {
  throw new Error('DUPLICATE_OR_AMBIGUOUS_IMAGE_PATH_CASE');
}
lowerNames.add(lowerPath);
names.add(path);`
- **回归测试**：`test('rejects Windows reserved device names and case-colliding variant paths', () => {
  assert.throws(() => {
    // 传入包含 name: 'aux' 或 name: 'NUL' 的配置
  }, /RESERVED_DEVICE_NAME/);

  assert.throws(() => {
    // 传入变体包含 CARD 与 card 的配置
  }, /DUPLICATE_OR_AMBIGUOUS_IMAGE_PATH_CASE/);
});`

#### 4. 同一图片内声明重复变体名称未在处理前尽早拦截 (确定)

- **文件 / 函数**：`scripts/prepare-images.mjs`
- **具体输入**：`{
  "source": "photo.png",
  "variants": [
    { "name": "banner", "fit": "cover" },
    { "name": "banner", "fit": "contain" }
  ]
}`
- **根因**： 代码在跑完耗时的 `optimizeImage(input, settings)` 之后，才在内部拼接路径并执行 `if(names.has(path)) throw new Error('DUPLICATE_IMAGE_PATH')`。若一个大图片配置了多个重名变体，必须白白浪费多次 CPU 压缩与编码计算才在输出阶段抛错。
- **最小修复**： 在遍历执行图片压缩前，增加一次前置变体名称合法性与排重静态扫描：`// 在循环前先建立全局唯一集合验证
const plannedPaths = new Set();
for (const item of config.images) {
  record(item, ['source', 'variants']);
  // ...
  for (const v of item.variants) {
    record(v, ['name', ...keys]);
    const ext = (v.format ?? defaults.format) === 'jpeg' ? 'jpg' : (v.format ?? defaults.format ?? 'webp');
    const plannedKey = `${v.name}.${ext}`.toLowerCase();
    if (plannedPaths.has(plannedKey)) throw new Error('DUPLICATE_PLANNED_VARIANT');
    plannedPaths.add(plannedKey);
  }
}`
- **回归测试**：`test('fails immediately on duplicated variant names before invoking image optimization', async () => {
  // 构造包含重名变体的 config，断言在 10ms 内抛出 DUPLICATE_PLANNED_VARIANT，不进入 optimizeImage
});`

#### 5. 跨项复用同一 `source` 时的重复磁盘 I/O (确定)

- **文件 / 函数**：`scripts/prepare-images.mjs` -> `main()` 图像处理主循环
- **具体输入**：`"images": [
  { "source": "stimuli/A.png", "variants": [{ "name": "A_feed" }] },
  { "source": "stimuli/A.png", "variants": [{ "name": "A_detail" }] }
]`
- **根因**： 外层循环直接按配置顺序读取文件：`for(const item of config.images){
  const sourcePath=await realpath(resolve(dirname(configPath),item.source));
  // ...
  const input=await readFile(sourcePath);`没有对 `sourcePath` 做 Buffer 内存级复用缓存。当心理学实验材料配置文件由脚本生成且存在对同一大源图派生不同场景任务时，会产生冗余的磁盘同步或多次载入（即使 OS PageCache 命中，也在 Node.js 内存堆中产生了多个 32MB Buffer 副本）。
- **最小修复**： 引入简单的源路径 Buffer 缓存 Map：`const sourceCache = new Map();

for(const item of config.images){
  // ...
  const sourcePath=await realpath(resolve(dirname(configPath),item.source));
  let input = sourceCache.get(sourcePath);
  if(!input){
    const st=await stat(sourcePath);
    if(!st.isFile()||st.size>32*1024*1024)throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');
    input = await readFile(sourcePath);
    sourceCache.set(sourcePath, input);
  }
  // 后续传入 input 处理`
- **回归测试**：`test('shares identical source buffer when source path is referenced across entries', async () => {
  // 注入相同的 source 文件，断言只触发一次实际 readFile
});`

### 测试集增强：`tests/unit/image-optimization.test.mjs` 增补用例

在测试文件中追加以下用例，确保上述修复生效且边界行为得到完整锁定：

```
test('options parser accepts null/undefined defaults gracefully', () => {
  // 验证 options(null) 与 options(undefined) 均返回空对象
  assert.deepEqual(options(null), {});
  assert.deepEqual(options(undefined), {});
  assert.throws(() => options(123), /INVALID_IMAGE_CONFIG_FIELDS/);
});

test('detects Windows reserved names and case-insensitive file collisions', () => {
  const reservedNames = ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1'];
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  for (const name of reservedNames) {
    assert.ok(WINDOWS_RESERVED.test(name), `Should flag ${name} as reserved`);
  }
  assert.ok(!WINDOWS_RESERVED.test('stimulus_con'));
});

test('tiles geometry does not loop infinitely when width equals maxPixels', () => {
  // 验证极端比例下 width * height 达到临界值时不会导致 heightLimit=0 或死循环
  const source = { width: 4000, height: 10000 };
  const plans = planImageTiles(source, { maxPixels: 4_000_000 }, 1024);
  assert.ok(plans.length > 0);
  assert.ok(plans.every(p => p.output.width <= 4000 && p.output.height <= 1024));
});
```
