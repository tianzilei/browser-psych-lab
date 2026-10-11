## 1. 全项目端到端闭环逻辑表

| 阶段 / 核心环节 | 参与模块 / 关键代码路径 | 状态转移与权威载体 | 失败模式与边界语义 |
| --- | --- | --- | --- |
| **协议编译与冻结发布** | `questionnaire-json.ts` -> `protocol.ts` -> `LabStore (study.publish)` | `DRAFT (draft)` -> 静态校验/资源绑定 -> `FROZEN (lab_versions)` | 引用不存在图片、题目无选项或校验不通过时直接拒绝；一旦发布写入 `lab_versions`，Schema/题目/时序预算永久只读不可变。 |
| **管理认证与越权防御** | `auth.ts` -> `server/routes/auth.ts` -> `LabStore (admin.*)` | `UNAUTHENTICATED` -> 单一口令加盐比对 -> `SESSION_COOKIE` + `CSRF_TOKEN` | 任何管理端写操作必须同源、校验 Cookie 与 CSRF Token；错误密码延迟防御，越权拒绝并记录操作日志。 |
| **方向 / 知情同意 / 环境** | `orientation-gate.ts` -> `consent-page.ts` -> `prepare.ts (refresh/storageProbe)` | `GATE_PENDING` -> 探测通过/同意授权 -> 允许拉取或建立会话 | 屏幕方向错误直接遮罩阻断；拒绝知情同意直接退出且**不建会话**；刷新率超出预算或存储事务超标直接拒绝进入实验。 |
| **建会话 / Web Lock / 栅栏** | `run.ts` / `participant.ts` -> `navigator.locks` -> `session.claim` | `NEW` -> 获取本地 Web Lock -> 写入服务端 `writer_id`, `writer_epoch` | 浏览器不支持 Web Locks/Crypto 直接报错；多标签抢占直接锁定；双写冲突时以 `writer_epoch` 单调递增隔离旧写入者。 |
| **整例准入 (Session Admission)** | `admission-gate.ts` -> `admission-queue.ts` -> `routes/participate.ts` | `ADMISSION_ACTIVE` (全局并发名额计数) | 超出 `SESSION_CONCURRENCY` 立即返回 409（Retry-After 1800s），**不排队**；无 `groups` 的纯问卷不占用此限额。 |
| **问卷分支与本地修订** | `survey-page.ts` -> `protocol.ts (evaluate)` -> 本地 `SessionStorage` | 响应式条件计算 -> `answers` 实时维护 -> 翻页前本地持久化 | 题目未答完整阻止前进；文字超长/正则不匹配高亮拦截；输入法组合态（`compositionstart`）挂起分支求值。 |
| **方案抽样 / 准备锁 / 图片准备** | `trial-sampling.ts` -> `preparation-gate.ts` -> `asset-download.ts` | `RESERVED` -> 排队获取 `PREPARATION_TICKET` -> 串行流式下载解码并校验 SHA-256 | 准备队列超出并发时轮询等待（带票据续期）；图片 Hash/尺寸不符立即熔断；解码字节超出 `max_decoded_bytes` 抛错。 |
| **固定刺激与动态补测** | `run.ts` -> `runner-input.ts` -> `run-replay.ts` -> Canvas RAF 循环 | `STAGED` -> `ONSET` -> `WINDOW` -> `WINDOW_CLOSED` (循环推进) | 掉帧（`LONG_FRAME`）或未承诺即呈现实时中止；漏答/按键无效根据策略动态排队重测，重放引擎推进义务集合。 |
| **图片评分任务** | `rating-run.ts` -> `ratingControls` -> `RunReplay` -> RAF 循环 | `waiting` -> `rating` (按轴/按年龄填写) -> `isi` -> 下一刺激 | 连续 120 秒无交互判定 `USER_IDLE_TIMEOUT` 中断；视口变形、页面切后台立即触发 `VISIBILITY_OR_GEOMETRY_CHANGED` 中断。 |
| **本地账本 / 增量补传 / 凭证** | `ledger.ts` (IndexedDB) -> `network-queue.ts` -> `routes/participate.ts (ingest)` | 写入 IDB `events/outbox` -> 批量网络传输 -> 服务端暂存并回传 ACK | 离线断网持续追加本地账本，网络恢复按 Hash 链向后重传；服务端接收后仅为托管状态（Custody），未封存。 |
| **分段封存 (Seal) 与会话完成** | `ledger.ts (closeScope)` -> `routes/participate.ts (seal/finalize)` | `INGESTED` (托管) -> 校验 Manifest/Hash 链完整 -> `SEALED` -> `COMPLETED` | 缺少事件条目拒绝封存；未满足前置 Seal 凭据调用 `finalize` 拒绝完成；全部完成写定 `session.state='COMPLETED'`。 |
| **任务中断与重答限制** | `taskLiveness` / 事件侦听 -> `ledger.append(ABORT)` -> `session.terminate` | `ACTIVE` -> 中断上报 -> `TERMINATED` | 中断保留已有封存段与暂存数据；凭据 `credential_hash` 永久锁定，阻止重复开立新会话刷新作答。 |
| **CSV 导出与字段映射** | `export.ts` -> `jobs.ts` -> 流式写入 CSV 文件 | `COMPLETED` 会话 -> 提取快照与时序指标 -> 生成只读静态导出包 | 发生过中断或数据不平的会话按策略降级标记；后台异步 Job 运行并生成完整 Manifest 与校验和。 |
| **冷热备份与双写恢复** | `backup.mjs` -> `backup.ts` -> `scripts/smoke.mjs` | 写入 WAL 暂存 -> SQLite 在线原子备份 -> 目标目录同步加密打包 | 备份过程中持写锁安全读，验证 `integrity_check`；异常宕机利用 WAL 崩溃安全直接无损回放。 |
| **容量限制与系统部署** | `deploy/browser-psych-lab.service` -> Caddy/Nginx -> `1c2g.conf` | 反向代理限流 -> Fastify 单进程 -> `better-sqlite3` 单写者循环 | 系统层 `MemoryMax=1024M/1536M`，连接排队超限直接 503/429 退避，避免内存溢出与级联击穿。 |

