针对你提出的采集扩展、交互事件流优化、Gzip 传输接入及轻量级哈希/长度缓存设计，结合项目当前“单进程、单 SQLite Writer、强防内存击穿、硬实时/时序可信、旧 Runner 绝对兼容”的核心原则，进行逐项设计挑战与边界审查：

### 一、 静态环境采样 (`environment-v1`) 扩展挑战与约束

#### 1. 遗漏的高价值、低成本、零权限信息

在维持“零授权弹窗、不侵犯隐私指纹（无 Font/Audio/Canvas 探针）、250ms 严格超时”的前提下，以下静态环境特征对心理学实验的行为有效性分析极具价值，且开销几乎为零，当前设计应补全：

- **输入设备与交互能力（Media Queries）**：
  - `window.matchMedia('(pointer: fine)')` / `'(pointer: coarse)'` / `'(pointer: none)'`。
  - `window.matchMedia('(hover: hover)')` / `'(hover: none)'`。
  - *价值*：用于严格区分鼠标、触摸屏还是触控板，判定被试物理输入模式比单纯依赖 `navigator.maxTouchPoints` 准确得多。
- **屏幕色彩与动态范围（CSS/Display）**：
  - `window.matchMedia('(dynamic-range: high)')`、`screen.colorDepth`、`screen.pixelDepth`。
  - *价值*：用于核验刺激呈现是否存在因 HDR/高动态范围色调映射引起的对比度与亮度偏移。
- **跨平台时序基准（Time Origin & Clock）**：
  - `document.timeline?.currentTime`、`performance.timeOrigin` 与 `Date.now()` 的瞬时比对差值。
  - *价值*：检测是否存在时钟漂移、休眠唤醒引起的时间基准偏移，确保跨设备事件绝对时间戳的对齐精度。
- **调度器与后台限流能力（Scheduler API）**：
  - `'scheduler' in window` 及 `navigator.scheduling?.isInputPending !== undefined`。
  - *价值*：诊断浏览器内核对主线程长任务和交互优先级的支持能力。

#### 2. 必须保留的约束

- **不可拉长主线程预算**：扩展字段全部只读原生同步属性（例如 `Intl.DateTimeFormat().resolvedOptions().numberingSystem`），异步探针（如 `getHighEntropyValues`、`estimate`）必须保持在单一的 `Promise.allSettled` 并绑定统一的 `AbortSignal.timeout(250)`，**严禁任何单一慢 API 阻塞环境采集完毕**。
- **保持 Schema 向后兼容**：新增属性必须全部定义为可选字段（Optional）；后端入库 `lab_consents` 或环境快照时只做 JSON 序列化存储，不因新增字段使旧版本的反序列化校验失败。

### 二、 交互采样与每帧快照 (`interaction-v1`) 优化挑战

#### 1. 帧合并 Snapshot（`queueMicrotask` -> `requestAnimationFrame`）的风险与漏洞

- **时序穿透漏洞（Microtask vs. RAF 的生命周期错位）**：
  - 如果将屏幕状态（DOM Rect / ComputedStyle）签名合并到 `requestAnimationFrame` 执行，在非刺激呈现期（如用户滚动或连续点击）可能发生：事件发生在 Frame N，但 RAF 在 Frame N+1 才执行计算。若在此间隔中 DOM 发生变化或样式重排，**快照记录的几何数据将落后于事件发生的真实瞬间**。
  - *必须的对策*：**显式状态跃迁事件必须同步捕获 Snapshot**。凡是伴随焦点转移（`blur`/`focus`）、可见性变化（`visibilitychange`）、视口调整（`resize`/`visualViewport.resize`）以及页面步进的事件，**必须立即同步执行一次 Snapshot 计算**；仅有高频连贯手势（如单纯的连续滑动/拖拽导致的非关键位移）才允许合并至下一 RAF，且合并项必须标明 `snapshot_epoch: 'deferred_raf'`。
- **Coalesced Events 的只读上下文陷阱**：
  - 优化为“每次派发事件只读一次 target/context”方向正确（能消除 90% 的重排测量），但需警惕：**Coalesced 事件的派发目标完全相同，但其坐标可能已经离开原元素范围**（例如快速划出按钮边界）。
  - *约束*：保留 `target` 初始矩形作为上下文，但对每一个 coalesced 样本，必须完整保留其独立的 `x, y, raw_timestamp, pressure, tiltX, tiltY, twist`，绝不能为了压缩数组抹去样本间的物理微小差异。
- **Lifecycle `pagehide` 刷 IDB 的不可靠性**：
  - 规范明确指出了“不保证页面销毁前最后事件上传”。在移动端（尤其是 iOS WebKit），`pagehide` 期间启动的异步 IndexedDB 事务可能会被系统挂起（Freeze）并随时随地被静默终止，导致事务未能提交。
  - *约束*：`pagehide` 只做同步状态清理并尽可能尝试调用 IDB 的 `put`；**绝对不能在 `pagehide` 里伪造完成状态**。服务端与重放系统必须以“会话终止 + 重新打开后执行 `reconcile` 恢复”为权威逻辑，未落盘的尾部非关键诊断事件允许自然遗失，不得阻塞页面卸载。

### 三、 服务端 Fastify Gzip 解压与内存预算漏洞挑战

设计中拟在 Fastify `onRequest` 接入自定义 Gzip 逻辑，必须防范以下严重的 DoS、内存逃逸与管道死锁风险：

#### 1. 内存预占放大与并发击穿漏洞

