第4轮：最终全模块收敛。请在同一对话给简洁、可执行的最终结论（覆盖最初13部分），主动审查并修正前3轮的不精确说法，不要新的笼统性能保证。

必须修正：
1 MPA分离的是文档入口和依赖图，浏览器可能共享renderer或延后GC/BFCache，不能“跳转即独立V8heap、全部内存已回收”。runner入口无SurveyJS是确定构建属性，实际内存与时序仍需真机。跨页先服务端已锁页凭证/进度确认，普通localSaved不够；新clock_epoch；group permit到达并就绪才发；不把可用session token放URL。
2 原始事件/digest包含身份、schema、scope/位置等字节；event_id独立，不能根据两份载荷相似就断言同hash。同ID/hash重试保留pending/quarantine当前语义，正常/终止各对应seal/reconciliation策略，不发明全任务SEALED状态覆盖原分层。
3 ONSET/INPUT等已观测事实不可能在事实发生前落盘；只对“未来队列/取消/开始意图”实施本地成功截止点，随后原始事实增量保存；不能以所有事实先commit才能下一阶段改变固定图片/ISI。
4 准备期下载/解码失败先阻断开始并可修复/重试，计时组故障才不可逆终止。onset使用冻结的draw-call参考而不是“下一eventloop再判”，rAF参数物理含义不过度解释。
5 PNG/WebP/JPEG magic+结构+头宽高不能保证压缩内容真正可解码。推荐“先有界格式/静态性/像素结构检查，必要完整解码由成熟decoder放在受限maintenance worker中执行，明确不转码原图；缓存校验结果，正式图片serve不解码”，不要为零依赖写完整图像codec；具体库评估在P3锁定，不能继续说轻量头解析已充分。
6 HTTP浏览器cache并不归CacheAPI管理，删除CacheStorage不能清除HTTPcache。首版私有研究图片建议Cache-Control:private,no-store,no-transform并同源授权stream，组前内存复用/hash去重，组内无需下载；不要用共享设备private max-age+宣称会话后清理所有cache。publichashed JS/CSS仍可immutable；后续私有缓存需受验收授权与隔离合同。
7 clearInvisibleValues等UI选项不可抹掉已有原始记录或把未知分支当skipped。分支AST白名单是范围控制，未经证据不要称SurveyJS通用表达式必然任意JS注入。SHA不是签名，研究者鉴权不需新增PKI。
8 worker、readonly、decode、gzip无不受限RPC/循环/await，不能承诺“零阻塞/完全无争用”。协议critical数据库检查在事务内。checkpoint用PASSIVE也有耗时，RESTART/TRUNCATE不是默认fallback。重启不清未决pin/permit，unknown转final禁止任意复活。
9 仓库实际只回归了BLOB/唯一/事务/读视图/backup reopen，并未测SQLite锁等待、worker或20人业务；不要把proposal当implementation。网页bundle已经拆分；我正增加publicJS/CSS的build-timegzip/br、cache区分及减少自动200日志，全用原生能力，无runtime新依赖。
10 你返回的一手来源若有，请完整列出真实链接并对应支持的功能；无可靠来源则明确“建议/待测”。无需展开未核对Node API成熟度。

最终请给：
A “精简首版”目标架构（一个Fastify+SQLiteWAL/FULL+一个DBworker；按需一个maintenanceworker；浏览器research/survey/runner依赖分离；idb原生Canvas；复用已有HTTPS，若无才一个反代；无ORM/Redis/cluster/WebSocket/PWA/S3/任意脚本）。
B 13模块决策表：现在选择/为什么够轻/必须保留的合同/马上能做与后续任务/验收。
C 不能删的可靠性复杂度和可以推迟的功能。研究管理/条件表/版本/数据质量/CSV仍是用户要的，不能删成纯实验小玩具。
D 测量触发替代条件：什么时候重评native有限DOM、node:sqlite、GroupCommit、独立静态服务/PG，避免先写一堆逃生复杂框架。
E 按P0/P1/P2-P4B安排具体任务和阻塞依赖；明确此次讨论没有证明正式采集并发。
最后列出尚有的“开工阻塞问题”和“后续测量准入”，若无开工阻塞仅代表可按方案实施，并非可靠运行。结尾ROUND_4_COMPLETE。
