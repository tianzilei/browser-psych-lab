# 业务逻辑审计：第二轮（2026-10-17）

> 以下保留修复前的发现与证据。L06–L09 已修复，见[第二轮修复与验证](2026-10-17-round2-fixes.md)。原始缺陷日志保留；同名脚本已转换为验证正确行为的回归入口，会自行启动隔离开发服务器。

审计当前工作区，包含上一轮五项修复及其他已有未提交改动；HEAD 为 `fbab9710e1bc69ee355f37dee902f058ee3d1dce`。本轮重点检查终止对账、备份回退、乱序诊断、历史运行器与跨版本重答、准备记录的容量边界。

确认 **4 项问题：1 项 P1、3 项 P2**，用 5 个隔离探针复现。L08 是上一轮 L03 修复遗漏的旧运行器兼容边界。以下记录审计时的行为；该审计阶段只增加报告、复现脚本与证据日志。

| 编号 | 优先级 | 冲突 | 直接后果 |
| --- | --- | --- | --- |
| L06 | P1 | 对账允许缺少服务端接管凭证，客户端仍报告保存成功 | 恢复较早备份后，已有本机原文未补传，界面却显示“已有记录已保存” |
| L07 | P2 | finalize 只检查诊断表，遗漏待解析及后续隔离的诊断事件 | 带未解决完整性问题的答卷仍可变为 COMPLETED |
| L08 | P2 | 新入口保留旧账本键，历史运行器仍把该键当作协议版本 | 跨版本重答可在问卷要求横屏、进入任务却要求竖屏 |
| L09 | P2 | 准备诊断达到 100 条后，预期容量错误进入答案账本的永久错误标记 | 任务无法跳转，当前页面后续答案同步及中断对账一并受阻 |

## L06：缺少接管凭证仍被当成已保存

