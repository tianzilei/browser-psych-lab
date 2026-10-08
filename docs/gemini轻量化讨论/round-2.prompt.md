继续第2轮，专门收敛服务端、SQLite和作业并发。第1轮已收到完整ROUND_1_COMPLETE。请先更正上轮中的几处合同冲突：SHA-256是摘要不是签名，不能把hash当event_id（同一正文可属于不同合法位置；同ID异正文应可检测）；原始数据须seal后才能清理，不能仅ACK后删；第二tab只读，显式未知恢复终止旧会话且不开新执行；unlink后不能“任何故障回滚保留文件”；私有research-assets不能被Caddy公开目录直出；高频日志中的微秒取整可能损失原始精度；PerformanceObserver/解码接口不代表物理onset/显存常驻已证明。你给的库KB、代码行数、人周、Fastify/Caddy RSS、IPC微秒与fsync延迟不是本项目测量，后续请删除这些断言或清楚标“假设/候选，须测”，不能用零风险表述。

数据库专项：
A 首版我倾向一个HTTP进程+一个常驻DBwriter worker（单写连接、WAL+FULL），最多一个按需maintenance worker，无cluster/Redis/ORM；从一请求一短事务开始，不默认跨会话Group Commit。Worker把阻塞移走，不提高单写磁盘物理上限。主线程只做有界鉴权/验证/hash，任何数据库查询若可能长耗时也不留在HTTP循环。
B 排队按请求数+累计原始字节+每请求字节/事件数限制；只发一个在途消息给worker，主线程有限队列，避免无限MessagePort队列；同session顺序确定，全局公平/终止控制请求不能无限饿死。拒绝进入的请求明确503+Retry-After且无接管；已发送后timeout或worker崩溃一律“结果未知”，不能称未提交。旧幂等键恢复查询/重试，worker重启核查DB状态且不得两个writer重叠。
C 同一RPC里在BEGIN IMMEDIATE事务重新核对authorization scope/admission暂停/writer_epoch/permit/final状态（队列前检查可能过时）；custody+receipt+投影原子提交后response。保留raw bytes的客户端副本，主线程不要transfer其唯一buffer导致detached后无法记录重试。
D 首版不跨请求合并；后续若实测FULL fsync压力大，只合并已验证的兼容采集请求，保持每请求结果及savepoint/整体rollback语义，不能把seal/termination/reservation与raw请求乱合并，不因为性能关闭FULL。请比较“短单请求事务”“适用的有界组提交”“主线程短写”在复杂度/尾延迟/稳态吞吐/故障窗口上的取舍。
E busy_timeout3s是候选，worker争用时阻塞可拖延所有queued请求；短期繁忙须保留可查询身份，不死循环重试。checkpoint被长reader拖住不能强制TRUNCATE卡住采集；按实测WAL磁盘预算门控新准备/管理作业，旧raw接收优先保留，磁盘不可写时明确停止ACK。
F 导出采用专用read snapshot有界物化，基于完整backup副本导出只作为规模大时备选（全库副本成本也要算）；同一时间一重型作业，read-only worker仍可能影响I/O/WAL，所以不是隔离后零争用。备份屏障/pin路径按上轮实际SQLite修订，不改成开始时点snapshot。
G 不加入WebSocket/heartbeat/PriorityQueue第三方库；单opaque研究者session+participant token，角色/Origin/CSRF边界仍保留，IP限制考虑20人同一校园NAT，按session及全局限流并限制内存映射大小/TTL。

请给可实施的有限RPC消息/状态/错误分类、启动/关闭/restart步骤、队列/事务/锁等待/后台预算必测指标、关键故障矩阵，并对better-sqlite3 vs node:sqlite给基于当前版本能力/修复版本的保守选型，不能用“坚决保留/功能残缺”而没有具体依据。部署本机TCP就够，UDS是否值得默认引入？node/http→Hono是否真值得迁移？请给明确推荐并注明未实现。
最后自审上述协议能否保留既有合同，标出潜在缺口。结尾ROUND_2_COMPLETE。
