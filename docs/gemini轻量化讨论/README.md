# Gemini 轻量化讨论记录

日期：2026-10-08。用户要求使用 Gemini_bridge 对当前项目每个部分寻找更轻、适合并发稳定性的方案。已完成四轮讨论。最终采用决策见[轻量化架构与并发稳定性决策](../轻量化架构与并发稳定性决策.md)；以下原文包括已否决、未证实或仍需修正的建议，不能直接当实施合同。

会话：[Gemini 原始讨论](https://gemini.google.com/app/bd5579d16e322d7a)。发送工具的等待超时不代表讨论失败；每轮通过新 conversation 快照获得匹配回复及 ROUND_N_COMPLETE 标记后记录，没有重复发送。

| 轮次 | 主题 | 输入 | 完整回复 | 请求 ID | 最终读取结果 ID |
| --- | --- | --- | --- | --- | --- |
| 1 | 13 模块筛查与候选比较 | [prompt](round-1.prompt.md) | [response](round-1.response.md) | req_38uI-ihLIbpXUd3hKswNTw | res_898257e6345b3833d35b |
| 2 | writer、背压、未知提交、导出/备份 | [prompt](round-2.prompt.md) | [response](round-2.response.md) | req_e-Ab4ztlcCct8CSi_o_LWA | res_1e2b7c4235476d4b2465 |
| 3 | 独立入口、时序/IDB、图片预算/格式/缓存 | [prompt](round-3.prompt.md) | [response](round-3.response.md) | req_HwtaiiZMyM9kFanEZqJj3w | res_87565a5e7da9dc0eb34e |
| 4 | 全栈取舍、合同、替换触发、实施顺序 | [prompt](round-4.prompt.md) | [response](round-4.response.md) | req_ZWvWIwKKyHbj4uFGbt6qew | res_9b9152245570ee350ad3 |

最终模型回复索引分别为 1、3、5、7。原文引用标签/性能数字未做逐条联网复核；本轮没有独立重复 Gemini 的资料搜索。最终决策明确拒绝没有实测依据的队列/内存/fsync/WAL/并发阈值和绝对保证。

工程测量原件：[foundation-before.json](foundation-before.json)、[foundation-after.json](foundation-after.json)。前后均为本机 TEST_ONLY 只读健康检查，200 次 GET、每波并发 20，不是参加者负载测试；文件尺寸采用同一 gzipSync 方法。生产依赖隔离安装/启动验证结果另见 [production-probe.json](production-probe.json)。

保留主设计原有 P0/P1/P2/P3/P4/P4B/P5A/P6 阶段，不采用第四轮的重新编号。原文也没有完成生产业务实施、真实 20 人容量、设备时序或联合灾备恢复验收。

## 阿里云 2c4g / 1Mbps 优化

用户指定 Ubuntu 26.04、系统盘 2120 IOPS / 106.0 MB/s，并在第二轮前明确选择 1Mbps 与排队机制。[本次会话](https://gemini.google.com/app/fd77451f54303ef7)另完成四轮；第三轮后按用户要求暂停，用户 `resume` 后完成兼容审查与后续落实。当前实现及验证见 [阿里云部署记录](../阿里云1Mbps部署与验证.md)。

| 轮次 | 主题 | 输入 | 完整回复 | 请求 ID | 完整结果 ID / 结束标记 |
| --- | --- | --- | --- | --- | --- |
| 1 | 硬件与现有路径优化 | [prompt](aliyun-review.prompt.md) | [response](aliyun-review.response.md) | bpl-aliyun-review-20261008-a | res_36e4d73d3d50b4aabc46 |
| 2 | 1Mbps FIFO 与准备预算 | [prompt](aliyun-queue.prompt.md) | [response](aliyun-queue.response.md) | bpl-aliyun-queue-review-20261008-b | res_a074adefd358cbd38fa1 / ALIYUN_QUEUE_REVIEW_COMPLETE |
| 3 | 实际队列/下载/压缩代码 | [prompt](aliyun-queue-code.prompt.md) | [response](aliyun-queue-code.response.md) | bpl-queue-code-review-20261008-c | res_827b954cdeac9205dd95 / QUEUE_CODE_REVIEW_COMPLETE |
| 4 | 旧冻结运行器升级与生命周期 | [prompt](aliyun-legacy.prompt.md) | [response](aliyun-legacy.response.md) | bpl-legacy-assets-review-20261008-d | res_4771bbc46fd3a4084b75 / LEGACY_ASSET_REVIEW_COMPLETE |

采用有限超时/串行下载、真实流结束回收容量、精确票据 nonce、预压缩原代码身份核对，以及第四轮的同摘要并发读取合并。队列/缓存有硬上限，失败结果不缓存。首轮并发带宽换算、已有批量写入/Promise.allSettled/只读重放的部分判断不适用；不采用鉴权前移、冲突忽略、未经测量的 fsync/checkpoint/吞吐保证。

第四轮将取消悬挂与未校验缓存污染称为“真实缺陷”，给出的代码并不支持该结论：等待拒绝进入外层 catch 精确释放，注册监听后也检查已取消状态，缓存只在身份和声明校验后写入。保留队列单元和真实 HTTP 断连回归，并实现其有效的减少重复读取建议；未据此声称外部规范已独立验证。第三轮“未发现 bug”也不代表全面生产验收。

本轮没有独立重复 Gemini 的外部资料搜索。实际代码回归与限速/混合测量保存在项目内，不能替代目标 ECS、真实设备、独立备份恢复与正式容量证据。

## 整例并行 1–2 例与等待序列

用户最新要求以整个参加者会话为单位同时 1–2 例。完成 [会话准入审查](https://gemini.google.com/app/a7735975adb94979)：[完整输入](session-admission-review-prompt.txt)、[完整回复](session-admission-review-response.md)。请求 `bpl-session-admission-review-20261008-e` 的发送等待超时并处于 PENDING_VERIFICATION，没有重复发送；后续新快照 `res_87a6c262a0afdaa623e2` 返回匹配输入、完整回复和 `SESSION_ADMISSION_REVIEW_COMPLETE`，据此记录完成。

回复提出四项疑点，代码取舍如下：

| 疑点 | 处理与证据 |
| --- | --- |
| ISSUED 不超时释放导致排队停止 | 保留占位是既有合同；未知运行必须明确终止，不能为放行自动猜测旧运行结束。重启/跨租约和 UNKNOWN 终止放行测试通过 |
| 过期重连失去原序位 | 有效租约内刷新保持 ordinal，超过 5 分钟失联或主动退出后重新加入排队尾；回收后不能抢回已释放的名额。浏览器刷新/退出重排和单元过期测试通过 |
| 票据轮换踢出活动页 | 新页面接管票据用于防止旧页面迟到释放；合法产品入口先获取浏览器独占锁，第二标签只读且不轮换票据。API 仍需 Cookie，业务仍核对 writer/permit；不把票据当独立身份认证 |
| 409 造成入队回滚 | 当前 `LabStore.execute` 在 immediate 事务内返回 Rejection，提交后才抛错；排队状态与拒绝已按该方式解耦。单元回归直接调用 claim/reserve/permit/seal/finalize/preparation 后验证仍在队列且无 writer |

据此补强第二标签浏览器断言，保留现有占位与队尾重入语义。原文中的“真实漏洞”判断不自动作为已确认缺陷，也没有据此声称部署容量或外部资料已验证。实施、单例/双例与限速报告见 [会话排队与小规格部署](../会话排队与小规格部署.md)。
