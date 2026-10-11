### 1. 纠正后的端到端闭环与权威状态表

| 环节 / 阶段 | 真实模块路径 | 权威载体与状态迁移 | 失败模式与边界语义 |
| --- | --- | --- | --- |
| **协议冻结发布** | `src/server/lab-store.ts`
`src/shared/protocol.ts` | `lab_drafts` -> 静态校验与资产绑定 -> `lab_versions (FROZEN)` | 校验失败或资产引用缺失直接阻断；发布后 Schema、预算与题目完全冻结只读。 |
| **管理认证校验** | `src/server/lab-routes.ts`
`src/server/auth.ts` | 口令加盐散列比对 -> 签署 Cookie 会话与 CSRF Token | 仅单一管理员凭证；写操作强制验证同源、Cookie 与 CSRF Token；口令错误实施延迟防御。 |
| **环境与设备准入** | `src/web/orientation-gate.ts`
`src/web/prepare.ts` | 屏幕方向门禁 + 刷新率/存储事务性能探测 | 方向不符全屏遮罩挂起；刷新率超出预算或 IDB 事务超标直接拒绝进入作答流程。 |
| **知情同意** | `src/web/consent-page.ts`
`src/server/lab-store.ts` | `lab_consents` 独立持久落盘（无对应 `seal_id`） | 拒绝则退出且**不创建**作答会话；同意后写入独立同意记录并继续会话生命周期。 |
| **会话建立与写栅栏** | `src/web/participant.ts`
`src/server/lab-store.ts` | 浏览器 Web Locks -> 写入 `writer_id` 与递增 `writer_epoch` | 缺少 Web Locks/Web Crypto 直接报错；多标签抢占被阻断；旧写者因单调 Epoch 被栅栏隔离。 |
| **整例准入** | `src/server/lab-store.ts`
`src/server/lab-routes.ts` | `SessionAdmission`（计数器，受 `SESSION_CONCURRENCY` 限制） | 满额立即返回 409（`SESSION_CAPACITY_FULL`，带 Retry-After 1800），**不设排队队列**；纯问卷绕过该限制。 |
| **问卷作答与账本** | `src/web/survey-page.ts`
`src/web/ledger.ts` | 答案由 `IndexedDB (events/outbox/meta)` 本地持久化维护 | 分支根据条件动态求值；翻页前执行本地 IDB 强约束写入；输入法组合态挂起求值。 |
| **资源准备限流** | `src/web/preparation-gate.ts`
`src/server/lab-store.ts` | `PreparationQueue`（计数器，受 `PREPARATION_CONCURRENCY` 限制） | 满额立即 409（`PREPARATION_CAPACITY_FULL`，带 Retry-After 1800），**不排队**；入选后轮询仅用于**活跃票据续期**。 |
| **资源拉取与解码** | `src/web/asset-download.ts`
`src/web/prepare.ts` | 串行流式拉取 -> SHA-256 校验 -> `ImageBitmap` 解码内存 | Hash 或像素尺寸与清单不符立即熔断；解码预算超出协议限制终止任务。 |
| **试次执行与活跃监督** | `src/web/run.ts` / `rating-run.ts`
`src/web/task-liveness.ts` | Canvas RAF 循环 + 后台低频 `activity` 控制请求维持活跃 | 刺激呈现与响应记录不在刺激呈现循环中等待网络；掉帧（`LONG_FRAME`）或超时（空闲120s/失联300s）触发中断。 |
| **事件托管 (Custody)** | `src/web/participant-api.ts`
`src/server/lab-store.ts` | `lab_events (raw BLOB)`：状态为 `ACCEPTED` / `RECEIVED_PENDING` / `QUARANTINED` | 客户端经 `/ingest` 上报原始事件字节落盘；Hash 重复则幂等忽略；不代表已入有效链。 |
| **分段封存 (Seal)** | `src/web/ledger.ts`
`src/server/lab-store.ts` | `lab_seals`：闭合特定 `scope`，校验连续 Hash 链与业务义务 | Manifest 缺少事件或链断裂拒绝封存；`INPUT_DIAGNOSTIC` 属于独立诊断作用域，不阻断主数据封存。 |
| **会话完成** | `src/server/lab-store.ts` | 校验方案所需全部组/页 `seal_id` -> `lab_sessions (COMPLETED)` | 存在未封存的必需范围时拒绝调用 `finalize` 完成会话。 |
| **中断与重新作答** | `src/web/participant-api.ts`
`src/server/lab-store.ts` | 会话标记 `TERMINATED` -> 经 `reconcile` 审查后允许 `reanswer` | 原答卷与已封存段物理保留；允许新建有关联的新会话继续参与，原凭证未永久锁死。 |
| **数据导出** | `src/server/lab-store.ts`
`src/server/maintenance-worker.ts` | 流式只读提取并生成 CSV 数据文件与 Manifest 描述文件 | 覆盖 `CREATED`、`ACTIVE`、`TERMINATED`、`COMPLETED` 等**所有会话状态**，并标注完整性标记。 |
| **冷热联合备份** | `scripts/backup.mjs`
`src/server/maintenance-worker.ts` | 资源屏障 -> Online Backup 副本 -> 校验清单与登记 PIN -> 复制未加密文件 | 释放写屏障后复制实际资源并落盘为 `READY`；恢复流程中明确重置并关闭 collection gate。 |

