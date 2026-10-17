# 业务逻辑审计（2026-10-16）

> 以下为修复前的审计记录。五项问题已于 2026-10-17 修复，见[修复与验证记录](2026-10-17-logic-fixes.md)。原始探针日志保留；同名脚本现已改为验证修复后的行为，无需另行启动 Vite。

审计对象为当前工作区，包含已有未提交改动；基准 HEAD 为 `fbab9710e1bc69ee355f37dee902f058ee3d1dce`。覆盖协议导入、公开与准入、同意、单写者、问卷分支与封存、任务准备与许可、超时回收、重答、评分重放及导出。审计新增本报告、复现脚本和复现日志，未修改业务实现，未操作线上服务或真实答卷。

发现 **5 项可复现冲突：3 项 P1、2 项 P2**。P1 会阻断业务流程、错误终止答卷或破坏答卷关联，应优先处理；P2 涉及特定合法输入无法保存或派生指标失真。

| 编号 | 优先级 | 业务冲突 | 直接后果 |
| --- | --- | --- | --- |
| L01 | P1 | 问卷页允许 `g-` 前缀，HTTP 封存却以此前缀识别任务 | 问卷无法提交，错误作业进一步阻塞全局维护 |
| L02 | P1 | 任务组封存后停止 activity，但服务端继续据旧 activity 回收整个会话 | 在线准备下一组时也会被标为断线终止 |
| L03 | P1 | 重答升级冻结版本，本地账本仍挂在旧版本键下 | 进入新版本任务时另建无关联答卷 |
| L04 | P2 | 合法单题长度与每段题数没有共同满足单事件字节预算 | 合法完整答案无法生成最终快照 |
| L05 | P2 | 总改答次数跨评分项目比较数值 | 从未改答也会导出非零改答次数 |

## L01：问卷页与任务范围的命名规则冲突

