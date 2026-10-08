请继续做短代码审查，最多800中文字，不要大段代码，结尾写 ALIYUN_QUEUE_REVIEW_COMPLETE。
用户已选择目标 1Mbps，并明确授权添加排队机制。服务器2c4g Ubuntu26.04，盘IOPS2120/106MBs，尚未线上压测。
第一轮建议中有事实偏差：1Mbps=125000B/s，全20人平均6250B/s；项目已批量事件落盘(16条/256KB)，已有Promise.allSettled等待全部下载结束，REPLAY是worker只读读视图，鉴权必须留在写事务中防竞态，冲突不同hash必须隔离不能DO NOTHING。不要再建议改变这些合同。70%利用率只能标注规划假设，无fsync毫秒依据。
拟实现：服务端内存FIFO组前图片准备队列，默认active=1，最多64会话，不引入DB/MQ；认证+writer fence+当前group_index后才加入/轮询，返回小JSON ticket/status/position，轮询5秒加jitter排队续活、active期间20秒续活，90秒未续活删除，pagehide/取消显式释放；进程重启队列清空重新申请，不存在尚未发放的试次permit。参加者图片API仅在持有当前组READY ticket时允许下载；每次只下载当前组一张图并串行解码，原字节SHA/尺寸全部验证后release ticket才显示开始按钮；permit另有variant预约每60秒renew防5分钟过期；进入试次前所有轮询/定时器/下载已结束，本组零HTTP。
client排队总等待上限45min，active下载组预算20min，60秒流停滞看门狗，单图总时限按3KiB/s allowance计算并封顶20min；内存压缩工作集单图<=8MB+decoded budget，不添加跨页面私有持久缓存。
风险要检查：lease在慢下载时不能被误删并放行第二会话；不允许拿ticket绕过当前组资源鉴权；取消的旧ticket不得释放新ticket；已开始组不能重排；准备完成等待点击时reservation换variant必须重新准备。
另拟：构建期压缩代码原SHA身份保持release.files不含gz/br；独立representations清单存compressed hash/原文件名/原bytes，解压校验后留存归档；Accept-Encoding严格q/identity/Vary/no-transform处理；已存在一致归档只校验不再copy/fsync。请指出真正需修正之处和1Mbps排队参数的边界。
