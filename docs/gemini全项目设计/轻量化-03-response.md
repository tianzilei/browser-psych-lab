针对截断处的剩余关键点与错误分支，直接给出必要修正：

1. **解压错误分支防无界消费（关键流漏洞）**： `pipeline` 失败回调中，执行 `payload.resume()` 会使异常请求的剩余大体积数据被无界读入内存。应改为：
  - 立即设置响应头 `Connection: close`；
  - 对 `payload`（`request.raw`）调用 `payload.pause()` 停止读取；
  - 监听 `reply.raw.once('finish', () => payload.destroy())`，确保 Fastify 能够先完整写出 4xx 状态码及 JSON 错误体，随后强制销毁底层输入流与连接，阻断多余带宽与内存占用。
2. **权限查询（`navigator.permissions.query`）状态映射收敛**： 现有 bounded 并发结构已包裹 Promise 异常捕获，无须重构为 `Promise.allSettled`。当 API 抛出 `TypeError` 时，应严格归类为 `blocked-or-error`（或保留错误码），不武断假定为 `unsupported`，避免掩盖因浏览器安全策略或上下文隔离导致的阻断事实。
3. **高频 `scroll` 与布局快照边界**： 高频滚动做 RAF 合并快照并置 `capture` 标志合理；但若滚动作业中途伴随 `blur` 或跨页等离散跳转，必须优先以跳转时的同步快照覆盖挂起的 RAF 任务，避免状态覆盖颠倒。
4. **架构不变量保留**：
  - 接收内存预算严格维持 `decoded * 2 + wire + stream_reserve_bytes + 1024` 的保守预占，覆盖反序列化与多副本内存峰值；
  - 不声明任何物理硬实时或跨设备绝对对齐承诺；
  - 本地 IDB 缓存属性不更改底层持久化契约，传输层与校验链条严格闭环。

LIGHT_REVIEW_DONE
