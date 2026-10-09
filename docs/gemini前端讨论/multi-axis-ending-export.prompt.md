继续当前问卷实现。新增要求：一题多个李克特量表坐标；结束语页面；管理问卷卡片增加下载数据；主页 / 为密码登录/问卷管理，受试者只收到 participate.html?version=... 链接。所有参加者页面继续纯灰/深色、禁止双向滚动、按钮操作、只有个人信息开输入法。
具体方案：新 JSON 题型 type:"scales"，axes:[{id,title,labels,min?}]，2–6 轴；同一题全部坐标轴同屏，窄屏竖向、宽屏网格；每轴标签首尾作为两端，所选反馈为标签，未触碰无默认答案。答案以 {axisId:整数或null} 保存在同一个 questionId 下；必答需全部轴选择，可选题允许部分空值。保留原始事件/离线保存/冻结协议；对象答案用浅拷贝隔离异步，服务端校验轴名/整数范围/未知轴。拟支持条件选择器 condition.axis:"axisId"（不能直接将整个对象与字符串数值比较）。JSON 顶层 ending:{title,text}（可省略，默认感谢及已保存），仅服务端 finalize 确认为 COMPLETED 后展示；过长结束语按钮分段阅读，刷新仍展示。
下载使用现有单维护 worker EXPORT 和经过管理员鉴权的 data.csv/manifest.json，不创建新导出接口；卡片下载按钮生成一个稳定 job/request ID，完成后点击下载（保留失败时同一 ID 重试避免重复作业）。CSV 原有 table/data_json 包含 question_states，可额外逐轴输出 axis_answers 行（qid/axisId/value/label/state），禁止把未作答当零。
主页加载原 admin.ts，旧开发检查页移到 diagnostics.html，旧 /admin.html 仍兼容相同管理入口；参加者/结束页面无主页或管理入口。
请简短审查交互及数据语义，尤其多坐标同屏、部分未答、导出快照与完成/重试。不要联网或建议新大型依赖，结束 MULTI_AXIS_ENDING_EXPORT_REVIEW_COMPLETE。