- **预占乘数放大过高**：
  - 你拟定的规则是：`onRequest` 预占 `decoded * 2 + wire + 1024`，在 1MiB 限制下，单请求瞬间预占可达 `2MiB + 1MiB = 3MiB`。在全局并发上限（例如 32MiB）下，仅 10 个并发 Gzip 请求就会直接触发服务端的 `REQUEST_BUDGET_EXCEEDED` 503 拒绝。
  - *精细化修正建议*：
    - Fastify 请求体解析器会将解压后的流读入内存 Buffer，故解压过程中并发存在的内存峰值实际上是：**压缩传输流缓冲 (Wire Buffer) + 解压流 (Zlib 内部 Chunk 缓冲) + 最终拼接的 Body (Decoded Buffer)**。
    - 预占公式应调整为：`wire_length + declared_decoded_length + 64KiB (zlib context)`。当且仅当解压完成且原始流销毁后，释放 Wire 部分的配额，只保留最终 Body 的内存占位。
- **解压炸弹与流式硬限（Streaming Bomb）**：
  - 客户端可能伪造 `X-Uncompressed-Length: 10000`，但实际上传一个展开后高达 100MB 的畸形 Gzip 载荷。
  - *硬性约束*：
    - 服务端使用 `zlib.createGunzip()` 必须挂载字节计数器变换流（Counting Stream）。
    - **在流传输期间累计解压字节**：一旦解压输出累积超过 `declared_decoded_length` 或绝对硬限 `1MiB`，**立即调用 `stream.destroy(new ContractError('DECOMPRESSED_LIMIT_EXCEEDED', 413))` 销毁流并切断连接**，绝不能等整个解压完成才校验长度。
- **Fastify 流管道生命周期泄漏与挂起（Socket Hang）**：
  - 在 `preParsing` 阶段替换请求流为 `gunzip` 流时，如果客户端中途 Abort（断网或取消请求），或者 JSON 反序列化解析失败，异步流可能未被正确关闭，导致底层系统文件描述符与 zlib C++ 上下文泄漏。
  - *硬性约束*：
    - 必须在 Fastify 的 `onClose`、`onError` 以及 `request.raw.on('close')` 中建立单一的清理屏障，确保在异常分支显式调用 `gunzip.destroy()` 并将原请求流也予以销毁。
    - 必须严格同步更新 Fastify 内部用于 Content-Length 校验的上下文，避免 Fastify 框架自带的 Payload 长度校验器因原头与解压后尺寸不一致而抛出未捕获的框架级 400 错误。

#### 2. 压缩阈值与退避策略取舍

- **8KiB 阈值与 87.5% 压缩率门槛合理性**：
  - 设定 `> 8KiB` 且 `gzip <= 原文 87.5%`（节省至少 12.5% 带宽）是极其理性的。小 JSON（1~4KiB）在 Gzip 包装头（Header + OS/CRC32 + Trailer 占约 18~20 字节）及 Huffman 字典开销下，传输收益极低，反而徒增移动端 CPU 发热和延迟。
- **重试重用同一 Buffer 的幂等性约束**：
  - 设计中指出“准备一次并在 503/429 重试重用同一字节/ID”。**该约束必须严格执行**：重试时禁止重复触发 `CompressionStream`，直接重放上一次已经生成的 `Uint8Array` 压缩切片，避免在重试风暴中浪费客户端 CPU。

### 四、 原始 Raw、SHA256 校验链与缓存方案的落地收敛

#### 1. 零重复哈希与长度缓存的严密性

- **客户端缓存**：
  - 在客户端内存对象中缓存 `event._utf8_byte_length` 和 `event._hash`。
  - *重要防线*：在写入 IndexedDB 时，**不得改变原有 IDB Schema 定义**（即不增加持久化字段，写入时只保留规范定义的属性，或者仅作为不可枚举的临时内存属性）。当从 IDB 读取旧版本或未缓存行时，降级使用 `TextEncoder.encode(raw).byteLength` 与 `crypto.subtle.digest` 重新计算。
- **服务端 SHA256 链路完整性不受压缩影响**：
  - 必须再次锁定不变量：**Gzip 仅仅是 HTTP 传输层的可选编码（Wire-level Transport Encoding），绝不是存储层编码**。
  - 服务端解压后取出的必须是完全未经修改的原始 `raw` 字符串或字节。入库 `lab_raw` / `lab_events` 时的 SHA-256 校验和必须基于**解压后的原始 JSON 文本**独立计算并与 Manifest 比对。
  - CRC32 仅由底层 Node.js zlib 原生层用于保证传输流的物理完整性；应用级的防篡改、因果序验证与 Custody 凭据**永久绑定于业务层 SHA-256 链**。

### 五、 最终设计执行清单（可直接落地）

1. **环境采集扩展**：新增 `pointer: fine/coarse`、`hover`、`colorDepth`、`timeOrigin` 零权限静态探针，统一纳入 250ms `Promise.allSettled` 超时门禁，字段全部定义为可选。
2. **交互快照解耦**：连续输入采样每帧合并且保留完整 coalesced 动力学参数；任何会导致布局突变的离散交互事件（焦点、方向、页面步进）强制**同步计算 Snapshot**。
3. **Fastify 解压管道**：
  - 仅限白名单路由（`/ingest`、`/covariates`）启用。
  - 严格执行“流式计数监控”：累积解压超标（>1MiB 或 > 申报值）立即 abort 销毁。
  - 预占预算调整为 `wire + declared_decoded + 64KiB`，并在请求结束屏障中双向清理 stream。
4. **编码与哈希**：客户端实例级共用单例 `TextEncoder`，内存临时缓存序列化字节长与摘要；传输压缩若不可用或未达标，无缝降级走纯文本，保证所有既有测试断言与历史 Runner 契约完全不受破坏。
