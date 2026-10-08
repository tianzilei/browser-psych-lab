Gemini 说
0. 第1轮合同修正与基准对齐

在进入数据库与并发规约前，先更正并固化上一轮讨论中偏离原始合同的要点：

SHA-256 是内容摘要（Digest），非签名（Signature），且绝对不可等同于 event_id：

event_id 是客户端生成的单调/唯一序列标识（如带会话前缀的单调序号或 UUIDv7）。

SHA-256 是对该事件规范化 UTF-8 原始字节流计算的内容摘要。

相同正文合法出现在不同 trial 位置时，拥有不同 event_id 但相同摘要；反之，若数据库中已存在某 event_id，但新载荷计算出的摘要与已存摘要不一致，判定为数据冲突违规，触发冲突归档并阻断，绝不覆盖。

客户端本地数据生命周期：必须到 SEALED 才能清理：

收到单条 HTTP 响应的 ACK，仅将客户端本地 Outbox 记录的状态标记为 ACKED。

在全任务完成核对并收到服务端的封印凭证（SEALED 状态且集合/位置/摘要三者校验一致）之前，客户端本地必须保留原始字节副本。未 seal 前严禁删除本地数据。

第二标签页（Second Tab）语义：

第二标签页进入即为只读（Read-Only）视图。

若用户在第二标签页显式触发“未知恢复”，协议动作是：吊销旧会话许可（Permit）、将原会话置为终止态（TERMINATED）、停止任何写入通道；绝不在第二标签页开启新的执行实例。

文件清理（Unlink）与故障语义：

文件系统 unlink 操作不具备跨系统事务原子性。当状态进入 DELETING 后执行系统调用：若 unlink 失败或进程崩溃，该记录停留在 DELETING 悬挂状态，留待人工或恢复检查处理；不能声称“任何故障都能安全回滚保留文件”。

私有资源（Research Assets）隔离：

私有素材库严禁被反向代理（如 Caddy/Nginx）作为公开静态目录无鉴权直出。

必须通过带有凭证验证（Admission Token / Permit）的受控端点提供，或由反代基于内部重定向（X-Accel-Redirect）在鉴权后转发。

时序日志高频精度与硬件现实：

高频输入与时序数据保留原始浮点毫秒值（performance.now() 的原始 IEEE 754 精度），或采用严格保留分数的定点整数编码，不可粗暴截断或取整为微秒整数，防止丢失子毫秒相对间隔。

浏览器 API（requestAnimationFrame、PerformanceObserver、HTMLImageElement.decode()）仅代表渲染管道的软件调度节点与解码完成，不代表屏幕物理像素光子发射（Physical Onset），也不保证 GPU 显存驻留永不被置换。所有日志字段必须显式命名为 software_onset_timestamp 并记录环境告警。

数据与度量声明规范：

后续出现的内存占用、延迟时间、超时参数及队列深度均为设计候选值或工程假设，必须在目标硬件（2核/2–4GB、目标云厂商物理盘/网络环境）上实测校准，不作无实测依据的绝对保证。

1. DB-Writer Worker 有限 RPC 协议、状态机与错误分类

为消除主线程事件循环阻塞，同时防止 MessagePort 内部无界缓冲引发内存与状态失控，主线程与专职 DB-Writer Worker 之间采用严格的单在途请求（Single In-Flight）受控 RPC 协议。

1.1 有限消息协议定义

主线程向 Worker 发送的消息，以及 Worker 返回的响应均采用扁平、严格受限的枚举结构：

[Main Thread] ──(MessagePort: Single In-Flight)──► [DB-Writer Worker]

请求消息（Main → Worker）

INGEST_EVENT：提交单个时序/问卷事件原始字节、元数据及摘要。

VERIFY_ADMISSION：校验准入凭据并原子核销预留名额。

UPDATE_SESSION_STATE：状态迁移请求（如推进至 STAGED、申请 TERMINATE、提交 SEAL 校验）。

QUERY_READ_SHORT：主线程无法避免的关键只读校验（仅限走写连接的最新一致性快照，非通用长查询）。

ADMIN_MAINTENANCE：数据库维护（触发主动 checkpoint、备份屏障标记；仅在空闲时段）。

DRAIN_AND_SHUTDOWN：通知 Worker 刷盘并安全退出。

响应消息（Worker → Main）

RPC_SUCCESS：携带事务提交成功标识、变更行数或返回的数据投影。

RPC_REJECTED：逻辑拒绝（如版本锁冲突、哈希不匹配、状态已终结），事务已显式回滚。

