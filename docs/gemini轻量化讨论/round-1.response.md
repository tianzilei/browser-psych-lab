Gemini 说

这是一份面向 Browser Psych Lab 生产可用性与轻量化目标的系统级架构筛查。

在 2 核 / 2–4GB 单机、20 名并发被试集中压测、以及“数据不可静默缺失、synchronous FULL 强持久化、软硬件 onset 隔离、状态机不可逆”的严格科研合同下，“轻量”绝不能等同于“换更小的第三方库”。真正的轻量是剥离无用抽象、切断主线程阻塞、压缩网络与内存工作集、以及建立精确的有界排队与背压机制。

模块逐项审查与轻量方案对照表
1. 问卷渲染与分支

当前成本：引入 survey-core 与 survey-js-ui (v3.2.0)。生产构建 JS 达 1684 KB（gzip 383 KB），CSS 达 519 KB（gzip 50 KB），包含内置 Preact 运行时、通用表达式解析器与数十种未使用的复杂题型。

具体瓶颈：当前问卷库与时序任务强打包在同一入口；移动端/微信 WebView 解析 2.2MB 静态文本引起首屏主线程卡顿（Jank），影响随后时序任务的计时器预热；且通用表达式引擎存在无界动态求值风险。

候选轻量方案：

方案 A（深度剪裁 SurveyJS）：仅在问卷路由通过动态 import() 懒加载，抽离独立 chunk；冻结并白名单化 schema，禁止加载未用组件。   
Node-RED Library

方案 B（原生有限 DOM 渲染器）：自研仅支持“说明、单选、多选、量表、短文本、分页、有限分支”的超轻渲染器（约 15–25 KB gzip），分支条件仅支持三元比较与布尔逻辑的有限状态转移。   
About this documentation - Node.js

推荐：两阶段演进。第一阶段立刻实施方案 A（路由拆分 + 强类型 JSON Schema 校验），零风险砍掉时序任务页面的初始体积；第二阶段若微信端低端机型内存实测仍有压力，再平滑切入方案 B。

保留可靠性合同：问卷定义在发布时计算 SHA-256 并持久化于冻结版本中；分页前进前必须完成当前页脏检查与本地存储提交；恢复会话时依据稳定字段回填。

需要实测：微信 WebView 下自定义表单与软键盘弹出时的视口高度缩放、量表选项触摸目标点击判定延迟（Touch/Click 延迟）。

迁移代价：方案 A 几乎为 0（仅构建配置）；方案 B 需编写 ~800 行原生渲染代码与完整属性分支状态机测试用例。

2. 卡片编辑器/研究后台

当前成本：纯研究者自用后台，目前与参与者共享依赖上下文。

具体瓶颈：无团队协作、仅单研究者使用，若与前台混部混包，会导致后台代码泄漏且无端增加前台攻击面与部署复杂度。

候选轻量方案：

方案 A：完全独立的纯 HTML/原生 JS MPA（多页面），仅用原生 <dialog> 与表单构建卡片管理。

