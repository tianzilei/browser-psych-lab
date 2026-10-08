第3轮讨论前端、浏览器时序、本地保存、图片资源与HTTP传输。前2轮的启发已采用：保留核心库、不默认Group Commit、单DBwriter+有界RPC作为P0设计，代码当前仍只是health骨架，并未声称writer已实现。已在现有检查页做低风险按需拆包：初始JS现在7.34KB(gzip3.27KB)、基础CSS0.75KB(gzip0.44KB)；SurveyJS和其CSS在“加载问卷样例”才下载(1.679MB JS，519KB CSS)。这只是初始路径变小，总体Survey载荷没有消失；尚无真实实验runner/编辑器。

请先纠正第2轮残留冲突：
- 普通第二tab绝不能自动terminate旧会话；只有明确未知恢复才终止且永不再执行。终止关闭执行权，旧原始字节仍可授权接管，不是“停止任何写入”。
- FIFO确定性和control priority不能相互矛盾：显式终止可先于未发送raw，但未发送raw不扔掉，后续按history核对；不能越过正在commit的RPC。
- 从未发送的queued请求是确定“未接管”，只有已发送/commit回复未知是UNKNOWN。不能所有pending都unknown。
- Worker超时不是可以证明死了，更不能保证terminate()立即安全结束native调用；确认exit前不生第二writer，不能确认时保持不可用。整个Node OOM可杀全进程。
- 重启不按时间“清理重置悬挂锁”：permit、upload、pin、删除、backup屏障都必须证据恢复；checkpoint不默认TRUNCATE。
- raw重试不把PENDING/QUARANTINED自动升级accepted；事务逻辑拒绝却存冲突证据也需要成功commit不同结果，不是全部rollback。
- node:sqlite缺少backup/API实验等级断言在本轮没有充分材料，最终驱动选型写“better-sqlite3现有锁定/backup/BLOB回归通过，node:sqlite待能力/修复版本验收”，不以未核对断言排除；TCP占比1%也非本项目证据。服务端研究者权限不能仅凭metadata主线程预检。

请逐项收敛：
1 多入口/MPA(/research、/participant/survey、/participant/runner) vs同文档SPA按需chunk：Survey模块加载后通常仍留在当前document JSheap；仅隐藏容器不等于释放内存。如果选实验独立document，安全页边界跳转要建立新clock_epoch/恢复服务端已确认位置、共享同源IDB、组permit在到达并准备成功后发放；绝不能组内导航/重跑。首版推荐哪种组合和迁移成本？
2 首版SurveyJS保留/有限自建DOM：不给未知源码体积/行数/研发天数；先协议字段白名单、有限分支AST(操作符/深度/节点上限)，禁eval/任意HTML；分析原生表单可访问性、触摸/量表、多选值类型、恢复回填、分支路径/隐藏题状态、页冻结/锁页实际实现成本。哪些是库能给，哪些必须我们实现？
3 rAF draw-call的时间和rAFcallback timestamp分别留，不用视频requestVideoFrameCallback测静态Canvas；LongTask仅可选诊断，微信不支持时按冻结支持矩阵，不给物理精度承诺。时间线固定前缀+安全未来suffix，原始draw/input/queue/intents都保留，不通过重排/加缓冲/延ISI减负。
4 帧诊断以有界固定数组/块封装保留原Float64原值、完整seq/clockepoch/字典、不以微秒取整/均值采样替代。一次精确UTF8编码做hash，摘要和event_id独立。关键队列/开始意图仍各截止点前commit；非关键帧块可以有界microbatch但声明尚未落盘窗口、组末需完整核对。不能以每trial结束才第一次保存一切，也不能把“commit才下一阶段”变成延ISI。
5 单个可选storage worker vsIDB主线程：structured-clone/transfer、buffer索引完整性、事件+outbox同事务、事务completed才localSaved，deadline包括往返消息；计时组不网络upload、普通页/组外jitter bounded upload。同一epoch简单状态代替复杂共享memory/Atomics，但不能弱化许可。
6 图片按像素而非KB定解码预算，source以原图校验+超预算拒绝；显式缩放转换必须生成新asset/hash并由研究者确认，不能静默改视觉刺激。 bounded下载和解码分开门控；所有资源hash/decoded/prelayout组前已ready。createImageBitmap/img.decode按目标支持矩阵验收，不假装“保证移出主线程/显存驻留”。
7 图片验证不能magic+宽高就证明完整静态可解码，需APNG acTL、WebP动画chunk、完整文件结构检查/可选受限workerdecoder；小验证器和成熟decoder库如何取舍？可以推迟服务器转码(从不服务中转码)，但不能跳静态/尺寸/真实格式验证。
8 流式privateasset网关，同源authorize+ETag按冻结asset+长期cache谨慎(凭据/共享设备cache隔离须讨论)，公开构建hash文件一年immutable、HTMLno-cache、API no-store，precompressed只有公开JS/CSS，不能public暴露研究刺激。前置反代职责TLS，首版loopbackTCP，日志减少静态访问保留有界错误/采集DB审计。
请给每项清晰推荐、失败边界、验证场景、哪些马上可落实/哪些需P0或真机。最后给20人集中预加载/最坏补测的容量测试设计(区分服务器指标与手机指标)，数字只做TEST_ONLY候选，不推断容量已满足。结尾ROUND_3_COMPLETE。
