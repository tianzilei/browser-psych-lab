Gemini 说
优先级 1：修复准备阶段静态超时与流式控制（对应问题 1）
缺陷诊断

在共享 1–5 Mbps 出带宽且有 20 会话并发的场景下，单连接平均有效带宽仅约 25–150 KB/s：

静态超时必杀：AbortSignal.timeout(20000) 是绝对墙上时钟超时。下载 1 MiB 需要 7–40 秒，下载 5 MiB 需要 35–200 秒，20 秒在低带宽下会造成必然中断。

并发未受控且缺少级联取消：固定起 2 个 worker，20 会话会产生 40 个并发流争抢出带宽。若一个 worker 抛错，另一个 worker 不会被中断，残余网络流会继续消耗带宽，甚至泄露到试次阶段。

缺少分段与流式空闲看门狗：应采用“流式数据读取停滞超时（Activity/Stall Timeout）”加“基于文件尺寸的传输保底时长”，而非全局硬编码超时。

代码重构：prepare.ts

将 prepareImages 替换为带有活跃检测、单错误全取消、外部中断支持与内存隔离的实现：

TypeScript
// prepare.ts
import { openDB, deleteDB } from 'idb';
import type { LabSession } from '../shared/lab-contract.js';
import type { Group, Protocol } from '../shared/protocol.js';

interface PrepareOptions {
  parentSignal?: AbortSignal;
  /** 单次数据包到达的最大允许静默时间，默认 15000ms */
  stallTimeoutMs?: number;
  /** 最低保障传输速率 (Bps)，用于计算总超时上限，默认 20 KB/s */
  floorSpeedBps?: number;
}

