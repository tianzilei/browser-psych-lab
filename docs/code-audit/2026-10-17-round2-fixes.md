# 第二轮业务逻辑修复与验证（2026-10-17）

[第二轮审计](2026-10-17-business-logic-round2.md)确认的 L06–L09 已在当前工作区修复，随后于 2026-10-17 上线，见[部署与生产验证](../业务逻辑修复上线-20261017.md)。本页记录实现和本地回归。

| 问题 | 修复后的行为 | 回归证据 |
| --- | --- | --- |
| L06：缺失接管凭证仍显示已保存 | 服务端对账每次读取当前 custody，缺少事件返回 WAITING，忽略旧服务写下的缓存成功报告。客户端核验完整清单及每条凭证的身份、范围、接管状态和处置版本，缺失时从保留的 events 恢复 outbox，再用相同事件 ID、hash、raw 补传并重新确认。 | 真实 SQLite 备份回退后，第一次补传被人为拒绝，界面保持保存失败；重试成功后才显示保存完成。原文逐字节相同、outbox 清空、会话保持 TERMINATED。错误 hash、范围、custody、receipt ID、处置版本、清单及清理权限均被拒绝。 |
| L07：乱序诊断遗漏完成检查 | pending 重算变为 QUARANTINED 时追加诊断；finalize 同时检查实际事件的非 ACCEPTED 状态，覆盖历史遗漏诊断表条目的情况。 | 缺失前驱时 WAITING；合法前驱补齐后 ACCEPTED 并可用原 finalize 请求完成。错误前驱补齐后生成诊断、保持 WAITING，全部原始记录保留。 |
| L08：历史运行器方向冲突 | 新发行物在参与 canonical runner hash 的 runner-contract.json 中声明 ledger-entry-v1。HTTP 路由核验归档清单及合同摘要后，才向单写者提供绑定目标 runner hash 的升级能力。新客户端持久化稳定 entry_version；旧客户端、未声明能力的任务运行器及预检后变化的目标保留兼容入口版本。纯问卷无需运行器能力；同意书一致约束继续生效。 | 从真实历史 Git 快照构建旧服务与旧运行器，先用旧服务发布竖屏 A、横屏 B，再升级数据库和服务。在 A 入口重新作答保留 A，历史任务完整运行至 COMPLETED；本机已有 B 答卷没有被覆盖。新构建的跨版本问卷→任务流程仍升级 B 且只保留两份关联答卷。 |
| L09：准备容量错误污染答案同步 | 保留 100 条准备报告上限，到限返回未新增，不覆盖原报告，也不设置账本 failure。真实持久化错误继续按原规则处理。已有报告仍能同步，准备与任务流程可继续。 | 保存 100 条报告后，新增报告被有界拒收；原始报告完全相同且全部可同步。答案原文被服务端接管、drain 成功，终止对账和实际 loadRunner 导航均通过。 |

重答的入口能力来自服务端读取的冻结归档合同，不能通过提交 upgrade_runner_hash 请求字段自行声明。预检能力不参与用户请求的幂等身份；目标在预检后变化时保守回退，丢失响应后的重试仍返回已经创建的同一关联答卷。旧版已持久化的重答请求没有新增字段时保留其原请求形状。

本轮没有修改冻结协议、历史运行器字节、原始事件或已签发完成凭证。对账只恢复服务端缺失的本机原文，不把历史终止会话恢复为 ACTIVE 或 COMPLETED。容量到限仅停止新增准备诊断，仍执行设备准入检查。

## 实现与回归入口

- 对账与完成判定：`src/server/lab-store.ts`、`src/web/participant-api.ts`、`src/web/ledger.ts`。
- 归档入口能力：`scripts/release.mjs`、`src/server/runner-asset-policy.ts`、`src/server/lab-routes.ts`。
- [服务端单元回归](../../tests/unit/logic-round2.test.mjs)：8 项；归档合同校验同时扩展在 [runner-release.test.mjs](../../tests/unit/runner-release.test.mjs)。
- [浏览器集成回归](../../tests/integration/logic-round2.test.mjs)：4 项，自建临时 Vite、SQLite 和 Chromium，包含真实历史发行物构建与旧库升级。
- `npm run test:logic-round2` 执行集成回归，已加入 `npm run check`。需先构建当前发行物；历史构建只使用本机 Git 对象与已安装依赖。

原始缺陷日志保持不变。[原探针入口](2026-10-17-round2-repro.mjs)现验证修复后的正确行为，涵盖 13 项相关单元测试和 4 项集成测试；无需手动启动 Vite。两个审计入口均清除了传给子测试进程的 NODE_TEST_CONTEXT，避免从 node --test 调用时跳过嵌套测试。

## 验证结果

- `npm run typecheck`、`npm run build`、`npm run smoke`：通过。
- 全量单元测试：175/175 通过；最终服务端能力预检调整后，相关 13 项再次通过。
- 完整生产构建浏览器套件：68/68 通过。
- 完整运行器套件：16/16 通过。首轮有一条在共享前端文件更新触发 Vite 热重载时中断；该条单独复跑通过，随后代码稳定状态下整个套件通过，未调整测试断言或生产预算。
- 最终审计回归入口：13/13 项相关单元、4/4 项集成测试通过，见[回归日志](2026-10-17-round2-regression.log)。

```sh
npm run build
npm run test:logic-round2
```

若需连同相关服务端单元回归一起执行：

```sh
node --import tsx --test docs/code-audit/2026-10-17-round2-repro.mjs
```
