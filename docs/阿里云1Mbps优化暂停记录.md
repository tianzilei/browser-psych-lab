# 阿里云 1Mbps 优化暂停记录

本文件保留暂停时的历史状态；用户随后已发出 `resume`。当前落实结果见 [阿里云 1Mbps 部署与验证](阿里云1Mbps部署与验证.md)，下列旧测试数字与待办描述仅对应暂停时点。

2026-10-08。用户明确要求“完成当前 gemini 对话后暂停”，第三轮已返回 QUEUE_CODE_REVIEW_COMPLETE；本轮开发暂停。未提交 Git、未部署到服务器，正式采集 gate 未开放。

用户提供的目标配置：阿里云 ECS，2 vCPU / 4GB RAM，Ubuntu 26.04，系统盘 IOPS 2120、吞吐 106.0 MB/s，期望公网带宽 1Mbps。未获取实际主机、挂载、设备或独立备份验收证据。

## 已落实的代码

- 组前图片准备采用内存 FIFO 队列，默认 PREPARATION_CONCURRENCY=1，容量 64。票据绑定 session / writer epoch / group index / variant，资产接口复核当前组引用；管理运行状态显示队列数量。
- 队首约 1 秒、其他等待者约 5 秒轮询并加随机偏移；READY 约 20 秒续活。90 秒失联且无传输时回收；有传输时保留占用，20 分钟硬截止取消流。释放必须匹配具体 nonce，实际 HTTP 结束才回收传输名额。
- 取消准备、pagehide 和准备完成释放票据；排队上限 45 分钟，组前下载上限 20 分钟。进入试次前结束下载及轮询，试次期间保持零 HTTP 请求。
- 单图串行下载/解码，一次按冻结字节数分配，单图最多 8MiB；原字节 SHA-256/尺寸、组去重和解码预算保留。固定 20 秒下载超时改为按字节量的有限总预算及 60 秒停滞看门狗；429/503 有限重试。
- 准备阶段每 60 秒续期未分配方案名额，保持 5 分钟有效期；开始前再次确认方案一致。未知 permit、终态和 writer fence 仍执行原合同。
- 归档运行器留存 gzip/br 表示并核对压缩摘要及解压后的原代码身份；Accept-Encoding/q/identity/Vary/no-transform/406 已接入。已存在且一致的发行文件不重复复制和 fsync，新归档文件设为 0600。
- JSON 请求对 429/503 使用固定请求字节和身份进行有限重试，网络不明错误向上抛出。SQLite WAL/FULL 和事务内鉴权、冲突证据保留。
- 部署模板增加 1 路准备配置、2 线程 libuv 建议和 nginx keepalive / 无代理临时文件的公共代码流配置，尚未在 Ubuntu 主机部署验证。

## 验证状态

最近完整 npm run check：类型检查、构建、SQLite smoke、42 项单元/故障测试、18 项 Chromium 测试通过。覆盖 FIFO、租约、旧取消、真实传输退出、下载停滞/截断/越界/取消、固定重试字节、超过 20 秒的准备等待、排队取消、归档压缩协商和备份恢复。随后归档复制增加 chmod(0600)，类型/构建和带宽模拟复跑通过；该权限小改动的专门复验待继续。

[混合采集报告](混合采集本机测量.json)：1/5/10/20 四波共 36 个会话，预期 33 完成及 3 注入终止；报告 729 个 HTTP 200、6 个可重试 503，含并行导出/备份。合成软件时序，不是目标 ECS 或真机时序验收。

[1Mbps 聚合响应正文模拟](1Mbps排队本机测量.json)：20 个会话各下载 197301 字节原图，所有摘要一致，FIFO 完成；同时图片流最大 1，队列最终为空。最新版约 51.31 秒，累计正文 3959210 字节。限速为 125000 B/s，只模拟 loopback HTTP 响应正文，不计请求/响应头、TLS、实际 ECS 网络和浏览器渲染。较早的 5 秒固定轮询测量约 95 秒；缩短队首轮询后重跑得到当前报告。模拟代理已设置 75 秒 keepalive，避免测试工具默认 5 秒闲置连接与轮询边界冲突。