export async function prepareImages(
  session: LabSession,
  group: Group,
  status: (text: string) => void,
  blobCache: Map<string, Uint8Array>,
  options: PrepareOptions = {}
) {
  const { stallTimeoutMs = 15000, floorSpeedBps = 20 * 1024, parentSignal } = options;
  if (parentSignal?.aborted) throw new Error('准备已被外部中止。');

  const infos = group.trials.map(t => session.frozen.assets.find(a => a.asset_id === t.asset_id)!);
  if (infos.some(a => !a)) throw new Error('冻结资源清单不完整。');

  const unique = [...new Map(infos.map(a => [a.hash, a])).values()];
  const estimatedDecoded = unique.reduce((n, a) => n + a.width * a.height * 4, 0);
  if (estimatedDecoded > session.frozen.protocol.budget.max_decoded_bytes) {
    throw new Error('图片解码预算不足。');
  }

  const bitmaps = new Map<string, ImageBitmap>();
  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  let completed = 0;
  let queueIndex = 0;

  async function fetchWithStallCheck(info: typeof unique[0]): Promise<Uint8Array> {
    // 优先命中会话内原字节内存缓存
    const cached = blobCache.get(info.hash);
    if (cached) return cached;

    // 动态计算总容忍时间：基准 15s + 按最低速率所需时长
    const maxBudgetMs = Math.max(20000, Math.ceil((info.bytes / floorSpeedBps) * 1000) + 15000);
    const downloadTimeout = AbortSignal.timeout(maxBudgetMs);
    const combinedSignal = AbortSignal.any([abortController.signal, downloadTimeout]);

    const response = await fetch(
      `/api/participate/sessions/${session.session_id}/assets/${info.asset_id}`,
      { cache: 'no-store', signal: combinedSignal }
    );
    if (!response.ok) throw new Error(`图片下载失败 (${response.status})，可重试准备。`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('环境不支持流式响应。');

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        // 空闲看门狗：两次数据到达间隔超 stallTimeoutMs 判定断线
        const stallPromise = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('数据传输停滞超时。')), stallTimeoutMs);
          combinedSignal.addEventListener('abort', () => clearTimeout(t), { once: true });
        });

        const readResult = await Promise.race([reader.read(), stallPromise]);
        if (readResult.done) break;

        const chunk = readResult.value;
        receivedBytes += chunk.byteLength;
        if (receivedBytes > info.bytes) {
          await reader.cancel();
          throw new Error('图片字节数超出清单。');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    if (receivedBytes !== info.bytes) throw new Error('图片未完整下载。');

    const fullData = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const c of chunks) {
      fullData.set(c, offset);
      offset += c.byteLength;
    }

    // 校验 SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', fullData);
    const hexHash = Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
    if (hexHash !== info.hash) throw new Error('图片摘要不匹配。');

    // 存入会话内存原图缓存供后续 Group 复用
    blobCache.set(info.hash, fullData);
    return fullData;
  }

  async function worker() {
    while (queueIndex < unique.length) {
      const target = unique[queueIndex++];
      status(`准备图片 ${completed}/${unique.length}`);

      const data = await fetchWithStallCheck(target);
      const bitmap = await createImageBitmap(new Blob([data], { type: `image/${target.format}` }));
      
      if (bitmap.width !== target.width || bitmap.height !== target.height) {
        bitmap.close();
        throw new Error('图片尺寸与冻结清单不符。');
      }

      bitmaps.set(target.hash, bitmap);
      completed++;
    }
  }

  try {
    // 保持 2 并发拉取
    await Promise.all([worker(), worker()]);
    status(`全部 ${unique.length} 张图片已准备。`);
    
    return {
      byAsset: new Map(infos.map(a => [a.asset_id, bitmaps.get(a.hash)!])),
      hashes: Object.fromEntries(infos.map(a => [a.asset_id, a.hash])),
      decoded_bytes: estimatedDecoded,
      release: () => {
        // 显式回收当前组的解码显存/内存
        for (const image of bitmaps.values()) image.close();
        bitmaps.clear();
      }
    };
  } catch (error) {
    // 任一失败立即广播中止信号，停止其余并发网络流
    abortController.abort(error);
    for (const image of bitmaps.values()) image.close();
    throw error;
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

优先级 2：私有原图缓存分层与第一版稳态方案（对应问题 2）
架构审查结论

第一版只做会话内内存缓存（In-Memory Session Cache）最稳妥：

隐私保护：心理实验原图常具保密性，写入浏览器磁盘（CacheStorage 或 IndexedDB）容易残留在被试终端。会话内内存缓存随页面卸载自然销毁。

配额与 I/O 干扰：写入 IndexedDB 会触发本地文件同步与配额检查，在受限 Chromium 实例上与 storageProbe / SQLite 审计管道争抢 I/O。

鉴权约束：若做跨会话磁盘持久化，需在请求头重新带 token 校验 session_id 是否拥有该 asset 权限，跳过服务端等同绕过鉴权。

两级资源生命周期隔离：

原始字节（Raw Bytes）：存放在会话级 Map<hash, Uint8Array> 中。跨组复用时无需再次发起网络请求；

解码位图（ImageBitmap）：严格以组（Group）为生命周期。组前准备时生成，组结束时在 release() 中立即执行 bitmap.close()。绝对不能跨组常驻，避免累积超出 max_decoded_bytes。

优先级 3：frozen runner 预压缩变体与完整性验证（对应问题 3）
缺陷诊断

runnerHash 是整个实验协议的不可变身份标识（digest(JSON.stringify(release.files))）。

构建脚本生成了 .gz 和 .br，但 release.ts 未将其收录，导致归档目录缺少预压缩变体，运行时全量回退至未压缩原始文本，20 会话初始化时会瞬时占满 1–5 Mbps 出带宽。

release.files 不可直接加入压缩文件哈希，否则压缩算法微版本波动会导致 runnerHash 突变，破坏跨环境可复现性。

修复方案

身份不变性：release.files 仅保留未压缩的 canonical 原文件，runnerHash 计算逻辑严格不变。

构建时归档与解压校验：归档时定位配套的 .gz 与 .br，解压还原后比对明文 SHA-256。一致方可落盘为伴生文件。

服务端协商（HTTP RFC 9110）：支持 Accept-Encoding: br, gzip，精准处理 q=0，追加 Vary: Accept-Encoding 与 Cache-Control: public, max-age=31536000, immutable, no-transform。

旧版本平滑兼容：伴生压缩文件不存在时回退至 identity 原始流，不抛出异常。

代码重构：release.ts 与服务路由
TypeScript
// release.ts 部分关键逻辑补充
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

async function verifyCompressedVariant(compressedPath: string, expectedHash: string, type: 'gz' | 'br') {
  const decompressor = type === 'gz' ? createGunzip() : createBrotliDecompress();
  const hashStream = crypto.createHash('sha256');
  await pipeline(createReadStream(compressedPath), decompressor, hashStream);
  if (hashStream.digest('hex') !== expectedHash) {
    throw new Error(`COMPRESSED_VARIANT_INTEGRITY_FAILED: ${compressedPath}`);
  }
}

// 在 retainRelease 的 for 循环内追加对 .gz 和 .br 的归档：
for (const ext of ['.br', '.gz'] as const) {
  const variantSource = source + ext;
  const variantTarget = target + ext;
  try {
    await verifyCompressedVariant(variantSource, file.hash, ext === '.br' ? 'br' : 'gz');
    const tempVariant = join(dirname(target), `.tmp-${randomUUID()}${ext}`);
    await copyFile(variantSource, tempVariant);
    const fd = await openPrivate(tempVariant);
    try { await fd.sync(); } finally { await fd.close(); }
    try { await link(tempVariant, variantTarget); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    finally { await unlink(tempVariant).catch(() => {}); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // 构建未生成压缩包时允许跳过，保证对旧产物的兼容
  }
}

TypeScript
// runner 静态路由响应逻辑 (Fastify 插件或原生路由片段)
export function handleRunnerStatic(req: FastifyRequest, reply: FastifyReply, diskPath: string) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  
  // 简易 RFC 9110 q-value 解析
  const supportsBr = !/br\s*;\s*q=0(?![0-9.])/i.test(acceptEncoding) && /\bbr\b/i.test(acceptEncoding);
  const supportsGzip = !/gzip\s*;\s*q=0(?![0-9.])/i.test(acceptEncoding) && /\bgzip\b/i.test(acceptEncoding);

  reply.header('Vary', 'Accept-Encoding');
  reply.header('Cache-Control', 'public, max-age=31536000, immutable, no-transform');

  if (supportsBr && existsSync(diskPath + '.br')) {
    reply.header('Content-Encoding', 'br');
    return reply.send(createReadStream(diskPath + '.br'));
  }
  if (supportsGzip && existsSync(diskPath + '.gz')) {
    reply.header('Content-Encoding', 'gzip');
    return reply.send(createReadStream(diskPath + '.gz'));
  }
  return reply.send(createReadStream(diskPath));
}

优先级 4：消除 SQLite 争用与 503 重试优化（对应问题 4）
缺陷与争用根源

REPLAY 放大 fsync 阻塞：WAL + synchronous = FULL 要求事务提交阻塞等待系统盘落盘。如果 REPLAY 的几十条事件通过单事件单事务逐条落盘，耗时达数百毫秒；当 20 个会话在组结束集中 REPLAY 时，写队列（容量 32）被瞬间打满，后续请求直接触发 503。

Maintenance worker 长事务锁死：长达 120 秒的维护任务独占数据库连接，阻塞 WAL checkpoint 并阻断常规写操作。

优化实施方案（不引入额外数据库/MQ）

客户端与服务端批量提交（Batched REPLAY Transaction）：

客户端一次提交整个组的离线事件数组（限制单批上限 32 条 / 256 KiB）。

服务端在单事务 BEGIN IMMEDIATE ... COMMIT 中批量执行，将 32 次 fsync 合并为 1 次。

写入幂等（Idempotency）：

SQL 显式使用 INSERT INTO events (...) VALUES (...) ON CONFLICT(event_id) DO NOTHING;。当客户端遇到网络超时或 503 重试时，重发的事件不会引发冲突报错，且正常返回已落盘 ACK。

剥离只读检验：

进入 SQLite 写队列前，在主线程/只读连接上完成 session 校验与鉴权，严禁在单写 worker 中执行额外 SELECT 语句。

WAL Checkpoint 调优：

启动时执行 PRAGMA wal_autocheckpoint = 2000;。

维护 worker 严禁在 20 会话活跃期运行全量 VACUUM。定期仅执行轻量级非阻塞 PRAGMA wal_checkpoint(PASSIVE);。

优先级 5：出带宽测算表与部署配置参数（对应问题 5）
测算基准

数据传输：1 Mbps=125 KB/s≈0.1192 MiB/s。

并发模型：20 会话同时进入组前准备阶段，同时发起下载。

工程有效利用率：按 70% 计算（计入 TCP 慢启动、TLS 握手、HTTP 头开销以及 20 个并发流竞争引入的拥塞控制退避）。工程耗时公式：T
eng
	​

=T
ideal
	​

/0.7。

1–5 Mbps 出带宽下载耗时矩阵（20 会话全并发）
出带宽	20 人各下载 1 MiB (总计 20 MiB)	20 人各下载 5 MiB (总计 100 MiB)	工程可行性与部署评估
1 Mbps	

理论: 167.8 秒




工程预估: ~240 秒 (4 分钟)

	

理论: 838.9 秒




工程预估: ~1200 秒 (20 分钟)

	不推荐。被试流失风险极高，易超出大多数浏览器连接与心跳上限。
2 Mbps	

理论: 83.9 秒




工程预估: ~120 秒 (2 分钟)

	

理论: 419.4 秒




工程预估: ~600 秒 (10 分钟)

	仅允许用于 1 MiB 以下微型实验，5 MiB 资产不可用。
3 Mbps	

理论: 55.9 秒




工程预估: ~80 秒 (1.3 分钟)

	

理论: 279.6 秒




工程预估: ~400 秒 (6.7 分钟)

	1 MiB 资产可平稳运行；5 MiB 需要在界面展示进度条提示受试者等待。
4 Mbps	

理论: 42.0 秒




工程预估: ~60 秒 (1 分钟)

	

理论: 209.7 秒




工程预估: ~300 秒 (5 分钟)

	1 MiB 体验良好；5 MiB 处于可接受临界点。
5 Mbps	

理论: 33.6 秒




工程预估: ~48 秒

	

理论: 167.8 秒




工程预估: ~240 秒 (4 分钟)

	推荐配置。兼顾 1–5 MiB 实验组准备吞吐与成本效益。
写入部署文档的推荐配置参数
Ini, TOML
# 部署建议参数: conf/experiment-runner.env

# 1. 外部带宽基准推荐: 5 Mbps (阿里云 ECS 固定带宽)
# 若受限于 1-2 Mbps 成本，必须在研究协议中强制限制单个 Group 的图片资产总和 <= 1 MiB

# 2. 客户端 (prepare.ts)
ASSET_DOWNLOAD_STALL_TIMEOUT_MS=15000     # 数据流空闲超时看门狗
ASSET_DOWNLOAD_FLOOR_SPEED_BPS=20480      # 保底下载速率 20 KB/s
CLIENT_CONCURRENT_DOWNLOAD_WORKERS=2      # 组准备并发流限制

# 3. 服务端 (SQLite & Writer)
SQLITE_WAL_AUTOCHECKPOINT_PAGES=2000      # 适度调大避免频繁隐式 checkpoint
SQLITE_BUSY_TIMEOUT_MS=5000               # 锁等待超时上限
REPLAY_BATCH_MAX_EVENTS=32                # 客户端单批 REPLAY 上限 (单事务批量落盘)
REPLAY_BATCH_MAX_BYTES=262144             # 单批次最大体积 256 KiB
MAINTENANCE_PASSIVE_CHECKPOINT_INTERVAL_S=60

本轮不确定性与工程边界提示

不可将磁盘标称与本地数据外推为主机容量：阿里云 ECS 标称系统盘 IOPS 2120 / 吞吐 106.0 MB/s 为块存储突发指标，不代表单线程 fsync(2) 的物理落盘耗时。在云盘虚拟化层上，单次 fsync 典型耗时在 1–5 ms 波动。必须以线上实际运行时的提交耗时为准，绝对不可在正式采集开启前跳过真机压测。

TCP 并发争抢非均匀性：20 个并发客户端在 1–5 Mbps 瓶颈处受各终端链路 RTT 差异影响，可能出现部分连接获得较多带宽、部分连接遭遇严重 TCP 退避。UI 侧必须具备单图进度指示，允许被试在组前准备阶段重试，严禁直接跳转失败。

gate 保持关闭：在正式主机的 20 会话全链路压测（包含高并发组前准备 + 组尾 REPLAY 冲顶）完成验证前，正式采集 gate 必须保持关闭。