RPC_ERROR：底层错误（如磁盘 I/O 失败、数据库只读），事务已回滚或处于异常态。

1.2 主线程排队与背压契约
[HTTP 请求进入]
    │
    ▼
[主线程内存有限队列]
  - 深度上限: N_max (候选值: 30)
  - 累计字节上限: B_max (候选值: 2MB)
  - 满载判定: 若超过任一上限 ──► 立即返回 HTTP 503 + Retry-After (无写入接管)
    │
    ▼ (检查: 当前无在途 RPC 且 Worker 处于 IDLE)
[向 Worker 发送 1 个消息 (保持 raw bytes ArrayBuffer 副本，严禁 transfer 导致 detached)]
    │
    ▼
[等待 Worker 返回 或 RPC 超时 (候选值: 3000ms)]


同一 Session 严格定序：主线程队列内对相同 session_id 的请求严格遵循 FIFO 顺序出队投递。

终止优先与全局公平：会话主动终止（TERMINATE）属于控制指令，可在会话队列内优先提升，但不得越过当前正在 Worker 内部执行的物理事务。

原始 Buffer 保护：向 Worker 发送载荷时，主线程通过结构化克隆传递数据，严禁使用 Transferable Objects 转移 ArrayBuffer 的所有权，确保主线程在发生网络重试、校验或故障归档时，原始内存字节依然有效可用。

1.3 错误分类与责任归属
错误分类	触发条件示例	事务状态	对客户端响应	状态机动作与重试指导
VALIDATION_FAILED	载荷 SHA-256 不匹配、Schema 字段超限	未开始 / 已回滚	HTTP 400 Bad Request	致命错误；客户端不应自动重试，记录故障。
FENCE_REJECTED	writer_epoch 过期、凭据已被吊销、会话已处于 TERMINATED	在事务内校验失败回滚	HTTP 409 Conflict	客户端停止后续采集；本地 Outbox 冻结。
CAPACITY_REJECTED	主线程排队超深度/超字节、WAL 磁盘预算超标	未入队 / 未开始	HTTP 503 Service Unavailable	携带 Retry-After: 1；客户端按退避重试。
STORAGE_BUSY	Worker 遭遇临时锁争用超限	显式回滚	HTTP 503 Service Unavailable	携带 Retry-After；服务端保留重试查询能力。
TRANSACTION_UNKNOWN	RPC 调用超时、Worker 线程非正常退出/崩溃	完全未知	HTTP 500 / 504 Gateway Timeout	严禁假定未提交；客户端不得盲目新建 ID 重发，必须使用原幂等键重试状态对齐。
2. 生命周期规约：启动、关闭与重启

必须从机制上物理杜绝多写连接重叠（Dual-Writer Overlap），确保 WAL 文件与主数据库文件的绝对排他性。

2.1 启动步骤（Cold Startup）

主线程初始化：主线程启动，加载静态配置，但不开启 HTTP 监听端口。

派生专用 Worker：创建单一 DB-Writer Worker 线程，建立 MessagePort。

独占连接打开：

Worker 内部调用 better-sqlite3 打开数据库文件（读写模式），执行：

SQL
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000; -- 候选值，须测


自检与崩溃前滚恢复：

Worker 执行一次无害的读操作以驱动 SQLite 执行潜在的 WAL 故障恢复（Recovery Check）。

检查并清理上一次非正常停机残留的未决标记（如重置悬挂的临时任务锁）。

就绪握手：Worker 向主线程回复 READY 信号。

开放网络接口：主线程收到 READY 后，开启只读连接（备用）并启动 HTTP 监听，正式对外服务。

2.2 优雅停机步骤（Graceful Shutdown）

阻断新连接：主线程立即拒绝所有新入站 HTTP 请求（返回 503）。

清空主线程排队：等待主线程当前队列中已接纳但尚未投递的请求全部处理完成（设置硬超时，如 5 秒）。

下发终止消息：主线程向 Worker 投递 DRAIN_AND_SHUTDOWN。

Worker 终结化：

Worker 提交最后一个已接收的事务；

执行 PRAGMA wal_checkpoint(TRUNCATE);（若当前无并发读，尝试将 WAL 归零；若报错或有读占用，降级为 PASSIVE，严禁无限挂起）；

调用 db.close() 释放文件锁；

Worker 发出 SHUTDOWN_COMPLETE 并退出线程。

主线程退出：主线程确认 Worker 进程销毁，平稳关闭 Node.js 进程。

