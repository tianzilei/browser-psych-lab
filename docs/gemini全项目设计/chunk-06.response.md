**业务作用**： 处理采样溢出阻断；实现图片自定步调评分重放（`RatingReplay`，含呈现/改选/多维选项时间溯源）；驱动实验试次时序重放验证引擎（`RunReplay`，含调度算子重演、帧/呈现/按键对齐与时钟一致性检查）。

**设计建议**： `RunReplay.apply` 频繁使用 `[...this.results.values()].filter(...)` 和 `find(...)` 线性扫描，随着试次累积产生 $O(N)$ 损耗；建议维护 `root_id -> instance_id[]` 倒排索引加速状态关联。
