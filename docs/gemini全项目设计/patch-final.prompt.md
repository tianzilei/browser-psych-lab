7段实施后代码与采用设计已全部提供。请给出最终实质复审（不是继续确认收件）。
补充两处小改动：package.json 的 check 现在完整执行 typecheck→build→smoke→test:unit→test:browser→test:runner，避免独立运行器回归被漏过；tests/browser/lab.spec.ts 中重新作答按钮定位从“删除此前答卷以重新回答”改为“重新作答”（exact:true），原新旧会话关联和旧本地记录保留断言不变。
实际执行：109/109 unit，37/37 HTTP/Chromium browser，5/5 独立runner均已通过；整合后的默认check正在最终执行。20项针对性测试包括过期/缺失心跳的存活owner拒绝、真实进程退出重启、客户端超时只回调一次、stop后HTTP/JSON晚到忽略、旧策略缺字段兼容和未知策略拒绝。v3混合探针36个请求中4正常完成、3准备满额、29会话满额，额外单例故障探针TERMINATED并核对保留；CSV684行、备份independent=false。v3限速探针20请求中1原图准备成功、19容量拒绝，最大1个图片流。最后会话和准备名额均为空。结果是本地合成软件流程，不是ECS新容量/物理时序/独立恢复证据。
请只指出确实由这次修改导致、可定位的高价值问题；若无确定新问题就说未发现确定阻塞并保留静态分析边界。讨论shared policy/旧runner兼容、PID保守拒绝接管、结束后的在途activity请求、v3探针拒绝与故障覆盖及文档是否一致。不要要求重新引入队列或更改已固定研究合同，不给任意数值阈值。请最多700字，结尾 PATCH_REVIEW_COMPLETE。