2.3 Worker 崩溃与隔离重启步骤（Crash & Restart Recovery）

当 Worker 遭遇未捕获异常退出、V8 OOM 或 RPC 响应超时时：

[Worker 异常退出 / RPC 超时]
           │
           ▼
1. 立即熔断主线程 HTTP 入口 ──► 新写请求统一返回 503 + Retry-After
           │
2. 状态判决: 将所有正在排队及当前在途的请求标记为 "UNKNOWN_OUTCOME"
           │
3. 确保旧 Worker 线程彻底死亡 (调用 worker.terminate() 并监听 exit 事件)
           │
4. 确认旧连接文件句柄被 OS 完全释放 (严格防范 Dual-Writer 重叠)
           │
5. 重新拉起新 DB-Writer Worker 实例
           │
6. 新 Worker 打开 SQLite 连接 ──► SQLite 内置 WAL 机制自动执行崩溃恢复
           │
7. 执行一致性自检查询 (核对最新未完成事务与幂等键表)
           │
8. 新 Worker 返回 READY ──► 主线程解除 503 熔断，恢复入站流量

3. 事务并发策略权衡对比

针对 synchronous = FULL 强持久化合同，比较三种不同写实现形态的工程边界：

评估维度	方案 1：HTTP 主线程短写（每次请求一事务）	方案 2：专用 Worker 短写（每次请求一事务）【推荐首版】	方案 3：专用 Worker 有界组提交（Group Commit）【备选演进】
系统架构复杂度	极低（直接本地方法调用）	中等（单在途 RPC、状态机隔离、Crash 重建）	极高（请求批次聚合、部分回滚隔离、微秒计时器）
主线程事件循环阻塞	严重（每次写事务卡住主线程若干毫秒的磁盘 fsync）	零阻塞（fsync 移入 Worker 线程，主线程只处理 IPC）	零阻塞（fsync 移入 Worker 线程）
稳态写入吞吐	受限于单线程串行 fsync 能力（极值低）	物理上限与方案 1 相当（磁盘物理 IOPS 瓶颈未变）	显著提高（单次 fsync 聚合多次写入，平摊磁盘同步开销）
长尾延迟（P99）	极高（网络、静态请求全被 fsync 堵住）	取决于 Worker 排队时长，但 HTTP 接入响应极稳	批次首个请求必须等待窗口闭合，存在固定底噪延迟
故障窗口与恢复语义	简单（事务原子性由进程生命周期覆盖）	明确（每请求独立事务，成功即提交，失败即回滚）	复杂（若批次内某条出现逻辑错误，需用 SAVEPOINT 分离，否则连带失败）
合同一致性	满足但破坏了高并发网络连通性	完美契合当前合同约束	需严格保证每条请求在物理 fsync 成功后单独发 ACK
结论

首版坚决采用“方案 2：专用 Worker 每次请求一短事务”。它在不增加复杂批量回滚与 Savepoint 隔离复杂度的前提下，将不可控的物理 fsync 系统调用彻底移出 Node.js 主事件循环，保护了 20 人并发期间的 HTTP 连接可用性。只有在后续真实物理盘压测中证明单次 fsync 吞吐无法满足 20 人突发峰值时，才在兼容采集请求（Raw Ingestion）中开启方案 3。

4. SQLite 锁等待、WAL 预算与作业并发管控
4.1 锁等待与 busy_timeout

busy_timeout = 3000ms 仅作为初始候选值。

若 Worker 执行写事务时遭遇文件锁阻塞（例如外部存在长读操作未释放），达到超时上限将抛出 SqliteError: database is locked。

处理策略：Worker 捕获锁超时后，立即中止当前事务并向主线程返回 STORAGE_BUSY。主线程拒绝盲目死循环重试，而是向客户端返回带有重试间隔的 503，保护 Worker 队列不被雪崩式阻塞。

4.2 WAL 磁盘预算与检查点（Checkpoint）防饿死

Reader 拖死 Checkpoint 的风险：长时间运行的只读查询（如大批量导出）会持有旧的 Read Transaction 视图，导致 PRAGMA wal_checkpoint(PASSIVE) 无法回收 WAL 文件的头部帧，引发 WAL 尺寸无界增长。

WAL 门控阈值（假设候选阈值，须基准测试）：

正常警戒线：WAL 尺寸 > 32MB。

严重阻断线：WAL 尺寸 > 64MB。

门控动作：

