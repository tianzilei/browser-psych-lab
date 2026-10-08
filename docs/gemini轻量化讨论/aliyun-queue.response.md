### 1. 租约活性与流传输绑定（防慢下载被误删）

- **流活性自动续约**：仅靠客户端 20s HTTP 轮询续活存在风险（主线程串行解码大图可能阻塞定时器，或微小抖动触发 90s 超时误放行第 2 个会话）。**服务端资产下载流的数据传输事件必须同步刷新租约的 `last_active_at`**；只要流未断开且未触发 60s 停滞，租约不得被剔除。
- **时限下限设置**：单图 allowance 取 3 KiB/s 合理，但对 <=100 KB 小图需设保底时长（如 30s），避免因瞬时握手延迟误判。

### 2. Ticket 作用域与状态机隔离（防越权与旧取消串扰）

- **不可变三元组**：Ticket 数据结构必须为 `(session_id, group_index, ticket_nonce)`。
  - 资产接口强校验：`ticket.group_index === current_group_index` 且请求的 `asset_id` 必须在当前组冻结清单中，防止拿旧组 ticket 下载新组资源。
  - 显式取消/释放幂等：服务端仅在 `current_active.nonce === req.ticket_nonce` 时放行下一会话，丢弃过期的旧取消请求。
- **状态互斥与 Variant 变更**：
  - 进入试次后状态置为 `STARTED`，任何重入队请求直接拒绝（409）。
  - 若在完成准备到点击“开始”之间触发了 variant 重新预约（换签），必须使当前准备就绪状态立即失效，释放原 ticket 并要求重新排队准备。

### 3. 1 Mbps 出带宽与排队参数边界

- **吞吐与延迟**：`active=1` 独占模式下有效带宽约 100–120 KB/s。
  - 20 人各 1 MiB：单人约 9–11s，排尾等待约 3.5 分钟；
  - 20 人各 5 MiB：单人约 45–55s，排尾等待约 16–18 分钟。45 分钟总排队上限与 20 分钟组下载上限完全满足要求。
- **轮询开销**：64 会话每 5s 轮询产生约 13 QPS，报文控制在 150B 内时带宽消耗仅约 2 KB/s（占 1.6%）。必须复用 HTTP/1.1 Keep-Alive，避免频繁 TCP/TLS 握手挤占下行。

### 4. 归档预压缩与协商细节

- **Manifest 结构**：`representations.json` 记录 `{file_path, variant_ext, compressed_hash, raw_hash, raw_bytes}`。归档与恢复时严格流式解压比对 `raw_hash`。
- **幂等旁路**：目标文件存在且哈希匹配时，直接跳过临时文件写入与 `fsync`。
- **RFC 9110 协商边界**：客户端声明 `identity;q=0` 且无对应压缩格式时返回 406；响应强制附加 `Vary: Accept-Encoding` 及 `Cache-Control: ..., no-transform`，防止反向代理破坏预压缩字节。

ALIYUN_QUEUE_REVIEW_COMPLETE
