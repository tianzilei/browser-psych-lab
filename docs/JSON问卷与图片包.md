# JSON 问卷与图片包

主页 `/` 作为密码登录与管理入口，`/admin.html` 保留兼容。管理端提供 JSON 上传、替换、下载、模拟、开放、隐藏、删除和数据下载。内容不在网页编辑。文件选择后先检查 JSON 语法及问卷规则；预览使用原生参加者控件，不创建参加会话、不写作答数据。上传成功会生成冻结版本，默认隐藏；点击“开放”后分发参与链接。修改使用新的 JSON 文件生成新版本，既有会话继续原版本。删除从列表移除并关闭新接入，保存历史版本、会话、资产及数据。

管理端只需密码登录，支持回车或点击登录，不区分研究者／维护者。`npm run auth:setup` 配置唯一的 `ADMIN_PASSWORD_HASH`；非交互配置使用 `npm run auth:setup -- --password-file /受保护路径/密码文件`。已有的 `ADMIN_PASSWORD_HASH` 可继续使用，旧 `MAINTAINER_PASSWORD_HASH` 不再参与登录，下次运行配置命令会移除该旧字段。登录 API 仅接收 `{"password":"…"}`，登录与 `/api/auth/me` 返回 `authenticated:true` 和 csrf，不返回角色。

旧数据库的管理登录表在启动时事务迁移，删除角色列并保留未过期凭据、csrf 及原有效期；重复启动不重复迁移。所有管理 API 使用统一管理员鉴权，HttpOnly/SameSite Cookie、Origin/CSRF、8 小时有效期及登录限流继续生效。维护 API 保留暂停／空闲、资源屏障和文件核查约束，管理网页仍只有上述问卷功能。