当 WAL 超过警戒线，Worker 在请求间隙尝试触发 PRAGMA wal_checkpoint(PASSIVE);。

若 WAL 达到严重阻断线且无法缩小，服务端立即停止准入新的准备工作和后台作业；

若磁盘剩余空间低于安全阈值，必须主动停止向客户端回复 ACK 并返回 503，宁可让被试停在本地等待，也绝不允许无磁盘配额导致的未定义静默截断。

4.3 导出、备份与重型作业隔离

全系统全局互斥：在任何时刻，最多允许一个重型后台作业运行（导出 CSV 或在线备份）。

轻量导出（首选）：导出任务由独立的 Read-Only Worker 在只读连接上启动短期只读快照（Read Transaction），分批流式提取（每批候选 500 行）写入暂存文件，物化完成立即释放读锁，后续压缩与清理工作不再持有数据库连接。

备份屏障（修订落地）：

源库写连接进入短暂屏障状态（拒绝结构变更）；

使用 better-sqlite3 原生 backup() 接口分步复制到独立副本库；

从副本库获取资源清单；

源库短事务写入持久化 BACKUP_PIN 记录；

释放屏障，异步校验并复制真实静态资产至独立归档区。

5. 必须落地的基准测试与监控指标

上线前必须在 2 核 / 2–4GB 目标服务器与目标文件系统上测定以下指标，以数据替换所有经验假设：

                    [必测指标闭环监控体系]
  ┌─────────────────────────────────────────────────────────┐
  │ 主线程指标                                              │
  │  - 主线程队列瞬时长度 & 累计字节占用                     │
  │  - Event Loop Lag (每秒采样，峰值不可超过 20ms)         │
  │  - 503 / 429 触发频次与恢复耗时                         │
  └────────────────────────────┬────────────────────────────┘
                               │ IPC 往返 (单在途)
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │ DB-Writer Worker 指标                                   │
  │  - 单次 BEGIN IMMEDIATE 到 COMMIT 物理持续耗时          │
  │  - 纯 fsync 系统调用阻塞时间 (ms)                       │
  │  - Lock Wait 耗时与 busy_timeout 触发计数               │
  └────────────────────────────┬────────────────────────────┘
                               │ WAL & 磁盘状态
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 存储与 I/O 指标                                         │
  │  - WAL 物理文件大小与 Checkpoint 成功率/步进帧数         │
  │  - 磁盘 I/O 队列深度与利用率 (iostat %util)              │
  │  - 20 并发同 NAT 穿透下单 IP TCP 连接数与保活表现       │
  └─────────────────────────────────────────────────────────┘

6. 关键故障恢复矩阵
故障场景	故障发生点	系统瞬时行为	客户端观察结果	状态保证与最终一致性契约
突发 20 人集中预加载	静态素材拉取	静态带宽打满，动态 API 排队	预加载进度条缓慢，但未报错	组前门控未全部完成前不推进；禁止任务中途拉取。
写入中途主机掉电	Worker COMMIT 物理 fsync 阶段	操作系统宕机，写入截断	连接断开，客户端请求超时未收到 ACK	重启后 SQLite WAL 自动前滚或丢弃未提交帧；客户端因未收到 ACK，保留本地副本并于恢复后重试。
Worker 进程死锁/Crash	事务正在执行	Worker 无响应，RPC 触发 3s 超时	客户端收到 HTTP 500 / 504	主线程杀掉 Worker 并安全重建；该次写入标记为 UNKNOWN；客户端必须带原幂等凭据重查。
第二标签页尝试并发	被试新开页面	主线程校验 Session Permit 冲突	页面强制弹出只读提示；禁止开始	吊销旧 Permit，旧会话立即转入 TERMINATED，绝不推进新进度。
重读阻断 WAL Checkpoint	CSV 导出 Worker 运行中	WAL 文件增长触碰 32MB 警戒线	管理后台告警，导出限速	主线程阻断新导出任务；优先保证前端采集写入；WAL 超 64MB 时停止新准入。
同 ID 异 Hash 冲突	恶意篡改或网络损坏	Worker 发现主键存在但摘要不符	收到 HTTP 409 Conflict	冲突记录存入隔离审计表，原始数据原样留存，拒绝状态跃迁。
7. 驱动选型与部署传输网络判定
7.1 SQLite 驱动技术选型：better-sqlite3 vs node:sqlite

在当前固定的 Node 24.21.0 环境下进行技术审查：