## 2. 系统核心不变量与模块权威状态剖析

### 2.1 数据状态语义：`Custody` ≠ `Seal` ≠ `Completed`

- **Custody（服务端暂存/托管）**：客户端通过 `/ingest` 上报事件，仅代表事件物理字节已由服务端落盘至数据库并纳入链条记录，**不代表**作答有效性或逻辑完整性。此时允许断点续传和幂等重试（按 Hash 过滤）。
- **Seal（分段封存）**：由客户端显式提交 `Manifest`（包含范围内的全部 `event_id` 与 `hash` 序列），服务端独立校验 Hash 链的连续性、无分叉以及对应阶段义务（Obligations）的完备性。封存成功后该 `scope` 闭合，不可再追加事件。
- **Completed（整例完成）**：必须收集会话全链路所需的所有 `seal_id`（知情同意、问卷页、各刺激组），经校验完全覆盖方案要求后，会话状态才由 `LabStore` 转为 `COMPLETED`。未封存不可完成，已封存未完成仍可走恢复流程。

### 2.2 并发与准入控制：`SessionAdmission` ≠ `PreparationQueue`

- **SessionAdmission（整会话准入控制）**：面向“具有刺激/定时任务”的高开销会话生命周期。全局硬并发上限为 `SESSION_CONCURRENCY`。额满立即返回 HTTP 409（伴随 `Retry-After: 1800`），**不设服务端驻留队列**，防止大量客户端长轮询耗尽内存；无 `groups` 任务的普通问卷完全绕过此闸门。
- **PreparationQueue（静态资源准备队列）**：仅在会话已被准入后，在刺激呈现前下载大体积图片时生效，受 `PREPARATION_CONCURRENCY` 约束。此阶段**允许短期轮询排队（Ticket 机制）**，通过严格的单流/限流机制保护共享带宽与宿主机 I/O，下载完成后立即释放该票据。

### 2.3 任务执行模式：图片评分任务 ≠ 固定时序任务

- **固定时序任务 (`run.ts`)**：以帧级硬实时为目标。RAF 驱动、高频绘制、微秒级响应捕获、掉帧（`LONG_FRAME`）主动熔断；刺激呈现窗口固定，具备重测与排队机制；**全周期杜绝任何 HTTP 通信**以保时序纯净。
- **图片评分任务 (`rating-run.ts`)**：以认知评分与多维度输入为目标。依赖 DOM 控件与自绘制结合，允许用户滑动/输入并产生连续 UI 变更；包含空闲监测（120s）与失联保护，允许通过保活通道维护活跃状态，其结束语义依赖用户显式提交而非被动时钟窗口到达。

## 3. 架构优化与演进优先级划分

### 3.1 立即实施（最高优先级：保障数据一致性、崩溃恢复与防伪造）

1. **统一运行时超时与心跳常量基准**：消除不同模块间分散的数字字面量，固化失联判断契约。
2. **严密化 Worker 进程接管判定**：消除“心跳假死即接管”带来的双写撕裂风险，强制以系统级进程退出信号（`ESRCH`）作为接管前提。
3. **测试夹具与并发环境适配**：放宽 CI/并发压测环境中的冷启动超时，维持严格的失败判定语义不变。
4. **运维与容量文档纠偏**：明确并发默认值与限流语义，防止运维人员将实验室压力测试极限值当做默认生产配置。

### 3.2 真实触发证据驱动（次高优先级：仅在压测日志或监控告警中复现时实施）

1. **IndexedDB 大批量写入事务合并**：当高频输入诊断事件（如拖动采样轨迹）造成本地帧率扰动时，再行调整批处理阈值，不做盲目微优化。
2. **长任务 CSV 流式导出分块内存优化**：仅当单批次会话规模导致 Node.js 堆内存超过预警水位（如 >750MB）时，再改造为只读数据库游标逐行拉取模式。
3. **网络重试退避动态抖动微调**：仅当高并发模拟中网关 429/503 出现共振重试尖峰时，才介入调整重试退避公式中的随机范围。