代码位置：[participant-api.ts:24](../../src/web/participant-api.ts#L24)、[participant-api.ts:40](../../src/web/participant-api.ts#L40)、[lab-store.ts:515](../../src/server/lab-store.ts#L515)、[lab-store.ts:83](../../src/server/lab-store.ts#L83)、[participant.ts:33](../../src/web/participant.ts#L33)。

`sync()` 只发送 outbox。事件收到 PERSISTED 后从 outbox 移除，本机 events 仍保留原文及旧 ACK；若服务端恢复到接收该事件之前的备份，正常 sync 不会重发这条记录。随后服务端 reconcile 无条件返回 RECONCILED，`receipts` 可以包含 null。客户端仅检查 status 与 cleanup_allowed，没有核验每条事件的当前接管凭证。

复现使用真实 SQLite Online Backup：先备份已经创建并认领的会话，随后接收一条修订并取得 PERSISTED；再用该备份创建恢复后的 LabStore，终止为 UNKNOWN_RUN。浏览器保留真实原文和原 ACK、outbox 为空。实际结果：

- 恢复后的数据库 `lab_raw` 为 0 条，reconcile 返回 `receipts: [null]`。
- 浏览器未发送任何 ingest 请求，却显示“本次作答已中断，已有记录已保存。”并提供重新作答按钮。
- 手动补传同一原文后，再次使用原 request_id 对账，仍返回缓存的 `[null]`；通用幂等逻辑把第一次 RECONCILED 当作最终结果保存了。

本机原文尚在，探针没有观察到删除；问题是缺失记录没有自动恢复，界面错误宣告服务端保存完成。建议对账按 event_id、hash、scope、custody 核验全部凭证，缺失时保持 WAITING 并补传保留的原文，确认后再显示保存成功。缺失报告不能缓存为不可更新的成功结果；历史补传应继续保留 TERMINATED 状态。

## L07：诊断链完整性没有完整进入完成判定

代码位置：[lab-store.ts:183](../../src/server/lab-store.ts#L183)、[lab-store.ts:185](../../src/server/lab-store.ts#L185)、[lab-store.ts:582](../../src/server/lab-store.ts#L582)。业务约束见[当前项目逻辑与设计优化](../当前项目逻辑与设计优化.md)，其中明确诊断问题仍影响正常完成。

初次摄取时，QUARANTINED 会生成 lab_diagnostics；RECEIVED_PENDING 不会生成。前驱补到后的重算循环只更新 lab_dispositions 与 lab_events，即使将 pending 改为 QUARANTINED，也不追加 diagnostic。finalize 只检查 `view.diagnostics.length`，没有核实事件的实际 disposition。

两个独立探针均先正确封存唯一问卷页，再插入独立 `d-ui-*` 诊断链：

1. sequence=1 的事件缺少前驱，返回 RECEIVED_PENDING / MISSING_PREDECESSOR，诊断表为空，finalize 返回 COMPLETED。
2. 子事件先到，先进入 RECEIVED_PENDING；父事件后到且被接受，子事件声明的父 hash 错误，于是变为 QUARANTINED / INVALID_PREDECESSOR_OR_CLOCK。诊断表仍为空，finalize 依然返回 COMPLETED。

因此完成状态受事件到达顺序影响；同样的非法前驱若在首次校验时可见，会生成诊断并阻止完成。建议完成判定覆盖未解决的实际处置状态，且初次判为隔离与后续重算判为隔离采用相同诊断规则。保留全部原始记录；正常乱序补齐为 ACCEPTED 后应仍可完成。

## L08：旧归档运行器使用了入口版本的方向限制

代码位置：[runner-loading.ts:6](../../src/web/runner-loading.ts#L6)、[participant-api.ts:43](../../src/web/participant-api.ts#L43)、[lab-store.ts:440](../../src/server/lab-store.ts#L440)。另核查上述 HEAD 的 `src/web/participant-api.ts`：其 open 在读取会话前调用 `requireOrientation(version)`，协议版本直接取导航参数。

上一轮为避免重答新建无关联会话，将进入任务的 URL 改为稳定入口键 A，新客户端会从本机 session.frozen.version_id 读取实际版本 B。但冻结运行器按历史代码执行，无法获得这项新行为。

复现没有修改或模拟归档运行器：从上述 Git 快照构建真实历史发行物，归档 hash 为 `01695e4d9eb5bdd5c0a64409f9763f4e68cde82aaf01253f071f928dcfb1b584`。A 版本要求竖屏，B 版本含任务且要求横屏，二者同意书相同。通过真实 HTTP 路由和 Chromium 执行终止、重答、进入任务：

- 重答选中 B，当前参与页请求 B 的 metadata，正确接受横屏。
- 新 loader 进入 B 的归档运行器，URL 保留 `?version=A`。
- 历史运行器请求 A 的 metadata，显示“请将设备调整为竖屏”，与 B 的冻结协议冲突。

该问题限定于使用不识别稳定入口键的旧归档运行器，且入口版本与重答实际版本的方向要求不同。上一轮使用全部新构建的跨版本测试未覆盖此条件。建议明确归档运行器的入口能力与版本兼容策略，在允许升级或导航前处理能力差异；不要通过改写历史运行器内容、覆盖另一份本机答卷来消除冲突。回归应保留真实旧构建。

## L09：准备记录容量错误阻断答案同步

代码位置：[ledger.ts:47](../../src/web/ledger.ts#L47)、[ledger.ts:62](../../src/web/ledger.ts#L62)、[preparation-report.ts:13](../../src/web/preparation-report.ts#L13)、[runner-loading.ts:25](../../src/web/runner-loading.ts#L25)、[participant-api.ts:24](../../src/web/participant-api.ts#L24)。

每份账本最多 100 条准备报告。第 101 次保存准备报告抛出 PREPARATION_REPORT_BUDGET_EXCEEDED；`serialized()` 把它记入 `this.failure`，`drain()` 此后持续抛出该错误。准备报告与答案共享此错误屏障，而 loadRunner 在跳转前等待 report.finish。

真实浏览器探针先保存 100 条合法准备报告，再调用实际 loadRunner：跳转失败。此后追加一条合法答案修订，本地 events 确有该事件，但 drain 仍抛出同一准备报告容量错误；API.sync 和 reconcile 都先调用 drain，因而无法继续同步。

这里的“持续”指当前 Ledger 实例：重载会重置内存错误，但已持久化的 100 条报告仍在，下次准备会再次触发。探针未观察到原始记录被删除。100 条上限本身可以保留；应把可预期的准备报告容量边界与答案持久化失败区分，明确到限后的准备行为，使已有答案、已有准备报告和终止对账仍可同步。

## 验证与复现

- 当前工作区 `npm run build` 通过。
- 相关基线单元用例 **30/30 通过**，覆盖上一轮修复、重答、导出、任务重放、准备报告。这是本轮定向验证，不是重新执行完整浏览器套件。
- 本轮审计探针 **5/5 成功复现错误行为**；通过不表示缺陷已经修复。

[探针脚本](2026-10-17-round2-repro.mjs)、[原始复现日志](2026-10-17-round2-repro.log)、[基线验证日志](2026-10-17-round2-baseline.log)。探针使用临时数据库和隔离 Chromium，不连接线上服务；L08 自动在临时目录构建历史快照并清理，不改动当前源码。

修复后，从项目根目录构建当前发行物并运行回归入口，无需另外启动 Vite：

```sh
npm run build
node --import tsx --test docs/code-audit/2026-10-17-round2-repro.mjs
```

可用 `AUDIT_BROWSER_ORIGIN` 指定专用 Vite 地址，`AUDIT_OLD_DIST` 指定已从上述历史快照构建的 dist 绝对目录，以省略历史构建。需要当前项目依赖、Chromium、Git 历史对象及 tar。

本轮基线命令：

```sh
node --import tsx --test tests/unit/logic-regressions.test.mjs tests/unit/interaction-reanswer.test.mjs tests/unit/export-results.test.mjs tests/unit/run-replay.test.mjs tests/unit/preparation-report.test.mjs
```
