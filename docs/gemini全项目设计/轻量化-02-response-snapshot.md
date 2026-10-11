### 一、 传输层与流生命周期（`installJsonTransport`）静态审查

#### 1. 预算头与流式实测硬限的防御闭环

- **不可信头部攻击已被硬限截断**：
  - 若客户端恶意伪造极大的 `X-Uncompressed-Length`，正则 `^[1-9]\d{0,6}$` 配合 `> maximum_bytes (1MiB)` 会在 `onRequest` 阶段直接阻断（抛出 400/413），无法穿透至解压层。
  - 若客户端伪造极小的 `X-Uncompressed-Length`（如声明 100 字节，实际压缩体内含 500KB），`wire` 流在达到 1MiB 时通过 `Transform` 立即熔断；`output` 流在累计解压字节超过声明值 `limit` 时同步抛出 `DECOMPRESSED_LIMIT_EXCEEDED`（413），并在未满声明值提前结束时由 `flush()` 抛出 `DECOMPRESSED_LENGTH_MISMATCH`（400）。
  - 内存预占公式 `decodedLength(request) * 2 + wireBytes + stream_reserve_bytes + 1024`，即使在畸形报文场景下，其准入计费亦基于受限的上界执行扣减，配合全局并发硬限（最多 4 个并发解压任务），不会击穿预设的 `REQUEST_BUDGET`。

#### 2. Fastify Body Parser 与完整性校验时序

- **Parser 不会在完整性校验前提交**：
  - Fastify 内置的 JSON 解析器消费 `preParsing` 返回的流时，必须读取至 `output` 流发出 `end` 事件后才开始执行 `JSON.parse`。
  - `output` 流的 `end` 触发前，必先执行 `flush(done)`。若发生 CRC32 校验失败、流提前截断或解压字节与声明长度不一致，`done(err)` 会向流注入 Error，中断消费，请求直接进入 Fastify 错误处理流程，不会流向路由 Handler 或进入持久化层。

#### 3. 需注意的流边界隐患

- **`reply.raw.once('close', abort)` 与正向响应竞争**：
  - 在 HTTP/1.1 长连接场景下，正常响应发送完毕后，底层 Socket 触发的并不是 `reply.raw` 的 close，但在连接异常中断、客户端提前断开时会触发。若由于 Fastify 内部插件执行时序导致正向响应完成后 `close` 先于 `onResponse` 触发，`active.delete(request)` 具有幂等性（通过 Map 读取后清除），无二次释放风险。
- **`pipeline` 错误回调中的 `payload.resume()`**：
  - 代码中 `if (error) { reply.header('Connection','close'); payload.resume(); }` 是为了在解压出错时排空客户端上传管道，防止客户端 Socket 阻塞导致 4xx 状态码无法写回。
  - **隐患点**：若客户端此时正在上传极大体积的载荷，无界 `payload.resume()` 会将剩余数据持续读入黑洞，产生无谓的服务器带宽与 CPU 消耗。
  - **建议约束**：在调用 `payload.resume()` 之前，对 `payload`（即 `request.raw`）显式调用 `destroy()` 或挂载计数器；由于已设置 `Connection: close`，直接销毁底层套接字更为安全。

### 二、 客户端压缩传输（`prepareJsonPost`）静态审查

#### 1. 正则路由匹配与边界

- 客户端正则 `/^\/api\/participate\/sessions\/[^/]+\/(ingest|covariates)$/` 与服务端的路由模板正则 `/^\/api\/participate\/sessions\/:session\/(ingest|covariates)$/` 精确对齐。
- `json.length * 3 < JSON_TRANSPORT.threshold_bytes`（8192 字节）以 UTF-16 上界做前置轻量级判断，避免对必然不足 8KiB 的小型 Payload 调用 `TextEncoder.encode`，降低了无意义的 TypedArray 分配。

#### 2. 内存与重试复用约束

- 遇到网络抖动或服务端 429/503 时，上层网络重试队列若捕获到 `prepareJsonPost` 生成的包含 `ArrayBuffer` 的对象，必须**直接复用该二进制 Buffer 及其 Headers**，绝不可在退避重试时重复调用 `Blob.stream().pipeThrough(CompressionStream)`。当前设计允许在重试中复用同一 Buffer，避免了重复压缩消耗端侧 CPU。

### 三、 环境扩展（`environment-v1`）静态审查

#### 1. 权限状态并发查询（`navigator.permissions.query`）

- **API 行为与平台差异**：
  - 某些移动端浏览器（特别是 WebKit/Safari）的 `navigator.permissions` 实现不完整，查询部分权限名称（如 `'push'`, `'camera'` 等）会直接抛出 `TypeError`，而非返回状态对象。
  - **必须保留的约束**：每个权限的 `permissions.query({ name })` 调用必须包裹在独立的 `try...catch` 中，并在 `Promise.allSettled` 内受控超时。对于抛出异常的项，统一归类为 `unsupported`，超时归类为 `timeout`，正常返回但为 `prompt`/`denied` 的项如实记录，不得因单个权限查询失败导致整个环境采样被挂起。

#### 2. Navigation 阶段与 Paint 指标

- 采集数值型阶段（如 `responseStart`, `domContentLoadedEventEnd` 等耗时差值）以及 `first-paint` / `first-contentful-paint` 时，必须剔除所有 URL、路径、Query 参数及 Referrer，完全避免任何潜在的跨域重定向敏感数据进入只读环境快照。

### 四、 交互流（`interaction-v1`）与节点快照静态审查

#### 1. 派发优化与上下文采集

- **每个事件派发仅读一次 `target.getBoundingClientRect()`**：
  - 将原先逐个 Coalesced 样本重复测量收敛为一次主测量，消除了高频手势下严重的重排抖动；逐样本保留原生坐标、`pressure`、`tilt`、`twist` 以及修饰键，既保持了动力学特征的原始性，又降低了主线程开销。
- **DOM 节点截断标志（`nodes_truncated`）**：
  - 设定 1900 节点上限并显式记录截断状态是合理的保护屏障。心理学逐题页面节点通常在几十至数百之间，远未达到该上限；该硬限有效防御了被试浏览器因第三方插件注入大量 DOM 节点而引发的序列化内存膨胀。

#### 2. 快照去重与离散生命周期

- **高频与离散事件分离**：
  - 焦点（`focus`/`blur`）、显隐性（`visibilitychange`）、视口变形（`resize`/`visualViewport`）及屏幕方向变更均立即同步生成状态条目与快照，避免时序穿透。
  - 高频 `scroll`