## 4. 拟实施改进方案讨论与批判

### 4.1 方案 A：建立共享 `TASK_ACTIVITY_POLICY`

- **设计批判**：
  - **合理性**：原实现中 120s 空闲、300s 失联、60s 续活与 30s 扫描分散在客户端 `taskLiveness`、服务端会话扫描逻辑以及文档说明中，存在“实现漂移”风险。抽象出单一不可变契约常量完全必要。
  - **边界处理与防御**：
    - `taskLiveness` 触发超时后必须立即解除所有 DOM/网络监听，通过状态位确保其自身清理幂等，且只调用一次终止回调。
    - 对晚于终止事件到达的保活请求（Activity Response），客户端必须直接丢弃，严禁反向唤醒已停止的任务状态。
    - 契约校验上，**未知策略必须拒绝**。如果声明了客户端未知的 `task_activity` 协议标识，说明版本不匹配，应显式终止会话，不可宽容放行；而对完全未携带该字段的旧版协议，保持向下兼容走无策略分支。
  - **影响评估**：不改变既有二进制与时序行为，消除了策略割裂隐患。

### 4.2 方案 B：严密化 `db-worker` 属主接管逻辑（严格依赖 `ESRCH`）

- **设计批判**：
  - **必要性与深层风险**：原代码依靠“心跳停顿 > 30s”允许新 writer 接管旧属主是极其危险的设计。在 GC 停顿、宿主机 CPU 瞬时抢占或重度 I/O 阻塞下，旧进程 PID 可能依然存活并在恢复后执行写操作，导致 SQLite 遭遇并发写锁争抢或 WAL 损坏。
  - **改进措施**：将接管逻辑收紧为“仅当 `kill(pid, 0)` 抛出 `ESRCH`（确认进程已消亡）”才允许接管。若进程存活但心跳超时，维持保护性自锁，新 owner 拒绝强行介入，必须通过外部服务管理组件（如 systemd）杀死旧进程后再行自愈。
  - **同实例替换约束**：同实例内的 `DatabaseWriter` 替换仍应严格依赖旧 Worker 发出的 `exitObserved` 确认，确保写线程退出与资源释放的因果序。

### 4.3 方案 C：更新状态矩阵与文档声明，纠正容量与 HTTP 认知

- **设计批判**：
  - **容量认知纠偏**：源码中的 `SESSION_CONCURRENCY=2, PREPARATION_CONCURRENCY=1` 是单机冷启动的保守下限防线；压测产出的“并发 7”是特定 ECS 规格与特定刺激素材下的测试产物，不能通用化。在文档中强调 409 快速失败和非刺激问卷不限流，能够防止部署配置错误。
  - **“零 HTTP”语义澄清**：必须在架构文档中准确定义：经典固定刺激呈现任务（`run.ts`）在进入试次循环后严格保证零 HTTP 交互；而图片评分任务中引入的 `activity` 交互属于控制层面的低频小型保活包，二者运行模式不同，不能以“零网络”概念混为一谈。
  - **测试夹具调整的合规性**：在 `tests/helpers/fault-writer.mjs` 等测试夹具中，冷启动 1000ms 超时在密集并发测试中偶发超时，属于测试基础设施调度抖动。将准备阶段的启动超时放宽到常规预算，而在启动完成后严格执行 150ms 故障断言，既能提升测试套件的抗抖动能力，又未放宽生产环境的时序断言与安全标准。

## 5. 潜在破坏性风险审查与替代方案

### 5.1 旧冻结版本协议兼容性审查

- **受影响文件**：`src/server/lab-store.ts`, `src/web/participant.ts`, `src/shared/protocol.ts`。
- **潜在风险**：如果在协议层将 `task_activity` 列为必填校验项，会导致历史数据库已发布的冻结版本（如 `lab_versions` 中的老记录）在被反序列化或执行校验时崩溃（`INVALID_PROTOCOL`），造成已归档研究无法重放或无法导出的严重后果。
- **替代保证方案**：
  - 数据库中存储的协议结构保持向后兼容：当且仅当协议显式存在 `task_activity` 时，执行严格的模式匹配；若不存在该字段，则自动降级为 `legacy-no-activity` 逻辑，绕过动态失联检查，绝对不破坏旧记录的只读加载。

### 5.2 严格进程退出接管对无人值守运维的影响

- **受影响文件**：`src/server/db-worker.ts`。
- **潜在风险**：如果完全依赖 `ESRCH`，一旦旧 Worker 发生由于死锁导致的假死且未崩溃，系统将永久拒绝自动恢复，服务陷入不可写状态。
- **替代防御方案**：
  - 不能只在内部做被动等待。服务应配合 `systemd` 的 `WatchdogSec` 以及健康检查接口 `/api/health/ready`；当 Worker 发生假死时，健康检查立即返回 503，由外部监管进程发送 `SIGABRT`/`SIGKILL` 强制终止僵死进程产生 `ESRCH`，随后触发 clean restart，兼顾写操作互斥安全与自动化自愈能力。

DESIGN_SYNTHESIS_COMPLETE
