请修正上轮综合答复中的这些与已提供源码不符的表述，并给出最终设计收敛，不再泛化猜测：
1. 实际文件为 src/server/lab-routes.ts、lab-store.ts、maintenance-worker.ts、src/web/session-gate.ts、participant-api.ts、ledger.ts；没有 server/routes/auth.ts、admission-gate.ts、admission-queue.ts、network-queue.ts、export.ts、jobs.ts、backup.ts、tests/helpers/fault-writer.mjs。请只使用54段中真实路径。
2. 当前 PreparationQueue 也已改为满额立即 PREPARATION_CAPACITY_FULL 409、Retry-After1800，没有FIFO或自动轮询排队。类/表名包含Queue是兼容命名，不代表现行排队。SessionAdmission与PreparationQueue仍分别约束整例与准备流。下载活跃票据续期≠等待队列轮询。
3. 新run.ts和rating-run.ts都会调用taskLiveness并发送activity。固定刺激只保证资源准备和组事件上传不在刺激循环里等待，不能声称全周期零HTTP；无activity的历史runner继续原冻结合同。
4. 问卷账本是IndexedDB，不是SessionStorage。Custody为已提交持久原始字节凭证，既可能ACCEPTED也可能RECEIVED_PENDING或QUARANTINED，不能说仅暂存或保证已入有效链。seal完成范围的exact-set-and-chain及相关重放；知情同意单独在lab_consents持久保存，没有知情同意seal_id。INPUT_DIAGNOSTIC独立作用域，不能以普通scope封存禁止一切诊断补传。
5. 中断后可reconcile并显式reanswer，新建有关联的session；原答卷保留。不能说credential永久锁死防止新会话。CSV覆盖所有会话状态，包括CREATED/ACTIVE/TERMINATED等，不能只导出COMPLETED。
6. 备份没有自动加密；不是DB和文件跨系统原子备份。流程是资源屏障→Online Backup完成→从副本取资源清单→源库核验登记BACKUP_PIN→释放屏障→复制校验实际文件→READY；恢复明确关闭collection gate。WAL/FULL不等于所有硬件宕机无损保证。
7. 软件RAF/时间戳不保证物理硬实时或微秒精度；第二writer可能破坏应用单写者契约，但SQLite多连接不必然导致WAL损坏，不采用这种夸张因果。
8. 不采用任意750MB性能阈值，也不直接添加WatchdogSec（没有sd_notify支持时不能仅凭此配置得到健康监督）。维持已有生产超时与恢复合同。
请给出：a)纠正后的完整闭环/权威状态表（15行左右，真实模块路径），b)共享活动策略、单owner接管、文档统一方案的最终采用与风险说明，c)最多4项后续设计演进，逐项列出触发证据和保留合同。控制在约1400汉字。结尾FINAL_DESIGN_COMPLETE。