方案 B：基于轻量静态单页（如轻量级 Web Components 或极简模版），通过专用 /admin/* 路由提供，后台静态资源与被试入口完全隔离。

推荐：方案 B（后台路由彻底独立切割）。

保留可靠性合同：卡片编辑变更在“冻结发布”前允许草稿暂存；发布操作生成不可变发布快照（包含全量配置的规范化 JSON 与 SHA-256 签名），此后只读。

需要实测：研究者大容量配置提交时的原子替换与并发防护（避免研究者多标签页冲突编辑）。

迁移代价：低。

3. 图片呈现/输入/动态队列

当前成本：自研 Canvas + 帧调度器 + PRNG 动态补测队列。

具体瓶颈：微信浏览器等移动端存在复杂的下拉弹性形变、手势放大、多点触控干扰，以及高刷屏（90Hz/120Hz）与低刷新率设备的帧率同步抖动。

候选轻量方案：

方案 A：依赖第三方实验心理学库（如 jsPsych 运行时）。

方案 B：坚持自研轻量 Canvas 渲染器，配合 requestAnimationFrame + PerformanceObserver（longtask）+ Pointer Events 严格状态机，无任何外部库引入。

推荐：方案 B（极简自研无依赖状态机）。

保留可靠性合同：

软件 onset 仅记录为帧回调时间戳，明确标注 software_onset_time，不冒充物理曝光；

首个有效 PointerDown 锁定输入响应，后续重入/按住全部作为附加日志流记录；

动态补测状态机严格执行 QUEUED → STAGED → ONSET 隔离；若 STAGED 未出现前收到迟到正答且无安全撤销机制，按合同坚决抛出不可恢复异常并终止（TERMINATED）会话，禁止静默掩盖。

需要实测：iOS Safari 与 Android 微信 WebView 中 Canvas 的 DPR 适配、防双击缩放（touch-action: none）、后台挂起时的切屏时间与 visibilitychange 捕获成功率。

迁移代价：低（当前已有骨架，只需补全边界防线）。

4. 预加载与解码/图片规范

当前成本：组前集中预加载所有必需图片，全量解码后方可进入。

具体瓶颈：20 个被试若在同一秒集中触发组前预加载（每人 50–100 张图片，总计约 20–50MB），瞬时产生约 400MB–1GB 的出口突发流量，瞬间打满 2 核服务器带宽或引发连接重置。

候选轻量方案：

方案 A：浏览器端并发裸奔 fetch() / Image()。

方案 B：客户端有界并发流水线（如限制最大并发连接数 4），利用 createImageBitmap() 或 HTMLImageElement.decode() 显式将解码移出渲染关键路径，完成布局与显存常驻门控。

推荐：方案 B（客户端有界并发 + img.decode() 内存解压门控）。

保留可靠性合同：组前门控未 100% 确认前（全部图片下载完成、解码成功、尺寸校验通过），禁止进入时序任务；任务进行中零网络请求。

需要实测：低端移动设备在解压 100 张 500KB WebP 后的显存占用（GPU Process 内存崩溃阈值）。

迁移代价：低（仅客户端预加载器需增加有界并发队列控制）。

5. IndexedDB/outbox/字节hash

当前成本：idb (v8.0.4) 库，用于管理本地离线 outbox、事件日志与 UTF-8 校验。

具体瓶颈：高频逐帧/输入事件如果每次都开启单独的 IDB 读写事务，会导致严重的浏览器主线程与磁盘 I/O 拥塞；若结构体体积膨胀，移动端存储限额易超标。

候选轻量方案：

方案 A：完全手写原生 IndexedDB 包装。

方案 B：保留 idb（仅 ~1.5 KB），上层封装“批次聚合写入（Micro-batching）+ 内存双缓冲环”逻辑；对高频时序数据采用紧凑二进制或列式扁平数组存储。

推荐：方案 B（保留 idb，重构事件写入流水线）。

保留可靠性合同：

一次编码精确 UTF-8 字节：计算 SHA-256 时直接使用原始 TextEncoder().encode(payload) 得到的 Uint8Array，杜绝在序列化与重解析间产生空格/键顺序差异；

本地存储确认才可放行下一阶段；数据经服务端 ACK 后才标记 ACKED，会话封印（SEALED）前本地保留唯一权威副本；

同一 event_id 若哈希不同，强制记入冲突区，绝不覆盖。

需要实测：iOS Safari 在无痕模式或存储受限时 IndexedDB 的可用性与容量上限（微信内置浏览器清理缓存阈值）。

迁移代价：中（需规范事件序列化与摘要生成的纯函数链路）。

6. Fastify 与 HTTP 上传/静态服务/日志

当前成本：Fastify 5.12.5 + @fastify/static 10.1.5，当前配置为 logger: true（每请求全量输出）。

具体瓶颈：logger: true 在默认状态下对每个静态资源请求产生同步/异步控制台格式化输出，不仅污染日志，还在高并发静态拉取时浪费事件循环 CPU；静态文件托管未设置合理的缓存与断点续传策略。

候选轻量方案：

方案 A：替换为极简 node:http 或小巧框架。

方案 B：保留 Fastify 5，优化配置：引入 pino 管道输出（异步落盘），将静态资源托管移交前置极简反代（如轻量 Caddy 或独立微型静态线程），或对 Fastify 静态路由关闭日志并启用强缓存响应头；对上传接口施加严格的 content-length、stream 限流。

推荐：方案 B（保留 Fastify，精细化配置治理）。

保留可靠性合同：对被试的每一笔提交与 ACK 保持结构化审计日志留痕；静态资源与动态数据上传使用不同安全隔离策略。

需要实测：在 20 并发同时下载静态大图时，Fastify 静态托管的内存占用（RSS 变化）与吞吐量。

迁移代价：极低（仅配置调整）。

7. SQLite 驱动/主线程 vs 专用 DBworker/排队背压/索引 checkpoint

当前成本：better-sqlite3 13.0.3（引擎 3.53.4），运行在 Node.js 主线程，仅执行 health 查询；已配置 WAL、synchronous = FULL、foreign_keys = ON、busy_timeout = 3000ms。   
SQLite

具体瓶颈：

在 WAL 模式下，synchronous = FULL 强制每个事务在提交时对 WAL 文件执行物理 fsync。

机械盘或一般虚拟化云盘的单次 fsync 延迟常在 2–15ms 不等。如果在 Fastify 的 HTTP 主线程直接执行 db.transaction()，哪怕并发仅 20 人，若瞬时并发提交，主线程将被阻塞几十到数百毫秒，导致后续所有 HTTP 请求握手超时、事件循环停滞。

候选轻量方案：

方案 A（维持主线程直写）：放弃或妥协 synchronous = FULL 为 NORMAL（违反合同，坚决拒绝）。   
Zenn

方案 B（单专用 DB-Writer Worker 线程）：主线程完全不执行写操作，所有写入请求通过内存有界队列投递给单独的 SQLite 写 Worker；采用组提交（Group Commit）机制；超出队列深度时直接返回 429/503 背压。   
Node-RED Library

推荐：方案 B（专用写线程 + Group Commit + 严格背压）。

保留可靠性合同：

绝不允许“进队列即发 ACK”。必须等待 Worker 线程完成物理 COMMIT（WAL fsync 成功返回）后，RPC 返回并由主线程向客户端发送 200 ACK；

队列有界（如上限 100 个批次），超限返回 503/429 并携带 Retry-After，客户端退避并重发；

批事务合并不可无限扩张，设定最大合并数（如 30 条）与最大等待窗口（如 5ms）。

需要实测：特定云盘/宿主机上的物理 fsync 延迟，以及 Group Commit 在 20 并发冲顶时的吞吐瓶颈。

迁移代价：中高（需要编写稳健的 Worker 通信层与错误隔离逻辑）。

8. 共享协议和状态合同/派生表

当前成本：仅有抽象合同规划，未完全实现 writer_epoch / 栅栏控制 / permit 状态机。

具体瓶颈：多标签页（Second Tab）被试误操作；网络偶发丢包导致客户端重传，容易造成无序推进或旧状态覆盖新状态。

候选轻量方案：

方案 A：传统的 WebSocket 实时长连接心跳保活。

方案 B：无状态 HTTP + 严格乐观锁栅栏（writer_epoch + permit_token）。服务端以短事务维护递增版本号与排他许可；旧 epoch 提交仅允许存入审计历史，绝不允许驱动任务状态机向前跃迁；新 Tab 获取写入权前必须显式申请终结旧许可。

推荐：方案 B（无状态 HTTP 栅栏协议，零长连接开销）。

保留可靠性合同：状态转移单向不可逆（TERMINATED 永远无法转回 COMPLETED）；服务端事务核销预留名额，中途退出不释放配额；派生表（汇总指标/质量标记）与原始事件严格解耦，仅通过幂等消费生成。

需要实测：客户端断网后重连、双开标签页时的栅栏拦截率。

迁移代价：中（协议设计已明确，需实现状态转移拦截守卫）。

9. 文件发布/网关/清理

当前成本：规划本地三区（assets/exports/backups），无 S3；通过上传意向、私有暂存、格式校验、硬链接发布。

具体瓶颈：上传过程容易遭遇非法图片（如伪造后缀的恶意脚本、损坏的图像格式、超大分辨率导致 OOM 解码崩溃）；删除逻辑若缺乏原子性，可能破坏进行中实验的引用完整性。

候选轻量方案：

方案 A：在 Node 主线程用 Sharp/Jimp 进行完整解码与重压缩。

方案 B：轻量流式校验。使用极简头信息解析库读取真实 Magic Number、像素宽高、色彩深度与文件体哈希；校验无误后同卷 fs.link()（硬链接）发布到 assets；禁止引入沉重且占用原生 C++ 内存的图像处理管道。

推荐：方案 B（轻量流式特征校验 + 原子硬链接发布）。

保留可靠性合同：未通过校验的文件永不可见；正式发布采用 link() + 目录 fsync；无自动物理 GC，维护删除严格遵循 refs/pins 归零检查，经由 DELETING → unlink → PURGED 状态机推进，任何故障一律回滚且保留文件。

需要实测：操作系统文件系统（如 ext4 / APFS）硬链接跨目录操作权限与 fsync 行为。

迁移代价：中（需实现严格的二进制头探测器与状态机）。

10. 导出/备份/后台作业

当前成本：无外部备份工具；规划利用 SQLite Online Backup API 与受限 Worker。

具体瓶颈：大批量 CSV 导出或全量快照备份如果在主数据库连接上进行大表扫描，会引发长时间读事务，阻止 WAL 文件的正常 checkpoint 清理，导致 WAL 文件无界膨胀，进而拖慢所有写操作。

候选轻量方案：

方案 A：在主库只读事务内直接流式查表并压缩导出。

方案 B：后台独立 Export/Backup Worker。备份时调用 SQLite 原生 sqlite3_backup_* 接口（或 better-sqlite3 的 db.backup()）按步骤复制到副本库，读取副本库视图；导出 CSV 时通过游标有界流式提取（Bounded Streaming Chunk），边查边写临时文件，完成后释放锁再调用流式 gzip。   
About this documentation - Node.js

推荐：方案 B（基于 Backup 副本的离线化物化导出）。

保留可靠性合同：

备份过程：资源生命周期屏障下先 Online Backup 生成数据库副本，从副本读资源清单，源 DB 发起短事务持久化 BACKUP_PIN，核验无误后释放屏障复制真实静态资源，全体验证哈希一致才标记 READY；

导出 CSV 具有单一致快照，源数据若发现截断或校验失败，导出任务直接标记失败，严禁向研究者提供伪装成完整的残缺数据。

需要实测：2GB 数据库执行 db.backup() 期间对主库并发写事务造成的锁争用时长（通常仅在页面步进时发生极短暂读锁）。

迁移代价：中（需编写独立的 Worker 脚本与进度控制）。

11. 认证/安全/限制

当前成本：单研究者无团队，主要为被试匿名访问与研究者凭证鉴权。

具体瓶颈：容易过度设计复杂的 JWT/OAuth/RBAC 鉴权架构，引入无谓的外部依赖与加解密开销；被试端若凭据设计不当易被爬虫或脚本恶意刷票消耗名额。

候选轻量方案：

方案 A：全套 Session 中间件 + Redis 存储 + OAuth 服务。

方案 B：极简不透明令牌（Opaque Token）。研究者使用 HttpOnly; SameSite=Strict; Secure 的单一持久 Cookie，服务端在 SQLite 中维护单行 Hash 校验；被试使用服务端预留发放的单次 Admission Token；全局强制 Origin/CSRF 头校验与严格 Rate Limit（IP/Token 漏桶）。

推荐：方案 B（极简不透明凭证 + 内存令牌漏桶）。

保留可靠性合同：接入暂停仅拦截新 admission，已持有合法 permit 的受试者可继续推进与补传；密码与令牌使用规范的抗定时攻击常量时间比较（crypto.timingSafeEqual）。

需要实测：移动端微信内置浏览器中 Cookie 与本地 Storage 在重定向场景下的丢弃行为。

迁移代价：低。

12. 生产部署进程/HTTPS/静态传输

当前成本：开发环境 tsx/Vite 双进程；当前暂未配置独立的生产反代和进程守护方案。

具体瓶颈：Node.js 单进程直接裸奔监听 80/443 端口存在安全提权风险；且 Node 内部处理 TLS 握手会争夺 V8 单线程的 CPU 计算资源；断电或崩溃后缺乏进程自愈能力。

候选轻量方案：

方案 A：Docker + Nginx + Node.js 容器集群编排。

方案 B：单机极致方案：操作系统级 systemd 守护 Node 进程；前置一个内存占用极低（~15MB）的 Caddy 或轻量 Nginx，负责终结 HTTPS/TLS、自动申请 Let's Encrypt 证书、处理大图静态文件的零拷贝传输（sendfile），将 API 流量通过本地 Unix Domain Socket 反向代理给 Fastify。

推荐：方案 B（Caddy/Nginx 前置 + Unix Domain Socket + systemd 守护）。

保留可靠性合同：静态图片使用 ETag 与 Cache-Control: immutable；所有动态 API 绝不经过任何外部不受控缓存。

需要实测：Unix Domain Socket 在 20 并发突发请求下的吞吐稳定性与连接数限制。

迁移代价：中（主要是运维配置与部署脚本固化）。

13. 开发构建/测试/参考代码

当前成本：Node 24 + npm 11，TypeScript 6.0.3，Vite 8.3.3，Playwright 1.64.0，依赖项约 78 个（非 dev）。

具体瓶颈：环境检查与主业务逻辑代码混杂；开发依赖（Vite/Playwright）易被误解为生产负担；缺少对高并发断电与网络丢包的集成混沌测试用例。

候选轻量方案：

方案 A：引入全套 Jest/Vitest + Cypress 混合测试框架。

方案 B：保持严密边界：Vite/tsx/Playwright 严格限定在构建与 CI 阶段；编写 3 组针对关键可靠性合同的离线回归测试脚本（PRNG 黄金向量比对、Group Commit 断电模拟测试、双 Tab 栅栏冲突测试）。

推荐：方案 B（保持精简，强化合同测试）。

保留可靠性合同：构建产物必须是纯静态资源与纯编译后 JS，生产环境 npm prune --production，不加载任何测试运行时。

需要实测：Playwright 模拟弱网与移动端视口下的交互时序一致性。

迁移代价：低。

重点架构抉择深度评估
1. SurveyJS 深度保留 vs 自建原生 DOM 有限渲染器
评估维度	SurveyJS 保留（动态加载 + 深度限制）	自建原生 DOM 渲染器（6种题型）
首屏包体积	问卷单独 chunk (~400KB gzip)，时序任务页为 0KB	极小 (~15–20KB gzip)
代码成熟度	极高（已处理大量多端微小边缘分支）	零（需从头编写并覆盖所有边缘缺陷）
微信/移动端兼容风险	低（主流表单样式与事件已做长期修正）	高（容易在软键盘弹起、滚动穿透、多点点击上踩坑）
分支引擎可控性	弱（内置通用表达式求值，需防御恶意注入）	极强（纯静态模式匹配，无动态代码求值）
开发与维护人月	即刻可用（约 0.5 人天完成路由隔离）	预计需 2–3 人周编写、测试与跨端验收

决策建议与减负切入点：
不要立刻抛弃 SurveyJS。当前 1.68MB JS 导致性能警报的核心原因是将 SurveyJS 静态打包进了包含时序任务的统一主入口。

立即实施的零风险减负：

在 Vite 构建中将 SurveyJS 提取为异步动态路由模块（() => import('./survey-runner.js')），配合 Rollup 代码拆分，时序任务核心运行时的包体积直接从 1.7MB 骤降至 < 50KB。

关闭 SurveyJS 所有未用题型（Matrix, File, PanelDynamic 等）的组件注册，仅加载单选（radiogroup）、多选（checkbox）、文本（text）、说明（html/expression）等基础包。

仅当第一轮微信真实真机测试暴露出不可调和的底层兼容性缺陷时，才启动自建 6 题型渲染器的逃生通道。

2. 运行时核心选型：Fastify vs Hono/node:http，better-sqlite3 vs node:sqlite，idb vs 原生 IDB，开发工具链边界
(1) Fastify 5 vs Hono vs node:http

Hono 优秀且轻量，但其核心抽象构建在 Web Standards（Request/Response/fetch）之上。在 Node.js 环境下，Hono 依赖适配层将 Node 的 IncomingMessage 与 ServerResponse 转换为 Web 标准流，在涉及大量分块数据与文件上传时，会额外增加微小的对象分配与 GC 压力。

裸写 node:http 会导致路由匹配、正则编译、防御性 HTTP 头设置、跨站攻击拦截、以及流式有界解析全部需要自研，极易引入边界漏洞。

结论：保留 Fastify 5。Fastify 在单机 20 并发下的常驻内存仅 ~35MB，其内部基于 Radix Tree 的路由器、Ajv 编译的高性能 JSON 序列化、以及开箱即用的插件封装体系，完全在 2 核 / 2GB 的轻松承载范围内，是生产可靠性与开发效率的最佳平衡点。

(2) better-sqlite3 vs node:sqlite

Node.js 官方在近期版本（v22.5+ 及 v24）中引入了内置的 node:sqlite（当前以 DatabaseSync 等同步 API 暴露）。

然而根据 Node.js 官方文档与现状，node:sqlite 的关键外围能力仍存在局限：缺乏稳定且可细粒度控制的 Online Backup API 绑定、缺少底层的事务状态回调控制以及经多年检验的大容量二进制直接内存映射支持。

better-sqlite3 则是经过无数生产系统验证的成熟 C++ 扩展，其同步性能至今仍是 V8 体系的标杆，原生提供完善的 db.backup()、严密的事务包裹器（db.transaction()）与精准的原生 Buffer 处理能力。

结论：坚决保留 better-sqlite3 13.0.3。切勿为了所谓的“零依赖”切换到一个实验性或功能残缺的底层库，这与科研严肃性背道而驰。

(3) idb vs 原生 IndexedDB

idb 8.0.4 本质上是一个仅约 1.5 KB 的无依赖超轻封装层，它只做了一件事：将 IndexedDB 极其反人类的 DOM 事件回调（onsuccess / onerror）映射为标准的 ES Promise。

手写原生 IndexedDB 包装并不能带来任何可感知的运行期提速，反而极易在事务自动提交（Auto-commit）时机把控失误时引发难以定位的死锁与静默静默丢失。

结论：保留 idb。

(4) 为何 Vite / tsx / Playwright 不产生生产运行开销？

Vite 与 tsx 属于开发时编译与构建工具。生产环境下，服务端通过 node dist/server.js 直接执行预先转译好的纯原生 JavaScript 代码；前端则是经过 Rollup 彻底 Tree-shaking 后的纯静态 HTML/JS/CSS 文件。

Playwright 仅作为 devDependencies 存在于 CI/CD 或本地测试机中，生产环境通过 npm install --omit=dev 安装依赖，生产镜像或服务器环境中连 Playwright 的二进制包与浏览器内核都不会部署。

结论：开发构建工具链的大小与生产服务器的并发承载力和内存开销完全没有物理因果关系。

3. synchronous = FULL 下的单 DB-Writer Worker 机制与背压设计

在 SQLite WAL 模式下，PRAGMA synchronous = FULL 意味着每次写事务 COMMIT 都必须调用底层的系统调用对 WAL 文件执行实际的 fsync（在 macOS 上为 fcntl(F_FULLFSYNC)）。   
SQLite

(1) 主线程直接执行的致命缺陷

如果将 better-sqlite3 的写操作放在 Fastify 所在的 HTTP 主线程，当 20 个被试在同一秒提交 10 个数据切片时，即使每次磁盘 fsync 仅耗时 5ms，10 次串行阻塞就会使整个 Node.js 主事件循环挂起 50ms。在此期间，所有的 HTTP 接入握手、心跳响应与静态资源分发全部停滞。

(2) 单专用 DB-Writer Worker 架构

必须建立单一专职写线程（Dedicated Worker Thread），主线程保留只读连接（只读查询不受 WAL 写锁阻塞），写操作通过内部队列投递给 Worker。

[20 并发客户端 HTTP POST]
           │
           ▼
[Fastify HTTP 主线程 (只读 DB 连接)]
    │  1. 校验 Schema / 签名
    │  2. 检查 Worker 队列深度 (< 100) ──(超限)──► [返回 HTTP 429/503 + Retry-After]
    │  3. 包装 PendingRequest (含 Promise)
    ▼
[内存有界优先队列 (Bounded In-Memory Queue)]
    │
    ▼ (Worker 批量拉取: 最多 30 条 或 最长等待 5ms)
[Dedicated DB-Writer Worker (独占读写连接)]
    │
    ├─► BEGIN IMMEDIATE;
    ├─► 循环执行 INSERT/UPDATE (预编译 Statement);
    ├─► COMMIT;  <─── [触发物理 fsync(wal)]
    │
    ├─► 成功: 批量通知主线程 Promise.resolve() ──► [向客户端发送 200 OK + ACK]
    └─► 失败/异常: 批量触发 Promise.reject() ──► [向客户端发送 500 错误]

(3) 不可违背的核心合同约束

绝不允许“进内存队列即发 ACK”：必须等 Worker 成功完成 COMMIT 并收到系统调用返回后，才向客户端发送包含事件哈希的 HTTP 200 ACK。如果在未 commit 前返回 ACK，进程意外崩溃或系统断电将导致数据静默丢失，彻底推翻“不可静默缺失”合同。

严格的组提交（Group Commit）边界：

单批次合并数量上限设为 30 条；

最大等待延迟设为 5 毫秒（若队列为空，新到第一条请求启动 5ms 倒计时，若期间有新请求则合并，倒计时结束或达到 30 条立即触发 BEGIN IMMEDIATE ... COMMIT）。

队列饱和度与 429/503 背压：

Worker 积压队列深度硬上限设为 100 个批次；

一旦达到 100，主线程直接拒绝后续写入请求，返回 HTTP 429 Too Many Requests 并设置 Retry-After: 1；

客户端捕获 429 后，保持数据留在 IndexedDB outbox 中，按照指数退避（Jittered Exponential Backoff）重试，绝不丢弃本地副本。

RPC 消息开销与状态判定：

主线程与 Worker 之间采用 Node.js 原生 worker_threads 的 MessagePort 传递消息，序列化成本极低（微秒级）；

若 Worker 发生不可恢复的内部崩溃，所有当前积压的 Promise 必须一律标记为“未决拒绝（Unknown Disposition）”，通知主线程报错，同时由主线程重新拉起 Worker 实例，并利用 SQLite WAL 自身的前滚/回滚机制恢复自洽状态。

4. 逐帧/高频日志的轻量编码与有界事务策略

科研要求对“持续按住、多点触控、帧间隔抖动”进行完整审计，但如果将每一帧都抽象为包含大量英文字段名的独立 JSON 并在每个事件触发时写入，会导致：

本地存储快速达到几十兆；

服务端在解析和插入百万行数据时数据库急剧膨胀。

(1) 列式紧凑增量编码（Delta Encoding）

在不丢失任何原始时间戳与物理事实的前提下，前端时序收集器在内存中聚合单次 Trial 的高频事件流，采用定长扁平数组或列式结构：

传统膨胀格式：

JSON
[
  {"event": "frame", "frame_idx": 1, "t": 1711000000.123, "delta": 16.66},
  {"event": "frame", "frame_idx": 2, "t": 1711000000.139, "delta": 16.67}
]


轻量规范格式（单次 Trial 提交一个 Block）：

JSON
{
  "schema": "trial_telemetry_v1",
  "base_time": 1711000000123,
  "frames_delta_us": [16667, 16670, 16658],
  "input_events": [
    [10234, "down", 1, 320, 240],
    [10500, "up", 1, 320, 240]
  ]
}


每个数据块在前端完成序列化后，执行以下关键步骤：

计算规范化字节流的 SHA-256（作为该 Block 的 event_id 与内容摘要）；

存入本地 IndexedDB 作为单条原始记录；

通过 HTTP 单次请求推送到服务端。

(2) 服务端存储策略

服务端在关系表层只存储元数据与校验摘要（trial_id, event_id, sha256, writer_epoch, status）；

高频采样数据以原始 UTF-8 字节流（BLOB）直接持久化存储在 SQLite 中，不执行二次 JSON 解析重写；

导出或后续分析时，再通过离线脚本流式展开为宽表或时序 CSV。

这样既严格保全了“一次编码精确 UTF-8 原始字节、同 ID 异 hash 冲突阻断、完整链条凭证”的铁律，又将网络 I/O、内存解析与数据库事务数量降低了两个数量级。

推荐系统架构简图
                       [ 客户端 / 浏览器环境 ]
 ┌───────────────────────────────────────────────────────────────┐
 │ [极简入口 SPA Router]                                          │
 │   ├─► /survey/*   ──► [SurveyJS 动态懒加载 Chunk (~400KB gz)]  │
 │   └─► /trial/*    ──► [Canvas 运行时 + PRNG 核心 (~35KB gz)]   │
 │                         │                                     │
 │  ┌──────────────────────┴──────────────────────────────────┐  │
 │  │ 本地可靠性层: idb (8.0.4) Outbox 存储引擎                │  │
 │  │   ├─ 规范化 UTF-8 编码 ──► SHA-256 签名计算              │  │
 │  │   ├─ 状态机门控 (QUEUED -> STAGED -> ONSET)              │  │
 │  │   └─ 未经服务端 ACK 绝不删除本地副本                     │  │
 │  └─────────────────────────────────────────────────────────┘  │
 └───────────────────────────────┬───────────────────────────────┘
                                 │ HTTP/1.1 or HTTP/2
                                 │ (Origin/CSRF/Permit 栅栏)
                                 ▼
                     [ 宿主机: 2核 / 2–4GB ]
 ┌───────────────────────────────────────────────────────────────┐
 │ 前置网关: Caddy 或 Nginx (~15MB 内存)                         │
 │   ├─ 终结 HTTPS (自动证书)                                    │
 │   ├─ 静态资源直出 (assets/ 目录, 启用 sendfile + 强缓存)       │
 │   └─ 动态流量转发 ──► [Unix Domain Socket]                    │
 └───────────────────────────────┬───────────────────────────────┘
                                 │
 ┌───────────────────────────────┴───────────────────────────────┐
 │ Fastify 5 主进程 (~45MB 内存)                                 │
 │   ├─ 只读连接池 (better-sqlite3 Readonly Handle)               │
 │   ├─ 请求鉴权、Schema 校验与令牌桶流控                        │
 │   └─ 内存有界队列 (上限 100 批次) ──► 满载直接返回 429/503    │
 └───────────────┬───────────────────────────────┬───────────────┘
                 │ (IPC: MessagePort)            │ (按需派生)
                 ▼                               ▼
 ┌───────────────────────────────┐ ┌─────────────────────────────┐
 │ 专职 DB-Writer Worker         │ │ 离线 Export/Backup Worker   │
 │   ├─ 独占读写连接 (WAL+FULL)  │ │   ├─ 隔离运行 (避免主库锁)  │
 │   ├─ 组提交 (≤30条 或 ≤5ms)   │ │   ├─ Online Backup API 快照 │
 │   ├─ COMMIT 确认后释放 ACK    │ │   └─ 有界流式物化 CSV/Gzip  │
 │   └─ 独立负责 WAL 维护管理    │ └─────────────────────────────┘
 └───────────────────────────────┘

落地演进优先级建议

P0（阻断性基线，必须立刻落实）：

Vite 打包路由隔离：切断 main bundle 对 SurveyJS 的静态强依赖，将问卷与 Canvas 时序运行时彻底拆解为独立异步 Chunk。

Fastify 写解耦与 DB-Writer Worker：禁止在 HTTP 请求主线程中执行 better-sqlite3 同步写事务；建立专职写线程并落地 Group Commit 与有界队列背压（防主线程假死）。

精确 UTF-8 序列化与签名管线：统一前端 TextEncoder 摘要计算规范，固化“服务端 Commit 成功前绝不发 ACK、客户端未收到 ACK 绝不清除本地数据”的原子合同。

P1（稳定性与性能保障）：

静态资源与出口限流解耦：接入 Caddy/Nginx 处理静态大图直发与 HTTPS 终结，避免 Node 事件循环分发大文件导致拥塞。   
Bun

高频事件增量编码：实现 Trial 维度的列式增量压缩与 BLOB 存储，压缩时序日志传输与落盘开销。

单次 Admission 事务核销与状态机栅栏：实现 writer_epoch 与二次打开终结协议，杜绝多 Tab 污染与旧凭据推进。

P2（长期演进与维护闭环）：

备份与导出离线 Worker：基于 db.backup() 隔离生成副本后再行导出，避免长读事务拖垮 WAL 检查点。   
Medium

根据真机测试决定是否启动 6 题型自研渲染器。

建议后续聚焦的三个专项讨论

专项一：WAL + synchronous = FULL 下的 DB-Writer Worker 核心实现协议

深入剖析 Worker 进程的 IPC 通信协议、Group Commit 的微秒级计时器与批次阈值调优、进程崩溃时的未决状态（In-flight Requests）幂等补偿策略。

专项二：时序呈现引擎、微信 WebView 特异性与软硬件 Onset 隔离防御

攻坚微信浏览器内的手势与弹性滚动劫持、Canvas 在各种移动端 DPR 下的绘制对齐、双触与滑动手势的输入判定、以及真实渲染时间戳（requestVideoFrameCallback / rAF + Event Loop 偏移）的捕获精度与合法性标记。

专项三：动态补测状态机（xoshiro128、抽样预算、安全插入）与全链路不可篡改凭据校验

细化 PRNG 黄金向量比对用例、验证“STAGED 未出现前迟到答对且无撤销时坚决终止会话”的不可逆状态机转移条件，以及同 ID 异 hash 冲突审计表的存储与恢复标准。

ROUND_1_COMPLETE
