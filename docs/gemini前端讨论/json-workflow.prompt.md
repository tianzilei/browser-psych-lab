继续 browser-psych-lab 的前端设计讨论，用户明确要求这轮全部设计使用 Gemini bridge 优化。请用中文审查以下实现方案、补充建议并参考 Formbricks 官方仓库/文档中的环境元数据设计。无需大量泛泛论述，给出可执行的数据结构和关键边界。结尾写 JSON_WORKFLOW_REVIEW_COMPLETE。

已实现约束：原生 TypeScript 问卷，纯灰 #e5e5e5 或深 #202020；固定 visualViewport 零滚动；单选/多选同屏全部按钮，禁止选项分页，空间不足阻止继续且要求调整设备。只有 input_purpose=personal 的文字题允许发布。原生离散 range 坐标轴，只有交互才记录值（0 是有效值），不预填。固定协议哈希、冻结 runner、SQLite 单 writer、IndexedDB outbox；图片用于计时 Canvas 任务，运行中 resize/方向改变终止保留记录，不能改变时间语义。管理员认证、CSRF、同源及原始数据审计已有。

用户本轮要求：
1. 美化坐标轴，坐标下“已选”显示 JSON 预设文本而非数字。用户已同意每个整数刻度对应标签，例如非常不同意/不同意/一般/同意/非常同意。原始答案仍整数。
2. 管理端仅问卷上传/修改(替换 JSON)/删除/开放/隐藏及生成模拟问卷，移除网页内容编辑器。JSON 上传先检查语法再校验内容。参考问卷星 https://www.wjx.cn/help/help.aspx?helpid=138&h=1 ，该页支持从题干/题型/选项的文本创建问卷；不需要照搬其文本解析器或写 eval。计划简化 questionnaire-v1 JSON（title,background,orientation,pages；可选图片任务/groups/budget），编译为现有 study-v1；还支持专业 study-v1 JSON，提供下载模板/本地浏览器模拟预览。未知字段必须报错，版本冻结不被修改，删除含已收集数据问卷用软删除隐藏保留数据。
3. JSON 明确 portrait/landscape；进入先请求轻量配置元数据，不请求完整协议/创建会话/下载图像，方向符合后再加载。软键盘高度不能误当方向改变，要比较 layout viewport/documentElement 宽高或 screen orientation，square 稳定判定；真实方向改变显示要求，已经计时图片运行遵循原有终止逻辑。
4. 图片用户离线压缩，服务器不集成图像解码/转码。ZIP 上传，JSON 指定 package:'stimuli.zip', path:'images/card.png'，无需 bucket 密钥/物理路径。ZIP 应限制压缩大小8MiB、展开总量32MiB、单图8MiB、最多100图，拒绝重复/非法路径/symlink/加密/非PNG JPEG WEBP及动画/过大像素，只解析图像头读取尺寸/格式，保持字节和sha256。安全解包在维护worker，不占计时主线程，使用现有私有 assets+发布时固定引用asset_id/hash。压缩包同名内容不同需拒绝或新版本名称，不覆盖旧资产。提供手机可读的示例图和ZIP+JSON。
5. 页面打开收集最大化无权限提示可得的协变量：raw UA, UA ClientHints(限时), browser/OS猜测明确来源, language/languages, timezone/offset, screen/available/colorDepth, viewport/visualViewport/scale/DPR, orientation, hardwareConcurrency/deviceMemory/maxTouchPoints/platform/vendor, network/saveData/online, media preferences dark/reducedmotion/contrast/pointer/hover, storage estimate/quota/persistence, cookieEnabled/DNT/GPC, secureContext/crossOriginIsolated, supportedAPIs, connection navigation type/timing，WebGL renderer可选不作绘图指纹，电池可用异步限时。浏览器限制导致不能“所有系统信息”，不请求地理/相机/麦克风/传感器权限，不枚举设备标识，不采集URL搜索字符串/referrer私人参数，服务器记录自己所见 request IP/UA/AcceptLanguage，可协变量配置声明。环境一次采样在计时前，持久离线 outbox/幂等，在导出可查，不在每帧采集。

请评估：简明JSON模板字段，最小管理员交互流程，移动轴/图像具体尺寸与排版建议，orientation gate实现（尤其键盘/iOS），ZIP架构是否适合，无图像处理时校验风险；给出 Formbricks 相关源链接和浏览器可用元数据的准确范围。如果有不能确定的部分明确说明。
