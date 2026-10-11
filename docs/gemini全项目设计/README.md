# Gemini 全项目逻辑与设计讨论

> 归档说明（2026-10-11）：本目录的原始输入、模型回复和 JSON／测量原件保留原时点，不随文档同步改写。现行准入与并发以 [并发设计与容量验收](../并发设计与容量验收.md) 为准；旧 FIFO、组内零 HTTP、角色／数据库建议按本目录取舍阅读。

用户随后要求保持轻量化、扩大浏览器可用信息采集并采用低开销压缩/校验。后续实施见 [浏览器轻量采集与传输设计](../浏览器轻量采集与传输设计.md)，验证与测量见 [轻量化-validation.json](轻量化-validation.json) / [transport-profile.json](transport-profile.json)。后续记录独立于下文 109/37/5 的前轮基线。

后续三次讨论使用相同 Gemini 会话：`lightweight-design-20261011-01` / `res_930d6ad30a8e2f6258ac` 为设计挑战，`-02` / `res_fe4d5ba9dfed246563ff` 为代码输入后静态复审，`-03` / `res_ca04eb9c9f1248e0df9b` 为短文收敛。输入/返回保存为 `轻量化-01` 至 `轻量化-03` 文件。第二轮发送返回虽标 complete，但原文在 `X-Uncompressed-` 处截断；后续读取会话 `res_c635b7d4bc0ada7b43b7` 保存更多内容，仍在 `高频 scroll` 处结束，归为不完整 snapshot，不视为完整复审。第三轮带 `LIGHT_REVIEW_DONE` 结束标记后再收敛。

采用原生 gzip、双份 decoded 保守预算、硬限和接收超时、失败时暂停输入并在错误响应后关闭未完成连接、输入原生值完整保留、稀疏状态采样和缓存兼容。纠正第一轮中的硬实时/设备精确判定/一次时钟测量证明漂移表述，以及降低 decoded 预算、不允许 IDB 行添加兼容缓存字段的建议；既有 pointer/hover/colorDepth/timeOrigin 不算新实现。环境记录位于 covariates，权限 query 由既有 bounded 捕获同步/异步异常，无须机械改成 allSettled。模型意见不替代本机运行验证。

2026-10-11。用户要求使用 Gemini Bridge 讨论当前项目全部逻辑并优化设计。已完成 118 份第一方文件的 54 段输入、两轮综合设计讨论、7 段实施后源码复审及最终收敛。采用结论见 [当前项目逻辑与设计优化](../当前项目逻辑与设计优化.md)。

[Gemini 会话](https://gemini.google.com/app/40a1fe9e41989eac)。本次使用桥接的当前会话模式；未创建新的 Codex 聊天。

## 范围与记录

- [coverage.json](coverage.json)：起始 Git commit、118 份文件身份与摘要、18 个逻辑源码包到 54 段传输的映射，以及最终修改文件摘要。包仅作为分组，实际传输输入以 chunk 文件为准。
- `chunk-01.prompt.md` 至 `chunk-54.prompt.md`：源码输入；同名 `response.md` 是完整返回。前 10 段局部讨论，之后按接收方式补齐上下文，实质结论集中在综合轮次。
- [00.prompt.md](00.prompt.md) / [00.response.md](00.response.md)：范围、可靠性合同和讨论约束。
- [synthesis.prompt.md](synthesis.prompt.md) / [synthesis.response.md](synthesis.response.md)：完整闭环与第一轮优化讨论。
- [final.prompt.md](final.prompt.md) / [final.response.md](final.response.md)：提供当前行为纠正后继续收敛。
- `patch-01` 至 `patch-07` 的输入/回复，以及 [patch-final.prompt.md](patch-final.prompt.md) / [patch-final.response.md](patch-final.response.md)：实施后源码、回归变化、采用设计与最终静态复审。
- [results.json](results.json)：65 份主体结果的 request/result ID、stage 和 completeness；54 段源码均唯一归属到对应请求且为 complete。
- [test-inventory.txt](test-inventory.txt)：测试标题清单，属于上下文索引；不是完整测试源码审计。发生修改的测试在实施后复审中另行提供。

两次输入被桥接直接拒绝：不支持 `conversation_policy=new`，单次约 46k 字符输入超过上限。随后使用 current 会话和约 14k 字符的连续源码段，全部成功完成；另有一条辅助传输规则提示。第 11 段后附加了“一行接收、最后综合”的指令，详见 coverage 的 transport_instruction。未完成的调用不作为设计结论。

没有发送私有 `.env`、凭据、运行数据库或实际研究答卷。第三方依赖、参考项目 checkout 和生成的 dist 不包含在第一方逐文件输入中。

## 采用与纠正

采用共享活动策略、存活 owner 保守拒绝接管、活动监督自清理/晚到响应忽略、未知 runner 策略拒绝、旧策略兼容、当前准入文档统一，以及测试/探针语义同步。保持现有单应用/SQLite writer、WAL/FULL、不可变原始字节、ACK/seal、固定抽样、重放与联合恢复合同。

Gemini 的综合回复多次混入旧行为或不准确字段，已提供上下文纠正。原文保留，项目文档不照搬：

- 整例和准备均满额立即 409；活动票据续活不等于 FIFO 等待。
- 新固定刺激和评分都包含 activity 请求；不存在微秒或物理硬实时保证。
- 原始 BLOB 在 `lab_raw`；`lab_events` 为逻辑事件，接管不保证处置有效。
- 同意独立存表，无 consent seal；诊断独立保存，但仍可能影响正常完成。
- 中断可明确重答，旧答卷保留；CSV 覆盖所有状态。
- 无自动备份加密、无 DB/文件跨系统原子或硬件宕机无损保证。
- 所有权和失联扫描位于 `db-worker.ts` / `lab-store.ts`，不是维护 worker。管理员 Cookie 是不透明凭据，不称为签署 token；草稿在 `lab_studies.draft`。
- CSV 已有游标逐行写入；不重复实施“引入流式导出”。不采用任意 750MB/5% 阈值，或没有配套通知机制的 WatchdogSec。
- v3 混合故障探针验证终止和对账；新旧答卷关联由独立重答测试验证，不能混称同一证据。

Gemini 最终回复报告未发现确定阻塞；这属于静态设计意见。材料没有另外进行网上搜索或独立文献核验。本地编译、运行与回归结果独立记录，不能由模型讨论推断性能或正式准入。

## 实施验证

完整默认 `npm run check` 已纳入独立运行器套件并通过：类型、生产构建、SQLite smoke、109 项单元/故障、37 项 HTTP/Chromium 浏览器及 5 项运行器测试。详细记录见 [validation.json](validation.json)。

运行器历史测试源为 GB18030，已保持原中文内容转为 UTF-8；不可解码的 `test-image` 字节改为真实 PNG；评分用现行滑块实际触控。重答按钮与浏览器定位同步为“重新作答”。修复这些验证入口没有放松生产几何、时序或图片门控。

当前无等待准入探针保存为 [mixed-v3.json](mixed-v3.json) 与 [bandwidth-v3.json](bandwidth-v3.json)。混合波次记录完成与容量拒绝，并额外保证一个已准入的中断/对账路径；限速探针记录准备成功与拒绝，均最终释放名额。报告使用隔离 TEST_ONLY 数据、软件合成记录与 loopback 限速，备份 `independent=false`，不替代 ECS 新容量、真实设备或独立恢复验收。

此次未提交 Git、未部署、未开放正式 gate、未修改实际研究数据。
