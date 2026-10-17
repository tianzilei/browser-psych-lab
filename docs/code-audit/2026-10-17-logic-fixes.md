# 业务逻辑审计修复与验证（2026-10-17）

[前一日审计](2026-10-16-business-logic.md)提出的 L01–L05 均已修复。实现基于原有工作区继续修改，没有重置已有未提交工作，也没有修改线上服务、冻结运行器文件或历史原始答卷。

> 第二轮审计补充：L03 的新构建跨版本流程已验证，随后发现的旧归档运行器方向门禁缺口 L08 现已通过明确的入口能力检查修复，见[第二轮修复与验证](2026-10-17-round2-fixes.md)。旧归档运行器的验证使用真实历史发行物；下述新构建回归只代表其自身覆盖范围。

| 问题 | 修复后的行为 | 回归证据 |
| --- | --- | --- |
| L01：`g-` 页面误触发任务重放 | HTTP seal 先向会话存储核实当前页面、已存在的 seal 或实际 permit，只有真实未封存任务才启动重放。不存在的范围在创建维护作业前拒绝；重复 seal 直接复用原凭证。 | 真实 Fastify 路由提交 `g-survey` 成功，重复提交凭证相同，维护作业数始终为 0；无 permit 的范围返回 409。 |
| L02：组结束后旧心跳误终止会话 | 正常组 seal 在同一事务清除任务 activity；扫描清理没有匹配 ISSUED permit 的历史 activity。任务本机封存后，保存阶段建立 admission 续约，当前 writer 的续约可证明连接仍在，输入空闲监督已停止。 | 最后一组保存、组间准备以及旧 activity 行的升级场景均不会误终止；保存中的当前 writer 可续活，其他 writer 不能续活，真实断线仍按原策略终止。 |
| L03：跨版本重答拆分答卷 | 冻结运行器仍按答卷协议选择，但导航参数继续使用原本机账本与 Web Lock 的入口键。恢复时从账本内会话读取实际冻结版本，用于方向及同意书检查。 | 真实浏览器完成旧版本中断→发布新版本→重答→方向门禁→问卷→冻结任务→最终完成，研究始终只有旧、新两份关联答卷；进入任务没有新增 create 请求。 |
| L04：合法答案快照超限 | 新简化 adaptive 源同时按题数和最大合法序列化字节数分段，包含文本 JSON 转义、UTF-8、选项、多轴答案、标识与信封开销。显式 study-v1 / single 页面或新发布版本超限时提前拒绝。 | 12 道 4000 字符文本题自动拆为 3 段，中文、NUL、引号、反斜杠答案均可接管、逐段封存和完成；最大长度标识与长小数时钟也在上界内。 |
| L05：项目切换计作改答 | 总 `change_count` 为每个评分项目内部改答次数之和。首次选择不计为改答。 | 不同项目首次选择 1/2/3 或相同值时，总次数均为 0；原有六项目各改一次的用例总次数为 6。 |

## 实现入口

- 服务端范围判定及超时处理：[lab-routes.ts](../../src/server/lab-routes.ts)、[lab-store.ts](../../src/server/lab-store.ts)。
- 本机身份、冻结版本门禁及保存续约：[runner-loading.ts](../../src/web/runner-loading.ts)、[participant-api.ts](../../src/web/participant-api.ts)、[consent-gate.ts](../../src/web/consent-gate.ts)。
- 快照上界与新源分段：[snapshot-budget.ts](../../src/shared/snapshot-budget.ts)、[questionnaire-json.ts](../../src/shared/questionnaire-json.ts)、[protocol.ts](../../src/shared/protocol.ts)。
- 评分指标：[rating-replay.ts](../../src/shared/rating-replay.ts)。

新预算校验不会改变 `parseProtocol()` 对旧协议的归一化或哈希。已冻结的超限页面保留原 ID、原内容和原始事件；需要按新规则重新导入、发布版本才能使用新的分段。既有 TERMINATED 状态、历史 CSV 和已归档的派生结果不被重写；新导出的重放结果使用修正后的改答计算。

## 验证

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| 生产构建、预压缩与发行清单 | 通过 |
| SQLite smoke | 通过 |
| 完整单元测试 | 167/167 通过 |
| 主 Chromium 浏览器回归 | 68/68 通过 |
| 独立运行器回归 | 16/16 通过 |
| 修复专项入口 | 13 项单元回归及 1 项完整跨版本浏览器回归通过 |

两套浏览器测试使用各自独立输出目录。单元测试中的原始协议哈希、原始事件链、幂等凭证、真实断线回收与备份恢复检查继续通过。

专项单元用例位于 [logic-regressions.test.mjs](../../tests/unit/logic-regressions.test.mjs)，跨版本端到端用例位于 [lab.spec.ts](../../tests/browser/lab.spec.ts)。原审计脚本已改成运行修复后的回归断言；[修复专项日志](2026-10-17-logic-regression.log)与[修复前日志](2026-10-16-logic-repro.log)分别保留。

```sh
npm run build
node docs/code-audit/2026-10-16-logic-repro.mjs
```

该入口使用临时数据库，由 Playwright 管理独立服务，无需另开 Vite。