参考[问卷星从文本创建问卷](https://www.wjx.cn/help/help.aspx?helpid=138&h=1)的题干、题型和选项分开编写思路，这里使用标准 JSON：双引号、无注释、无尾逗号，不执行脚本。浏览器 JSON 解析器的语法错误位置原样显示。内容合同错误另显示错误码，服务端重复执行校验；本地预览通过不代表服务器已经接收图片或批准正式采集。

## 模板

可直接修改 [questionnaire.json](../examples/questionnaires/questionnaire.json)，多个坐标轴使用 [multi-axis.json](../examples/questionnaires/multi-axis.json)，图片任务使用 [with-images.json](../examples/questionnaires/with-images.json)。简化格式如下：

```json
{
  "schema": "questionnaire-v1",
  "title": "操作体验",
  "background": "#e5e5e5",
  "orientation": "portrait",
  "consent": {"title": "知情同意书（模拟测试）", "text": "这是样式与交互测试。同意后记录模拟答案和设备信息；可拒绝或关闭页面退出。"},
  "pages": [{
    "id": "survey",
    "instruction": "请选择你的答案。",
    "questions": [{
      "id": "experience",
      "type": "scale",
      "title": "操作是否方便？",
      "labels": ["非常不方便", "不方便", "一般", "方便", "非常方便"]
    }, {
      "id": "device",
      "type": "single",
      "title": "你使用哪种设备？",
      "choices": ["手机", "平板", "电脑"]
    }]
  }]
}
```

`orientation` 必须为 `portrait`（竖屏）或 `landscape`（横屏）。方向不符时显示纯色方向提示，符合后才创建会话及加载完整问卷；图片尚未下载。方向依据页面可用宽高，不依据 visualViewport 的键盘高度；输入框获得焦点且页面宽度未变化时保留已确定方向。作答中改变方向会遮住控件，恢复方向后继续原答案；图片计时运行仍按既有 resize 中断规则保存历史记录。旧冻结协议没有方向字段时保持历史行为。

量表 `labels` 按刻度从左到右排列，首尾是坐标轴两端文字，下端反馈例如“已选：方便”。默认 `min=1`，`max=min+labels.length-1`；可显式设置整数 min/max，包括零和负数，但必须逐项对应。答案始终存整数，未操作不会默认选择中间值。每个标签最多 40 个 UTF-16 单元；建议不超过 12 个汉字。文字完整显示，空间不足时阻止继续。轴线的圆角轮廓、粗细和选中刻度均为纯色，无渐变、图片或动画。

| 字段 | 用途与限制 |
| --- | --- |
| `title` | 问卷名，最多 200 个 UTF-16 单元 |
| `background` | 十六进制纯色，建议 `#e5e5e5` 或 `#202020` |
| `pages` | 最多 30 页，页面 `id` 必填，`title` / `instruction` 可省略 |
| `questions` | 每页最多 30 题，id/type/title 必填，required 默认 true |
| `single` / `multi` | choices 2–20 项，全部同屏，单项最多 200 个 UTF-16 单元，建议 20 字以内 |
| `scale` | labels 2–21 项，按整数 min/max 完整映射，不使用 choices |
| `scales` | axes 2–6 项，每轴单独 id/title/labels，所有轴同屏 |
| `consent` | 顶层知情同意 title/text，明确同意后创建会话；标题最多 200、正文最多 8000 个 UTF-16 单元 |
| `ending` | 可选顶层结束语 title/text，完成确认后显示 |
| `text` | 只能 `input_purpose: "personal"`，max_length 必填，建议昵称等短输入 |
| `input_match` | 可选的文字输入格式约束。优先使用安全预设，如 `{"kind":"preset","preset":"alphanumeric"}`；也可使用不超过 160 字符、无分支和开放量词、最多一个有界 `{n,m}` 量词的正则 `{"kind":"regex","pattern":"[A-Z0-9]{6,12}","message":"请输入 6–12 位大写字母或数字。"}`。仅适用于 `text`，服务端最终校验；旧 JSON 未配置时保持原行为 |
| `condition` | 保留既有 eq/neq/includes/and/or/not 条件 AST，只能引用前序题，不执行脚本 |
| `mode` | 默认 TEST_ONLY；COLLECTION 仍需既有真实环境验收与采集准入 |

未知字段会被拒绝，不静默丢弃。专业配置可上传完整 `study-v1`，仍需提供 layout.orientation 及量表 labels。简化 JSON 还可设置 groups、variants、layout（aspect/最小宽度）及 budget；复杂计时参数仍由既有协议合同检查。

## 知情同意页

新模板及三份示例都包含 `consent: {"title":"知情同意书","text":"完整说明"}`。所有内容由研究者通过 JSON 编写，不在网页编辑，不执行 HTML/Markdown。标题与正文必填且不可空白，未知字段会被拒绝；沿用标题 200、说明 8000 的 UTF-16 字符预算。示例明确标记模拟测试，正式问卷需换成对应研究的内容。

参加链接先读取轻量主题／方向元数据，方向通过后才读取同意书。拒绝按钮在任意段落可用；同意按钮在最后一段且文字完整显示时可用，没有默认同意或文字输入。长文优先按完整段落翻页，超长段落再按完整字符边界分段；支持返回上一段，全部纯色、无页面滚动。拒绝后显示退出提示，也可重新阅读。管理端模拟器使用同样页面，但不创建真实会话或提交任何记录。

明确同意前不采集浏览器环境、不创建服务器会话、不请求图片。客户端先用严格 IndexedDB 事务保存 `{accepted:true,document_hash}`，再采集环境及创建会话；服务器必须匹配冻结文档的 SHA-256（`stableJSON(consent)`），否则返回 `CONSENT_REQUIRED`。同意记录与会话创建处于同一服务器事务，服务端时间记为 Unix 毫秒，刷新及丢失回应重试不会新增或改写记录。拒绝只在页面显示，不上传拒绝事件。

导出 CSV 的 `consents` 行包含 session_id/document_hash/accepted_at，结合 sessions.version_id 与 versions.protocol 可还原当时全文。数据库记录禁止 UPDATE/DELETE，联合备份与恢复继续保留。历史版本没有 consent 字段时保持既有流程，不伪造同意记录；修改 JSON 会生成新的冻结版本，已有受试者仍使用原文。

## 同一题的多个坐标轴与结束语

题型 `scales` 将 2–6 个轴放在同一题中，每个轴独立配置 id、title 和 labels；整数 min 默认 1，max 默认 min+labels.length−1。端点及所选反馈均显示标签文本。所有轴同屏，宽屏可使用多列；空间不足时阻止继续，绝不分组分页或启用滚动。建议手机问卷每题使用 2–3 轴，并保持维度名、标签和题干简短。

```json
{
  "id": "experience",
  "type": "scales",
  "title": "请评价这次体验。",
  "required": true,
  "axes": [
    {"id": "ease", "title": "便利", "labels": ["不方便", "一般", "方便"]},
    {"id": "clarity", "title": "清晰", "labels": ["不清晰", "一般", "清晰"]}
  ]
}
```

该题答案保存在一个 questionId 下，例如 `{"experience":{"ease":3,"clarity":2}}`。必答时所有轴都需选择；可选题允许部分作答，未作答轴规范为 null，数值 0 是有效答案。分支按具体轴设置 `{"op":"eq","question":"experience","axis":"ease","value":3}`，不能直接拿整组对象与数字比较。逐轴修订沿用原始事件及离线队列，刷新、返回和隐藏分支仍保留草稿。

顶层可设置 `"ending":{"title":"感谢参与","text":"你的答案已保存，现在可以关闭页面。"}`。只有服务端确认 COMPLETED 后才显示结束语；保存失败时保留重试界面。纯色背景随问卷保持，长结束语用阅读按钮分段，刷新仍显示已完成的结束页。标题最多 200、正文最多 8,000 个 UTF-16 单元；文本为纯文本，无 HTML。未配置时显示默认感谢与已保存说明，旧冻结协议不自动增加字段。

## 下载数据

管理主页中每份问卷有“下载数据”按钮。生成单一 SQLite 读取快照后下载 `data.csv`，同时提供“下载导出说明”获取 manifest.json。CSV 的两列为 table/data_json，包含答案状态、原始事件、图片试次结果、协变量、冻结问卷及图片包索引；`axis_answers` 为多坐标题逐轴生成记录，带 question_id、axis_id、整数 value、标签 label、版本和状态。未答轴的 value/label 为 null，SKIPPED、UNCONFIRMED、NOT_REACHED 保留原状态，不能按零分分析。

导出尚未确认时的 request/job ID 保留在当前标签页 sessionStorage，断线或刷新后复用原作业；已经完成的下载再次点击时生成新快照，避免拿修订号相同却数据过期的文件。下载与作业状态查询都要求管理员登录，继续使用既有单维护 worker 和导出预算。需核查的失败作业保留原恢复流程，不自动解除屏障。

## 图片压缩包

上传前可运行本地 [移动端图片处理工具](移动端图片处理.md)，按显示尺寸/DPR 缩放、显式主体区域裁切或生成长图切片，并直接输出符合本平台限制的 ZIP 与检查报告。

图片/文字刺激现支持 general 与题目级时长、jitter、固定/伪随机顺序、键盘作答和反馈。配置规则见 [刺激任务设计](刺激任务设计.md)，完整示例见 [randomized-stimuli.json](../examples/questionnaires/randomized-stimuli.json)。

图片先在自己的电脑上完成压缩、移除 EXIF 及方向归一化，再打成标准 ZIP；管理端同一次上传可选择多个 ZIP。JSON 引用的是压缩包文件名及内部路径，无需写 bucket、服务器绝对路径、云密钥或公开 URL：

```json
{
  "id": "shapes",
  "title": "图形识别",
  "choices": ["左边", "右边"],
  "repeats": 0,
  "trials": [{
    "root_id": "card",
    "image": {"package": "mobile-stimuli.zip", "path": "images/mobile-card.png"},
    "image_ms": 3000,
    "isi_ms": 400,
    "correct": "左边"
  }]
}
```

将该对象放入顶层 `groups`。包名限定英文字母、数字、横线、下划线和点，以 `.zip` 结束；内部路径使用 `/`，同样使用 ASCII 名称。不要把 `.DS_Store`、`__MACOSX` 等系统辅助文件打入包。同一问卷内同名包不可覆盖，修改图片请用新包名并同步修改 JSON。首次上传失败可在当前表单重试，创建问卷、压缩包和 JSON 导入均保留各自请求身份；服务器不将不同内容当作同一次上传。

服务器只解包、检查格式头/容器及 SHA-256，原始文件字节不变。限制：ZIP 最大 8 MiB，展开总量 32 MiB，最多 100 张图片/200 个条目，单图 8 MiB、400 万像素、边长 4096。支持静态 PNG/JPEG/WebP，拒绝动画、EXIF、路径穿越、重名条目、符号链接、加密及多卷/ZIP64。支持存储和 DEFLATE 压缩；CRC 与长度核对，压缩流展开受申报大小硬限制。通过标头检查不能证明像素流有效，客户端在计时前必须真实解码并校验哈希、尺寸和内存预算，失败不会开始任务。

上传资产存入既有私有资产区，JSON 发布时解析并固定 asset_id/hash；只有认证管理端或获准的参加者可以读取。ZIP 条目的用户路径不会成为服务器文件路径。验证阶段的坏 ZIP 直接失败，可重选重试；文件发布阶段的磁盘故障继续使用原有维护恢复合同。维护 API 保留，但维护、环境档案和数据详情不再混入问卷管理界面。

[移动图片示例](../examples/stimuli/mobile-card.png)为 1080×720 的灰色图形卡，两侧各一个大图形、80px 侧标签和 64px 短说明；显示宽度 280px 时约对应 21px 标签和 17px 说明。使用 [mobile-stimuli.zip](../examples/stimuli/mobile-stimuli.zip) 配合上述图片 JSON 即可试用。保留 [SVG 源文件](../examples/stimuli/mobile-card.svg)，可在电脑上调整后导出。图片比例应与任务 layout.aspect 一致，本例是 1.5；字体尺寸需按实际最小显示宽度验收，不能把桌面截图缩小后直接用作刺激。

## 环境协变量

参考 [Formbricks 仓库](https://github.com/formbricks/formbricks)及 Gemini 提供的 [metadata 文档](https://formbricks.com/docs/surveys/general-features/metadata)，将环境上下文与题目答案分开存储。信息在方向通过且明确同意后、会话开始前采样（历史无 consent 版本保持原流程），建立会话后立即接管；每个浏览器版本会话只采一次，刷新和进入图片运行器继续使用原始快照。先用 IndexedDB 严格事务保存原始 JSON、sample_id/request_id，再核对服务端哈希回执；断网失败保留待传记录。任务计时期间不重新测量。

| 类别 | 记录内容 |
| --- | --- |
| 浏览器和系统 | 原始 UA、低/高熵 Client Hints、platform/vendor/appVersion；浏览器/OS 推断标明 user-agent-heuristic 来源 |
| 屏幕和显示 | 屏幕/可用区域尺寸、色深、方向角、页面和 visualViewport 尺寸、缩放、DPR、色域/HDR 媒体查询 |
| 硬件和输入 | 逻辑处理器数、设备内存近似值、触点、pointer/hover/any-pointer 偏好；WebGL 只读 vendor/renderer/version/texture limit，立即释放，不绘制指纹 |
| 语言与偏好 | language/languages、时区及偏移、深色、减少动画、对比度、强制色、颜色反转、standalone |
| 网络与存储 | online、连接类型、effectiveType/downlink/RTT/saveData、存储 usage/quota/persisted、电池可用值 |
| 执行环境 | secureContext/crossOriginIsolated、cookieEnabled/DNT/GPC、页面可见性、关键 API 支持、导航类型/时间/协议/字节、来源域名 |
| 服务器观察 | 首次创建请求的 IP、UA、Accept-Language、Accept-Encoding 和 sec-ch-ua 系列请求头 |

异步能力最多等 250ms；可用、unsupported、blocked-or-error、timeout 分别记录，缺失不是零。只采无需权限提示的数据，不请求地理位置、摄像头、麦克风、运动传感器，不枚举设备标识，不保存 URL 私人参数。浏览器隐私限制可能使 OS 版本、内存、GPU 等变成粗略或伪装值，不能声称获得“所有系统信息”或物理屏幕刷新率；既有图片预检的刷新统计和几何证据仍在 permit.readiness 导出中。

服务端 IP 来自 Fastify request.ip，沿用仅信任 loopback 代理的既有配置；通过该代理时按其转发信息解析，公网直连不直接信任任意 X-Forwarded-For。客户端报告和服务端观察在 `lab_covariates` 标明来源，保持原文与哈希不可变，CSV 导出包括 covariates、questionnaire_sources、packages 和 package_images。SQLite 联合备份保留这些表及 READY 图片，历史版本和数据不因网页删除而丢失。

## 本地查看

`npm run build` 后执行 `npm run preview:questionnaire`，打开 `http://127.0.0.1:3081/questionnaire-preview.html`。灰色示例要求竖屏，深色要求横屏；两份都包含知情同意、单坐标及三坐标题、按钮、可选模拟昵称、长说明、同屏选项、图片任务和结束语。电脑上通过调整浏览器窗口比例进入。主页 `/` 为管理入口，受试者只使用带 version 的 participate.html 链接；管理端使用本地管理密码 `TEST_ONLY-local-preview`，只作用于该独立模拟数据库，不修改项目 .env。

最新生产问卷完整依赖闭包（含动态模块）为 72,372 B 原始／29,709 B gzip，较最初 444,959 B gzip 减少约 93.32%。这是 HTML/JS/CSS 传输内容的测量，不包含 API 和图片，也不代表运行内存或处理器耗时。报告见 [frontend-consent-lan.json](gemini前端讨论/frontend-consent-lan.json)。开发检查和 SurveyJS 样例不在主页或参加者入口的依赖闭包中。

验收：类型检查、生产构建、数据库 smoke、64 项单元检查、34 项 Chromium 浏览器检查全部通过；最后段落分页与标题改进后复测 6 项通过。新增检查覆盖逐轴整数／空值与分支、必答及部分作答、离线恢复、320×480 至宽屏同屏布局、六轴超小屏阻断、保存失败不显示结束语、结束文本分段及刷新、主页登录、CSV 逐轴行、私有下载、丢失导出回应后刷新复用和再次点击获取新快照。既有图片、排队、原始字节、封存、恢复、ZIP 与协变量检查继续通过；本地灰色竖屏／深色横屏实际完成所有步骤，无页面错误或滚动。


手机测试：执行 `npm run preview:questionnaire -- --lan`，HTTP/HTTPS 分别绑定 `0.0.0.0:3081` 和 `0.0.0.0:3082`。首次从同一 Wi-Fi 的手机打开终端给出的 `/phone-setup` 地址，下载本机测试 CA 并完成系统信任设置，再打开 HTTPS 模拟问卷。HTTP 问卷链接保留路径与 version 跳转 HTTPS。该测试使用 OpenSSL 私有 CA 和服务证书，不安装系统全局信任，也不改项目 .env；签名私钥仅在受保护的 `.local` 目录，公开下载只有 CA 证书。直接配置服务器 TLS 时，`TLS_KEY_PATH` 与 `TLS_CERT_PATH` 必须同时设置；HTTPS 请求的会话与管理 Cookie 使用 Secure 标志。

正式作答依赖原生 Web Locks 保证同一会话只有一个页面写入。`--lan-http` 在非安全上下文中只适合查看模拟界面；浏览器缺少 Web Locks 时，参加页和图片运行页会提示使用支持该能力的浏览器与 HTTPS，不创建会话。兼容层不会伪造互斥锁。

本机实际使用局域网 IP 的 HTTPS 完成灰／深主题同意、拒绝重新阅读、三坐标、图片任务、结束语、刷新和管理员 CSV 下载，浏览器无页面错误；真实 Web Crypto/UUID/Web Locks 均可用。curl 使用生成的 CA 正常验证 TLS 链、IP SAN 与健康检查；HTTP 跳转保留参数，下载 CA 字节一致；证书设置页在三种设备尺寸中无滚动或裁剪。浏览器检查使用 Chromium 手机触控模拟与证书例外，尚未声称实机手机验收。