关键技术特性	better-sqlite3 (v13.0.3)	node:sqlite (Node 24 内置)	保守选型结论与事实依据
API 稳定性	生产成熟，多年广泛采用	Experimental（带有实验性特性警告）	不应在严肃科研生产环境依赖处于实验阶段的核心存储驱动。
Online Backup API	原生完整支持 db.backup(...)，可分步执行并获取进度	未暴露底层 sqlite3_backup_* 绑定	一票否决。本项目依赖该能力实现无锁阻断的热备份。
事务与 Savepoint	经过深度优化的 db.transaction() 函数级包装，安全自动回滚	需手动拼接 BEGIN / COMMIT SQL 语句执行	原生包装减少人为事务逃逸与未关闭泄露风险。
BLOB 与 Buffer 处理	深度集成 V8 原生 Buffer，极低开销直接读写二进制流	基础 TypedArray 支持，性能边界未充分压力校验	本项目依赖原始 UTF-8 BLOB 不解析直接持久化。
编译依赖性	需要 C++ 编译环境（node-gyp / prebuild）	零外部编译依赖，随 Node.js 原生分发	node:sqlite 唯一优势在安装分发，但无法弥补关键功能缺失。

明确选型：维持 better-sqlite3 13.0.3。
依据：截至 Node 24.21.0，node:sqlite 仍缺乏生产级 Online Backup API 支持，且处于实验状态；在科研数据“不可静默丢失”的强约束下，选用功能残缺且未经生产长周期检验的内置实验模块存在不可接受的系统性风险。

7.2 部署传输判定：本机 TCP vs Unix Domain Socket (UDS)

分析：UDS 固然能绕过 TCP 栈的环回开销，但引入了文件系统套接字权限管控、异常死机后的 .sock 僵尸文件清理、以及跨开发平台（如 macOS 开发机与 Linux 生产机）路径处理的一致性问题。

事实考量：在 20 名被试的集中并发规模下，本机 TCP（127.0.0.1:PORT）的环回网络开销在总请求延迟（尤其是磁盘 fsync 耗时）中占比不足 1%。

明确推荐：首版默认采用本机 TCP。保持链路透明简单，仅当面临多租户主机内部网络隔离审计时，才考虑启用 UDS。

7.3 Web 框架选型：Fastify 保留 vs Hono / node:http

分析：Hono 是现代 Web 规范驱动的优秀框架，但其在 Node.js 下的性能优势并不足以抵消从当前已配置妥当的 Fastify 5 迁移的技术负债。更重要的是，项目目前使用的 @fastify/static 等生态成熟中间件在 Hono 下需要重构或采用替代适配层。

明确推荐：坚决保留 Fastify 5。不需要进行任何框架迁移。当前架构的性能瓶颈在于磁盘持久化与客户端预加载控制，与 Web 框架层无关。

8. 协议自审与潜在缺口披露

对照原始科研合同，对上述设计执行自审，标出需要警惕的潜在缺口：

缺口 1：校园同 NAT 下的 IP 限流误杀

风险：若 20 名被试集中在同一实验室或同一校园 Wi-Fi 下测试，对外表现为单一局域网公网 IP。

防范规约：绝对禁止在接入层实施单纯的客户端 IP 频次熔断。限流策略必须以 session_token 为主键，仅将 IP 限流作为防范超大规模 SYN/DDoS 的宽松兜底限（如单个 IP 每秒允许 100 次突发）。

缺口 2：客户端 ArrayBuffer 内存占用与垃圾回收

风险：时序任务持续 100 个 trial，若客户端在 SEAL 前将全部原始数据保存在内存中，移动端可能触发浏览器标签页 OOM 崩溃。

防范规约：主内存中只保留当前正在写入的 Trial 数据；历史未封印数据必须写入 IndexedDB 磁盘持久层，内存中仅保留轻量索引。封印时流式读取 IDB 校验摘要，不得在 JS 堆内存中一次性组装几十兆的巨型字符串。

缺口 3：Worker 崩溃瞬间的幂等恢复盲区

风险：若 Worker 在执行完 COMMIT 之后、向主线程发送 RPC_SUCCESS 之前的几微秒内发生致命崩溃，主线程将向客户端返回 500/504，客户端判定为“未知状态”并尝试重发。

防范规约：客户端重发必须携带完全相同的 event_id 与正文摘要。新拉起的 Worker 在插入前执行幂等检查：若数据库已存在相同 event_id 且摘要完全一致，视为幂等命中，直接返回持久化成功的 ACK，不得抛出重复主键异常。

ROUND_2_COMPLETE
