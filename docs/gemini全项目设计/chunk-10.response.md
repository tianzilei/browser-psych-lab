**业务作用**： 构建单 writer 基础设施：`openDatabase` 强制 WAL/`synchronous=FULL`/外键与 SQLite 3.51.3+；`DatabaseWriter` 维护控制帧优先的双队列与并发背压；`db-worker` 负责心跳互斥防多写与 30s 空闲超时扫描；`lab-schema` 初始化严格表与不可变触发器。

**设计建议**： `db-worker.ts` 中 `heartbeatTimer` 与 `activityTimer` 未绑定 `unref()`，在主流程关闭时若发生未捕获异常退出可能挂起事件循环；建议对两处定时器调用 `.unref()`，提升 worker 退出的干净度。