代码位置：[lab-routes.ts:196](../../src/server/lab-routes.ts#L196)、[protocol.ts:151](../../src/shared/protocol.ts#L151)、[maintenance.ts:35](../../src/server/maintenance.ts#L35)。

协议允许问卷页 ID 为 `g-survey`。页面答案正常接管后，封存路由仅检查 `manifest.scope.startsWith('g-')`，便创建任务 REPLAY 作业，未先核实该范围是否对应实际 permit。

复现结果：合法问卷页的 `PAGE_SNAPSHOT` 被标为 `ACCEPTED`，随后 HTTP seal 返回 **500 / PERMIT_NOT_FOUND**，`page_index` 保持 0。该 REPLAY 作业被标为 `RECOVERY_REQUIRED`；全局唯一维护作业约束继续生效，后续导出、备份或其他任务组重放均报 `MAINTENANCE_BUSY`，需要显式维护恢复才能解除。

建议根据会话的冻结页面及实际 permit 判定封存类型，再决定是否重放。仅禁止新页面使用此前缀不足以修复已经冻结的合法版本。回归需通过真实 HTTP 路由覆盖 `g-` 页面，并确认不会创建维护作业。

## L02：组间正常连接仍被旧任务心跳终止

代码位置：[lab-store.ts:200](../../src/server/lab-store.ts#L200)、[lab-store.ts:587](../../src/server/lab-store.ts#L587)、[session-gate.ts:17](../../src/web/session-gate.ts#L17)。

客户端任务结束时停止 `taskLiveness`，之后在参与页或下一组准备阶段使用 admission touch 续约。服务端组封存将 permit 关闭为 `CLOSED_NORMAL`，但保留 `lab_task_activity`；超时扫描只检查会话 ACTIVE、writer epoch 及旧 `last_seen`，没有限定仍在执行的 permit。admission touch 也不会更新这个 `last_seen`。

复现使用两组文字任务：第一组经真实维护 worker 重放并成功 seal；随后每分钟调用 admission touch，均返回 ACTIVE。把测试时钟从 1000 推进至 301001 后扫描，得到 **session=TERMINATED、permit=CLOSED_NORMAL、diagnostic=CONNECTION_TIMEOUT**。

因此，受试者在线准备下一组、慢速下载，或者任务已做完但保存确认延迟超过五分钟，都可能丢失正常完成资格。终止状态不可逆，只能重新作答。

建议明确任务 activity 的生效阶段：在组正常封存的同一事务中停止该组监督，扫描时核实相应活动 permit；准备阶段继续使用自身准入与准备租约。需要同时覆盖组间下载、最后一组后的保存重试和仍在执行任务时的真实断线回收。

## L03：跨版本重答在进入任务时分裂为两份答卷

代码位置：[lab-store.ts:437](../../src/server/lab-store.ts#L437)、[ledger.ts:68](../../src/web/ledger.ts#L68)、[runner-loading.ts:5](../../src/web/runner-loading.ts#L5)、[participant-api.ts:35](../../src/web/participant-api.ts#L35)。

同意书相同的情况下，服务端重答会采用该研究的最新冻结版本 B。浏览器 `Ledger.restart()` 仍把新会话写在入口版本 A 的 IndexedDB meta 键下；进入任务时，`loadRunner()` 却跳转到 `run.html?version=B`。运行器按 B 打开账本，发现没有会话，于是执行 participant.create。

真实浏览器复现（开发运行器，接口由真实 LabStore 驱动）：

1. A 版本答卷终止，发布含任务的 B 版本。
2. 重答得到与旧答卷关联的新会话，并存入 A 的账本键。
3. 从 A 入口点击“准备任务”，页面跳转到 B 的运行器。
4. 实际新增第三份会话；第三份 `reanswer=null`，与旧答卷关联的新会话仍停在 `group_index=0`。

这会割裂问卷与任务数据、丢失重答关联，并可能占用两个任务名额。B 若包含前置问卷，运行器还会把这份新答卷送回问卷入口。

建议统一“本机答卷身份”与导航携带的身份，或者在重答时原子迁移账本及后续入口；若 B 键已有另一份答卷，应保留双方并显式处理冲突。回归应覆盖发布新版本后的重答→问卷→任务全流程，并检查只新增一份关联答卷。

## L04：合法答案超过最终快照的 128 KiB 限制

代码位置：[questionnaire-json.ts:35](../../src/shared/questionnaire-json.ts#L35)、[protocol.ts:184](../../src/shared/protocol.ts#L184)、[ledger.ts:77](../../src/web/ledger.ts#L77)、[lab-store.ts:160](../../src/server/lab-store.ts#L160)。

单个文本题可声明 `max_length=4000`，每段最多 30 题；自动分段仅考虑题数。最终一段所有答案必须放进同一条 `PAGE_SNAPSHOT`，而前后端单事件均限制为 128 KiB。

复现：12 道必答个人信息文本题，每题填 4000 个“中”。编译及 `pageSnapshot` 业务校验均通过，最终事件却为 **144544 字节，大于 131072 字节**，服务端拒绝 `HASH_OR_SIZE_MISMATCH`；真实客户端会更早被 `EVENT_BUDGET_EXCEEDED` 拦住。当前为最终快照预留 128 KiB 的段容量保护不能解决单个快照本身已经超限的问题。

建议导入时结合题数、各答案上限、UTF-8 编码、JSON 转义及信封开销，保证一段的最坏合法快照可写；新简化问卷可据此分段。冻结协议与已有证据仍应保持原值。回归至少覆盖多字节字符及需要 JSON 转义的长答案。

## L05：多项评分把项目切换计为改答

代码位置：[rating-replay.ts:50](../../src/shared/rating-replay.ts#L50)、[rating-replay.ts:51](../../src/shared/rating-replay.ts#L51)。

各项目的 `rating_item_times[].changes` 按 item 分组计算，而总 `change_count` 把所有项目的选择放在一起，仅比较相邻数值是否不同，没有检查 item 是否相同。

复现：三个项目分别只选择一次 1、2、3，然后提交。逐项目改答次数为 **[0,0,0]**，总改答次数却为 **2**。因此结果依赖不同项目的评分差异，而不是受试者是否修改答案。此值会进入重放结果及完整数据导出的 `trial_results`。

建议把总改答次数定义为逐项目改答次数之和；首次选择只计作首次选择。需要覆盖跨项目首次选择不同、相同，以及每个项目独立反复修改三种情况。

## 验证与复现

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run test:unit`：154/154 通过。
- 现有 Chromium 浏览器用例 67 个、运行器用例 15 个均已验证。首轮并行执行争用默认 `test-results`，造成 2 个浏览器用例及 1 个运行器用例在收尾阶段报 trace 文件 ENOENT；这 3 个用例改用独立输出目录复跑，分别 2/2、1/1 通过。
- 新增审计探针：5/5 均成功复现上述缺陷；这些探针断言的是当前错误行为，成功不代表缺陷已修复。

可执行探针：[2026-10-16-logic-repro.mjs](2026-10-16-logic-repro.mjs)；原始结果：[2026-10-16-logic-repro.log](2026-10-16-logic-repro.log)。探针只使用临时数据库与隔离浏览器。

从项目根目录启动专用开发服务器，再在另一终端运行探针：

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5189 --strictPort
```

```sh
node --import tsx --test docs/code-audit/2026-10-16-logic-repro.mjs
```

可通过 `AUDIT_BROWSER_ORIGIN` 指定已有专用 Vite 服务地址。修复后应将探针转换成断言正确行为的回归测试，再验证冻结历史版本兼容。
