审查发现以下并发、恢复与数据合同真实漏洞：

1. **构造器死锁/降配泄漏名额**：`constructor` 仅将已有 `ISSUED` 置为 `ACTIVE` 并续租，但未执行 `sweep()`。若因历史并发或配置降配导致 `ACTIVE` 数量 $\ge \text{limit}$，随后到达的 `join()` 在 `sweep()` 中虽然 `Math.max(0, limit-active)` 为 0，但先前既有 `ACTIVE` 会话若掉线超时，因有 `ISSUED` 豁免 `EXPIRED`，永不释放名额，导致全局排队永久饥饿。
2. **重插抹除 FIFO 序位**：`join()` 对非 active/queued 记录执行 `DELETE` 再 `INSERT`，其 `ordinal`（AUTOINCREMENT 或默认序列）直接变为队尾，导致被偶然抖动判定为 `EXPIRED` 的用户重连时失去原 FIFO 序位，违背“刷新复用原 ordinal”的恢复合同。
3. **Nonce 轮换防并发保护失效**：`join(sid, nonce)` 中当 `row.ticket_id !== ticket` 时直接覆盖写入 `ticket_id`，缺乏针对旧 ticket 的原子乐观锁比对。若同一会话存在双 Tab 或重放请求，后发请求可单方面覆写票据，将正常轮询中的合法连接直接踢为 `SESSION_QUEUE_FENCED`。
4. **409 与事务回滚矛盾**：说明中要求“事务提交后抛出 SESSION_WAITING(409) 以防排队插入回滚”，但业务接口在同一 DB 事务内执行时，一旦抛出异常往往触发外层 rollback；必须确保队列写入与业务被拒（409）解耦，否则入队状态无法持久化。

SESSION_ADMISSION_REVIEW_COMPLETE
