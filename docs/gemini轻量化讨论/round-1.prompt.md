这是 Browser Psych Lab 的新一轮架构讨论。用户明确要求“项目足够轻量以确保并发能力和稳定性，对当前项目每个部分都讨论，找到更适合、更轻量的方案”。请把你当作参与讨论的架构师，不只给泛泛的技术栈名单。先第1轮全栈筛查，后面我会带反例继续讨论。不要把库较小直接等同于并发可靠，不要编造性能数字。可搜索一手文档支撑建议，给链接并保留不确定性。

实际目标/约束：
- 非商业科研、自托管、一台2核/2–4GB服务器，通常最多20名参加者，集中预加载/组间同步须测；一个主要研究者，无团队邀请。
- 浏览器普通问卷：说明、单选、多选、量表、短文本、分页、有限条件分支。研究列表→卡片编辑→冻结发布→匿名公开链接→质量查看与CSV导出。无任意脚本/HTML、音视频或通用流程设计器。
- 单张静态PNG/JPEG/WebP，统一比例完整显示留白，底部固定选项；一般几十至一百trial，图片多<500KB、显示通常>=100ms。组前全部必需图片下载/解码/布局门控；组内无网络等待；两种模式：组间可停/全任务连续。
- Canvas和帧调度，只有图片窗第一次合法新触下有效；点击不提前推进；空屏/多点/持续按住等日志；软件onset不是物理曝光。时序组切后台/卡顿/本地写失败终止整个会话，只允许补传，不允许重做；问卷/组间可恢复。微信等内置浏览器是待验收支持目标。
- 动态补测：图片超时或错误可追加；每根默认最多2次，可配置有限cap；未执行安全后缀随机插入，尽量隔3个其他trial、尾部不足取安全尾部；图片/空屏单次时长不变。队列操作与下一实例开始意图需截止点前本地事务成功；QUEUED/开始意图未决保护/STAGED/已softwareonset边界明确。STAGED尚未出现时迟到答对且无安全撤销，用户要求终止整个会话；onset后纠偏保留本次固定阶段和原记录。不新增等待/填充trial。PRNG xoshiro128**1.1、16字节独立种子、精确拒绝抽样、有限draw_budget，C参考和两个黄金向量已有。
- 数据不可静默缺失：一次编码精确UTF-8原始字节/稳定event_id/SHA256，原始记录不可覆盖；同ID异hash另存冲突；custody/disposition/seal分层，逐事件精确凭证；数据库commit后ACK；seal前保留本地唯一副本。完成核对需要集合/位置/摘要，不能总行数；TERMINATED不可变COMPLETED。
- 服务端writer_epoch/fence+未关闭permit独占，不依赖组内心跳/静默租约失效；第二tab只读，显式未知恢复关闭旧许可并终止，不重跑。旧epoch补传允许历史接管但不推进当前状态。
- 方案由server预留、正式开始事务核销一次，中止不退回；接入暂停只挡新admission，既有凭证者可推进/补传。
- 文件系统三个私有逻辑区assets/exports/backups，无S3服务。先上传意向、私有完整暂存、校验真实静态格式/像素/摘要、同卷不覆盖硬链接发布/fsync/DB登记分阶段恢复；无自动物理GC，维护删除需refs/pins+DELETING→unlink→PURGED，故障/未决不删。
- CSV默认全部会话状态+raw/字典/冻结版本/质量标记；单一致快照、有界流式物化后释放事务再压缩；源异常可部分导出，导出本身遗漏不可READY。
- Cookie/CSRF/Origin/会话不透明凭据、角色边界、默认纯文本、数据保留、独立备份及联合恢复、HTTPS必须在采集前落实。

当前已存在的代码：只是TEST_ONLY环境骨架，业务表/接收/编辑器/运行器未实现，不应拿正式数据试错。
技术：Node24.21.0+npm11.19，TypeScript6.0.3，Vite8.3.3，Fastify5.12.5+@fastify/static10.1.5，better-sqlite3 13.0.3(实测引擎3.53.4)，idb8.0.4，survey-core/survey-js-ui3.2.0，Playwright1.64.0 dev-only。
用户已确认SQLite替换PG。WAL、synchronous FULL、foreign_keys ON、busy_timeout3000ms，mac fullfsync开启；同步better-sqlite3目前放HTTP主线程，只做health查询；SQLite原始BLOB/唯一约束/事务/读快照/backup reopen的隔离夹具通过，不代表压力/断电/业务验收。正式写短BEGIN IMMEDIATE，不在事务await，export/maintenance原计划受限worker。
备份修订：资源生命周期屏障下先Online Backup API完整生成数据库副本，从完成副本读该视图资源清单，源DB短事务持久BACKUP_PIN核验，再释放屏障复制真实资源到独立目标，完成校验才READY。无pg_export_snapshot。
前端无React/Vue本项目框架，SurveyJS3 vanilla包内部有Preact。当前main静态import SurveyJS+整个CSS+idb，环境检查和问卷同bundle。
实际生产构建：JS1684.026KB(gzip383.04KB)，CSS519.908KB(gzip50.08KB)。锁文件152个package entries含平台可选项，非dev标记约78个；不是运行RSS。只通过type/build/DBsmoke/2个Chromiumtest，未测20人。
8个本地固定源码参考：SurveyJS/idb/Fastify/better-sqlite3作为源参考；jsPsych/lab.js/JATOS/Formio只参考、不runtime；未引入Creator/S3/ORM/Redis/消息队列/cluster/Docker。dev tsx/Vite双进程；生产单Fastify网页API；logger:true目前每请求记录。

请按这些模块逐项给“当前成本/具体瓶颈/候选轻量方案/推荐/保留可靠性合同/需要实测/迁移代价”的对照：
1问卷渲染与分支 2卡片编辑器/研究后台 3图片呈现/输入/动态队列 4预加载与解码/图片规范 5IndexedDB/outbox/字节hash 6Fastify与HTTP上传/静态服务/日志 7SQLite驱动/主线程vs专用DBworker/排队背压/索引checkpoint 8共享协议和状态合同/派生表 9文件发布/网关/清理 10导出/备份/后台作业 11认证/安全/限制 12生产部署进程/HTTPS/静态传输 13开发构建/测试/参考代码。

重点请认真比较：
- SurveyJS保留但路由隔离/按需加载/问卷特性限制 vs 对首版6种题型自建原生DOM有限renderer（引入自研稳定性风险）。哪些地方现在就能安全减负？
- Fastify保留 vs Hono/node:http，SQLite better-sqlite3 vs node:sqlite（已有固定Node版本），idb vs原生IDB，Vite/tsx/Playwright为何不计生产运行开销。
- 同步FULL不能为吞吐换NORMAL丢ACK耐久性。单DBwriter worker的消息/RPC开销、可审计请求/未知提交、队列上限与503/429、不能内存排队即ACK、批事务不可无限合并。
- 不把关闭逐帧日志变成证据缺失；可如何轻量编码/有界事务而不破坏原合同。
请给第1轮推荐简图与优先级，并指出最有价值的三个后续专项讨论。结尾写“ROUND_1_COMPLETE”，以区别实质答复与生成占位。