20 人各 1MiB，1Mbps 的纯数据理想下限约 167.8 秒；各 5MiB 约 838.9 秒。排队不会增加总带宽，实际还包括排队轮询、代码、其他 API、TLS、丢包等。70% 利用率仅可作为规划假设，不能视为测量。2120 IOPS / 106 MB/s 不能推导 FULL 提交延迟。

## 暂停后的待办

1. **旧冻结运行器兼容性**：新图片 API 要求票据及 writer headers，旧归档运行器没有队列客户端，可能无法准备后续图片组。需要完成兼容或明确版本迁移方案及回归，不能把本轮当作正式升级验收。
2. 将部署、README、P1–P6 实施与进度中的旧“2 路图片下载”和 34/15 测试记录更新为最新约束；补充 1Mbps 准备等待、导出/备份下载错峰及容量边界。当前旧文档仍有过时说明。
3. 复验新归档文件 0600；梳理未提交变更，检查最终 diff。继续时按新改动范围运行必要检查，保留原始数据。
4. 实际 Ubuntu / HTTPS / 文件系统与目标主机负载、真实移动设备和独立备份恢复验收仍待对应环境。模拟报告不能用于开放正式 gate。

## Gemini 记录与取舍

会话：https://gemini.google.com/app/fd77451f54303ef7。

- 首轮 [输入](gemini轻量化讨论/aliyun-review.prompt.md) / [原回复](gemini轻量化讨论/aliyun-review.response.md)，请求 bpl-aliyun-review-20261008-a，完整快照 res_36e4d73d3d50b4aabc46。
- 1Mbps 队列 [输入](gemini轻量化讨论/aliyun-queue.prompt.md) / [完整回复](gemini轻量化讨论/aliyun-queue.response.md)，请求 bpl-aliyun-queue-review-20261008-b，结果 res_a074adefd358cbd38fa1，ALIYUN_QUEUE_REVIEW_COMPLETE。
- 实际队列代码 [输入](gemini轻量化讨论/aliyun-queue-code.prompt.md) / [完整回复](gemini轻量化讨论/aliyun-queue-code.response.md)，请求 bpl-queue-code-review-20261008-c，完整快照 res_827b954cdeac9205dd95，QUEUE_CODE_REVIEW_COMPLETE。

原回复不是实施合同。首轮关于并发带宽、已有批量写入/Promise.allSettled/只读重放的部分描述不准确；不采用鉴权前移、冲突 DO NOTHING、未经测量的 checkpoint/fsync/带宽保证。采用有限下载与票据/流生命周期、压缩原代码身份核对的建议，并按项目合同落实。本轮未独立重复 Gemini 的外部资料搜索，也未获得可用于实际主机容量判断的官方或实测证据。第三轮未指出队列相关新增 bug，不代表全面兼容性或生产验收通过。

## resume 后的落实结果

2026-10-08，用户发出 `resume` 后，暂停待办 1–3 已完成：新 canonical 队列能力声明、旧 GET 共享 FIFO 与原冻结代码兼容、同摘要在途读取合并及有限缓存、真实 HTTP 取消/流错误/升级回归、0600 与恢复复验、部署及进度文档同步、变更检查。新增 Gemini 第四轮 [输入](gemini轻量化讨论/aliyun-legacy.prompt.md) / [完整回复](gemini轻量化讨论/aliyun-legacy.response.md)，请求 bpl-legacy-assets-review-20261008-d、结果 res_4771bbc46fd3a4084b75、LEGACY_ASSET_REVIEW_COMPLETE；取舍见 [讨论索引](gemini轻量化讨论/README.md)。

最终 `npm run check` 通过：类型/构建/SQLite smoke、47 项单元/故障与 18 项 Chromium；真实文件流错误补充回归也通过，doctor 和变更空白检查通过。最新混合报告为 33 完成/3 注入终止、708 次 200/10 次可重试 503；最新 1Mbps 正文限速报告为约 51.43 秒、3959014 字节、最大图片流 1、FIFO 完成且队列为空。报告文件已更新，前文数字保留为暂停时历史。

待办 4 仍需实际 ECS、HTTPS/文件系统、真实手机与独立备份环境；没有将模拟结果用于开放正式 gate。当前完成范围、1Mbps 预算与部署参数见 [阿里云 1Mbps 部署与验证](阿里云1Mbps部署与验证.md)。本轮没有 Git 提交、推送或安装到用户服务器。
