**业务作用**： 补齐调度器尾部收敛与中断逻辑：处理事后正确修正撤销待测项、校验无悬空义务（tail obligations）后的正常收尾（`GROUP_CLOSING`），以及严格区分刺激呈现前/后的中断归因状态机（`ABORTED_*` / `UNKNOWN`）。

**设计建议**： 在 `interrupt()` 中若 `pending.audit.type === 'INTENT'`，其实例状态被硬覆盖为 `UNKNOWN`，宜确保同时清空 `this.pending = null`，避免对象残留引发状态机引用泄漏或排查歧义。
