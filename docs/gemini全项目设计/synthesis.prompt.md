全部54段/118份第一方源码、脚本、CSS/HTML、部署和构建配置已经提供。现在开始实质性综合设计讨论。请只基于这份当前代码上下文，不搜索外部资料，不把收到源码当验证过运行。用中文约1800字输出：
1. 全项目闭环逻辑表（至少覆盖协议编译/冻结发布、管理认证、方向/知情同意/环境、建会话/锁/writer、整例准入、问卷分支与修订、方案/抽样/图片准备、固定刺激/动态补测、图片评分、本地账本/补传/凭证、封存/完成、中断/重答、CSV、备份/恢复、容量/部署）。
2. 设计中应保留的关键不变量；指出模块之间的权威状态与失败语义。尤其 custody≠seal≠completed、SessionAdmission≠PreparationQueue、图片评分≠固定时序任务。
3. 给出优化优先级，聚焦当前行为的一致性与恢复，而非无测量依据的GC/Array/Map微优化。哪些立即做，哪些有真实触发证据才做。
4. 请讨论并批判以下拟实施的小范围改进：
   A. 新建共享 TASK_ACTIVITY_POLICY 常量（保留 idle120-offline300-v1 原ID及120s空闲、300s失联、60s续活、30s扫描），供浏览器监测、服务端读视图/清理、HTTP强制策略、runner声明共用，阻止参数漂移。taskLiveness 触发后自清理且只发一次中断，已stop的晚到activity响应被忽略；未知已声明task_activity拒绝，不默认为历史版本无策略；未声明字段的旧runner仍兼容。
   B. db-worker当前以“旧owner PID存活&&heartbeat>0&&距今<30s”阻止接管；旧PID仍存活但心跳停顿>30s或没有heartbeat_at时新writer可以接管。拟仅在旧PID确已退出（ESRCH）后允许新owner；不把心跳超时当作退出证据。同一DatabaseWriter替换仍依赖旧worker exitObserved。
   C. 新增现行设计与状态/故障矩阵，修订README，并给FIFO历史文档加显著被覆盖声明。源码默认session=2、preparation=1是保守起点；既有ECS 7/7只对应代表负载，不把7当所有研究通用容量。当前任务满额立即409/Retry-After1800，不创建等待队列；无groups问卷不限该名额。activity是新runner的小型控制请求，文档“所有计时组零HTTP”只适用没有activity的历史合同。
实际本轮基础执行：typecheck/build/smoke通过；105项单元测试104通过，writer故障夹具有1000ms startup timeout在全套并行时超时（测试本来会在启动后把RPC timeout降到150ms），拟使用正常启动预算，保留150ms故障时限与UNKNOWN/NOT_INGESTED断言，后续完整回归。这不是生产超时参数变更。
5. 拟实施方案若有会伤害旧冻结合同/数据可靠性的地方，请具体指出文件和替代方案。不要虚构性能提升百分比或正式准入结论。结尾给出 DESIGN_SYNTHESIS_COMPLETE。
