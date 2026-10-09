# Gemini 问卷前端讨论

日期：2026-10-08–09。用户要求与 Gemini bridge 讨论并落实简洁、低占用的纯色问卷前端，随后明确要求禁止双向滚动、使用按钮交互、仅个人信息允许文字输入。三轮完整输入与回复均保留；最终实施取舍见[问卷前端轻量化与纯色设计](../问卷前端轻量化与纯色设计.md)。

会话：[原始讨论](https://gemini.google.com/app/a7735975adb94979)。沿用当前 Gemini 会话；首次请求使用不支持的 `conversation_policy=new` 返回 INVALID_REQUEST，未发送内容，随后以 current 正常完成。

| 轮次 | 输入 | 回复 | 请求 ID | 结果 ID / 完成标记 |
| --- | --- | --- | --- | --- |
| 设计 | [design.prompt.md](design.prompt.md) | [design.response.md](design.response.md) | bpl-frontend-design-20261008-a | res_53f8b7638c4c4eefc0c7 / FRONTEND_DESIGN_REVIEW_COMPLETE |
| 代码审查 | [code.prompt.md](code.prompt.md) | [code.response.md](code.response.md) | bpl-frontend-code-20261008-b | res_d0ec3263bb2c1c048666 / FRONTEND_CODE_REVIEW_COMPLETE |
| 固定视口与交互 | [interaction.prompt.md](interaction.prompt.md) | [interaction.response.md](interaction.response.md) | bpl-viewport-interaction-20261008-c | res_f58e08dbdebf6b7025f9 / VIEWPORT_INTERACTION_REVIEW_COMPLETE |

第一阶段采用原生四题型、单次挂载、隐藏题禁用并保留草稿、量表数值转换、纯文本、独立极简 CSS、冻结灰色/深色背景和保留长说明的建议。最终阶段进一步改为逐题按钮导航和按段阅读；此前 radio/checkbox 同屏表单不再是最终实现。文本 input 修订即时写入现有 IndexedDB 队列，不采用防抖、失焦才保存或只保存临时草稿。当前 Answer 仅有基本值与字符串数组，手工复制数组足以隔离异步快照，不必 JSON 序列化/反序列化。

第二轮中的“真实 Bug”标签不直接作为已确认缺陷：

| 意见 | 代码取舍 |
| --- | --- |
| 文本 input 被过滤/条件写反 | 原条件让文本 input 通过，修订测试验证未离焦输入也保留。为兼容 change 型填充，简化为文本同时接收 input/change/compositionend，比较实际值避免重复修订 |
| compositionend 被过滤/目标错误 | 原分流允许文本 compositionend，冒泡目标仍是输入控件；合成结束分支与焦点测试通过。保留显式 composing 标志，合成期间不提交或切换文本分支 |
| 隐藏题未清除 aria-invalid | 原 visibility 已调用 clearError；隐藏题的错误状态会清除，重新显示/提交按当前值校验。进一步仅在确有错误时修改这些属性 |
| runner.css 覆盖问卷宽度 | runner.css 只由 run.ts 导入，正式问卷不加载；生产 manifest 和浏览器请求路径可区分两入口 |

不采用“运行中绝对禁止任何 DOM”的扩大断言。本轮保留既有每次 ONSET 的计数文本及固定高度状态区，未改图片调度与时序证据。没有实测就不能断言它造成丢帧；运行中的主题监听、动画和额外渲染也没有引入。

第三轮采用可见视口绑定、非输入拖曳阻止、字素边界分页、短屏输入布局、分支回溯、同步提交锁和 Canvas 固定槽位。选项使用原生切换按钮及 `aria-pressed`，保留原生 Space/Tab 和显式方向键焦点导航；没有照搬“必须同时保留隐藏 radio/checkbox”的建议。过长选项先查看全文，再明确确认；不采用文字省略后直接选择的方式。用户最终选定的用途策略落实为服务端发布约束，旧文字题不会被自动推断为个人信息。

本地交互回归发现并修正了导航短锁误挡答案、失焦时布局移动使完成按钮丢失 click、折叠标题后 Grid 自动放置导致短屏控件裁切三项问题。24 项浏览器和 53 项单元/故障检查全部通过；手机键盘由短视口和合成事件模拟，真实设备验收仍单独执行。

测量：[改前](frontend-before.json)、[第一阶段](frontend-after.json)、[最终版本](frontend-interaction.json)。脚本 `scripts/profile-frontend.mjs` 从生产 manifest 递归收集入口 HTML、静态 imports、动态 imports 和 CSS，按同一 gzipSync 默认参数计算。第一阶段问卷为 17209 B gzip；新增完整交互后为 20299 B，相比原来的 444959 B 减少 95.44%。初始入口和图片运行入口单独报告，不能把完整问卷降幅套用到它们。[界面截图](previews/)与最终设计文档一起留存。

本轮没有请求 Gemini 网络研究或进行独立外部资料核验。原文中 DOM、浏览器行为或亚毫秒开销的推测不当作实测数据；本地工程回归也不替代真实设备或服务器验收。

2026-10-09 用户进一步明确：李克特量表改为预设端点文字的坐标轴输入，取消所有选项分页，单选选项不可跨页。因此第三轮中“下一组选项”和长选项独立阅读的建议已被撤销；当前实现让全部选项在网格中完整显示，空间不足时阻止继续。轴线不预填分值，端点文字在发布时强制校验；当前测量见 [frontend-axis.json](frontend-axis.json)，交互与截图以最终设计文档为准。上述 Gemini 原文作为历史记录保留。


2026-10-09 本轮 JSON 管理与图片／协变量讨论（完整请求和回复保存）：

| 轮次 | 输入 / 回复 | 请求 ID | 结果 ID |
| --- | --- | --- | --- |
| 整体设计 | [输入](json-workflow.prompt.md) / [回复](json-workflow.response.md) | bpl-json-workflow-20261009-d | res_02e22088c47866d93d6c |
| 方向与模拟 | [输入](json-orientation-code.prompt.md) / [回复](json-orientation-code.response.md) | bpl-json-orientation-code-20261009-e | res_d2c1ddf8cfa95e1720aa |
| ZIP 与图片 | [输入](json-zip-code.prompt.md) / [回复](json-zip-code.response.md) | bpl-json-zip-code-20261009-f | res_7c49fe94dac0e4e65dfe |
| JSON 管理与协变量 | [输入](json-admin-code.prompt.md) / [回复](json-admin-code.response.md) | bpl-json-admin-code-20261009-g | res_c0c26f3df7cbcf725fbb |

长代码请求两次超过 bridge 输入长度，均 INVALID_REQUEST 未发送；随后拆为上述三轮代码讨论。问卷星页面和 Formbricks 仓库在设计请求前阅读，Gemini 的 metadata 链接与研究内容直接作为讨论参考，没有独立再次检索验证。

采纳：逐刻度 labels 与整数答案分离、严格 JSON 文件管理、版本冻结与软删除、ZIP 名称/路径映射、无权限环境元数据、标头校验能力限制；代码阶段修正 rejected gate 缓存、模拟器方向提示、上传重试 Study/包身份、JPEG 边界/SOF、WebP 画布与像素尺寸一致性、DEFLATE 输出预算，补充色域/HDR/输入媒体查询和语言容错。

保留工程约束：方向监听须持续阻断作答中违规旋转，因此没有按 Gemini 建议在第一次通过后删除监听器；页面不是 SPA，pagehide 清理已实施。方向依页面可用宽高及焦点宽度稳定判定，不能在桌面分屏中直接拿物理 screen.orientation 替代，也不能认为 orientation 媒体查询永远不受键盘布局影响。没有截断量表标签。labels 数量已由 parseProtocol 校验，Gemini 认为编译器完全未校验的判断不成立。ZIP 路径正则原本已拒绝反斜杠；原长度/CRC 检查遇首个非法展开即失败，不会解出 200 个伪造长度条目。仍将解压硬上限收紧至申报大小。标准 streaming ZIP 保留并校验 Data Descriptor，没有一概禁用；WebP 保留准确 RIFF 长度/尾部检查，没有采纳放松完整性建议。WebP 的 ICC/XMP 不等同动画，不因色彩元数据一律拒绝。所有最终选择见 [实现说明](../JSON问卷与图片包.md)。

本轮最终验收：npm run check 通过 57 项单元及 28 项浏览器检查；最后 CSS 焦点微调后复测 3 项通过。本地灰色竖屏／深色横屏模拟问卷与图片任务完成、管理端模拟和方向提示均通过；最新传输测量 [frontend-json-workflow.json](frontend-json-workflow.json) 为 25,757 B gzip（相较初始减少约 94.21%），截图见 previews/json-*.png。

2026-10-09 用户要求取消研究者／维护者区分，改为单密码登录：[输入](admin-password.prompt.md) / [回复](admin-password.response.md)，请求 bpl-admin-password-20261009-h，结果 res_ee8aa604d7f1a3c7e5b6，完成标记 ADMIN_PASSWORD_REVIEW_COMPLETE。采纳原生 form/submit、统一密码配置、role 列事务迁移和统一管理员 API。迁移使用现有毫秒时间单位，未照搬回复中以秒为单位的 unixepoch() 条件。维护任务保留各自的状态／屏障约束；备份并不禁止原始采集写入。既有登录限流已按 IP 设置有界令牌桶，保留现行限流，没有扩展为新的长时 IP 封禁机制。

验证：类型检查、生产构建、SQLite smoke、59 项单元测试与 29 项 Chromium 浏览器测试通过，覆盖旧角色登录表迁移、有效期、统一管理权限、错误密码、Origin/CSRF、限流、回车／点击登录、刷新和退出。本地 3081 预览已重启，实际旧库成功移除 role 列，手机尺寸登录界面及 JSON 管理功能验证通过；[登录截图](previews/admin-password.png)。

2026-10-09 新增多坐标、结束语、数据下载与主页登录：[输入](multi-axis-ending-export.prompt.md) / [回复](multi-axis-ending-export.response.md)，请求 bpl-multi-axis-ending-export-20261009-i，结果 res_ed77957cfafe2432b6f4，完成标记 MULTI_AXIS_ENDING_EXPORT_REVIEW_COMPLETE。使用 type=scales、逐轴整数/null 对象、同屏网格、条件 axis 选择器、只在服务端 COMPLETED 后显示结束语、管理员私有快照下载。未照搬仅凭本地 completed 标志跳过服务端确认的建议；刷新继续核对已有会话。导出 ID 只在尚未确认时保留，完成后再次下载生成新快照，没有按 study/revision 固定 ID 导致数据永久陈旧。轴值 null 保持 null，状态使用既有 UNANSWERED/SKIPPED/UNCONFIRMED/NOT_REACHED，未另造统计状态。诊断页移至管理员登录后可访问的 diagnostics.html，问卷及结束页无管理入口。

工程回归补齐经过鉴权的单作业状态 GET，保证丢失导出回应后刷新复用原产物；小屏多轴题干使用紧凑提示，尺寸变化复用坐标轴 DOM。单个轴仍保留至少 44px 输入区域，可选清除按钮也保留 44px；没有套用回复中不经设备验证的 56–68px 单轴高度假定。实际空间不足会阻止继续，不截断或分页轴。

本轮验收：类型检查、构建、SQLite smoke、62 项单元及 32 项 Chromium 浏览器测试通过；本地 3081 完成灰色/深色三坐标题、图片任务、结束语及刷新，并实际下载含 axis_answers/covariates 的 CSV。生产闭包 [frontend-multi-axis.json](frontend-multi-axis.json) 为 27,773 B gzip。[灰色多坐标](previews/multi-axis-gray.png)、[深色多坐标](previews/multi-axis-dark.png)、[灰色结束语](previews/ending-gray.png)、[深色结束语](previews/ending-dark.png)、[主页登录](previews/admin-home.png)、[数据下载](previews/admin-data-download.png)。


2026-10-09 知情同意与手机 LAN 测试：[输入](consent-lan.prompt.md) / [回复](consent-lan.response.md)。请求 bpl-consent-lan-20261009 返回传输等待超时，随后读取同一对话，确认对应用户内容、未停止／不再生成的回答及 CONSENT_LAN_REVIEW_COMPLETE；保存的对话结果 res_1e82258091c189428c1e，completeness=complete。采纳方向→同意→设备采样→建会话→图片准备的顺序、冻结文档哈希、服务端时间、不可改写同意记录、双层 CA/TLS 与 HTTPS 测试。返回材料直接用于设计，没有独立再次检索验证其中的移动系统说明。

工程实现采用 `{accepted:true,document_hash}` 的明确同意凭证；导出沿用 table/data_json 合同增加 consents，未改造成不兼容的 CSV 顶层列。拒绝在任意段落可用，没有照搬只在末页提供拒绝的方案。同意按钮仅在末段可用；阅读优先按完整段落分段，所有文字保留。客户端在同意前只有本地恢复标识，服务器没有 session、consent、covariates 或作答写入。旧版本未配置 consent 时不增加可选字段，也不制造空同意时间；null 仍按严格 JSON 合同拒绝。未安装 mkcert 或自动改动全局信任库，使用已有 OpenSSL 建立保存在 .local 的 CA 与证书；手机自行下载公开 CA 并启用系统信任。未给 Web Crypto、UUID、Web Locks 加入不安全的替代实现。

验收：类型检查、生产构建、SQLite smoke、64 项单元及 34 项 Chromium 浏览器检查通过；最后分页与标题改善后针对性复测 6 项通过。本机 `0.0.0.0:3081/3082` 运行隔离 TEST_ONLY 实例，使用实际局域网地址完成灰／深主题全部作答、图片任务、结束语／刷新、单密码管理登录与含 consents 的 CSV 下载；TLS 链及 IP SAN 用本地 CA 验证，HTTP 问卷跳转保留 version，CA 下载字节一致。证书说明页三尺寸无滚动或裁剪。问卷闭包 [frontend-consent-lan.json](frontend-consent-lan.json) 为 29,709 B gzip。

截图：[灰色同意](previews/consent-gray.png)、[深色同意](previews/consent-dark.png)、[灰色拒绝](previews/consent-declined-gray.png)、[深色拒绝](previews/consent-declined-dark.png)。手机流程使用 Chromium 触控模拟，并允许本地证书例外；实机浏览由用户接下来测试。