## 2. 拟实施小范围改进的收敛方案与风险把控

### A. 共享 `TASK_ACTIVITY_POLICY`

- **最终采用**：确立共享常量（保留 `idle120-offline300-v1` ID，固化 120s 空闲、300s 失联、60s 续活、30s 扫描周期），供客户端 `task-liveness.ts`、服务端 `maintenance-worker.ts` 周期检查及契约校验共同引用。
- **边界收敛**：`taskLiveness` 判定超时后立即注销监听并置起内部标志，确保自清理幂等且中断只发射一次；已停止状态下收到的延迟 HTTP activity 响应直接忽略；若客户端上报未知 `task_activity` 策略标识直接拒绝，无该字段的旧版本 Runner 降级保留为无策略历史合同。
- **风险防护**：旧版本冻结协议反序列化时不强制要求存在 `task_activity`，防止既有存档或回放因 Schema 字段断言失败而不可读。

### B. `maintenance-worker.ts` 单 Owner 接管与进程判定

- **最终采用**：收紧接管凭据。仅当通过底层系统探测发现旧 Owner 进程确已退出（如发信号返回 `ESRCH`）时，才允许新 Writer 实例建立所有权并更新登记。不再把“心跳停顿 > 30s”单方面视作退出依据。
- **边界收敛**：同一进程内的 `DatabaseWriter` 重建与替换，依然依赖旧 Worker 发出的 `exitObserved` 回调完成退出确认。
- **风险防护**：若进程僵死但未退出，新实例拒绝强行接管，避免破坏应用级单写者内存状态与序列一致性；系统恢复依赖外部监管服务终止僵死进程并触发重启。

### C. 文档与状态矩阵统一

- **最终采用**：修订 README 与文档体系，添加明确的状态/故障处理矩阵，给“FIFO 队列”相关历史描述添加已覆盖提示；说明 `SESSION_CONCURRENCY=2` 与 `PREPARATION_CONCURRENCY=1` 为单机安全基线，两类容量超限均执行 409 快速失败且不建队列；澄清“固定刺激组刺激循环内无阻塞网络等待，但组间准备、封存与保活仍存在控制请求”。
- **测试夹具收敛**：对内部 Writer 启动测试夹具，在冷启动并行阶段提供常规启动宽限预算，启动完成后严格保持既定 RPC 故障时限（150ms）及未知/未入库状态断言，不改动任何生产环境超时参数。

## 3. 后续设计演进规划

1. **会话清理并发事务降级**
  - *触发证据*：在高并发 `reconcile` 或批量释放会话时，数据库日志中频繁出现 `SQLITE_BUSY` 或写锁等待超时记录。
  - *保留合同*：保持 `LabStore` 串行执行写事务与单写者约束，仅优化非关键路径的单次清理批次粒度。
2. **下载票据短时重入宽限**
  - *触发证据*：弱网环境下，客户端由于瞬时抖动发生重连，导致续期请求与原票据释放产生竞争性 409。
  - *保留合同*：维持 `PreparationQueue` 满额 409 无等待队列语义，仅对同 Session、同 Writer-Epoch 的有效票据提供极短重入幂等窗口。
3. **导出文件分块流式写入**
  - *触发证据*：单批次包含数万条未完成及已完成全量会话时，导出任务执行期间进程 RSS 出现大幅异常尖峰。
  - *保留合同*：保留现有全状态导出字段规范与 Manifest 格式，仅将全量内存缓冲调整为底层游标分批拉取输出。
4. **离线断网重连自适应退避**
  - *触发证据*：长时间断网后大量客户端集中恢复网络，导致服务端入口 503/429 尖峰比率超过 5%。
  - *保留合同*：严格保留本地账本 Hash 链校验、幂等接收以及 `Custody` 状态机判定流转逻辑不变。

FINAL_DESIGN_COMPLETE
