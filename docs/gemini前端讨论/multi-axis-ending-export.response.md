### 1. 多轴量表 (`scales`) 交互与数据契约边界

- **同屏零滚动约束与多轴物理布局**：
  - **极限高度控制**：在移动端竖屏（360×640 视口下排除固定页头页脚），容纳 2–6 轴时，必须压缩单轴垂直占用（例如每轴限制在 56–68px：轴标题/已选反馈单行合并显示，刻度轴仅留滑轨与两端端点标签，中间取消大间距）。
  - **弹性溢出阻断**：若 6 轴在超小屏设备下导致内容高度超过 `visualViewport`，必须触发系统既有的“屏幕空间不足阻断器”，要求受试者旋转或更换设备，**严禁回退到页面滚动**。
- **状态隔离与未作答语义**：
  - 答案存储格式采用 `{ [axisId: string]: number | null }`。
  - **未作答严格为 `null`**：未发生交互前绝对不能填充 `0`（`0` 仍是合法刻度整型值）。
  - **必答与选答校验**：
    - `required: true`：提交前检查 `Object.keys(axes).every(k => typeof ans[k] === 'number')`。
    - `required: false`：允许未交互轴保持 `null` 或未定义，提交 payload 中显式序列化为 `null`。
  - **浅拷贝隔离**：Input 事件分发与 Ledger 暂存必须对答案对象做浅拷贝（`{ ...currentAnswers[qid] }`），防止后续异步写磁盘与 UI 拖拽竞争修改同一对象引用。
- **条件跳转 (`condition`) 逻辑解析**：
  - 条件求值器扩展必须支持嵌套寻址：若 `condition.question === qid` 且声明了 `condition.axis`，取 `answers[qid]?.[condition.axis]` 进行比较；若未声明 `condition.axis` 且该题答案为对象，比较直接返回 `false`，杜绝 `[object Object]` 与标量进行弱类型比对。

### 2. 结束语 (`ending`) 状态机与分段交互

- **时序与持久化**：
  - 结束语组件挂载的前提是：**ParticipantAPI 完成 `sync()`、`seal()` 且服务端 `finalize` 确认响应返回 `{ status: 'COMPLETED' }`**。
  - **刷新恢复**：本地 Ledger 状态记录已完结标记（`completed: true`）。页面刷新进入时检测到该标记，跳过问卷路由，直接挂载 `ending` 页面，无需向服务端重新请求会话创建。
- **超长文本分段（零双向滚动）**：
  - 超过视口承载容量的结束语**禁止原生滚动条**。
  - 采用“翻页式阅读”状态机：按字符数/段落切分为多页，底部提供“下一页 / 完成”纯按钮驱动推进，保持绝对的零滚动物理体验。
  - 纯灰/深色主题与背景色保持与问卷布局严格一致，且 DOM 中不保留任何指向管理端的链接或返回按钮。

### 3. 数据导出 (`EXPORT`) 与 CSV 序列化语义

- **稳定作业防重（Idempotent Job Token）**：
  - 卡片点击“导出数据”时，使用由 `study_id + revision + version_id` 派生的稳定 deterministic ID（或本地留存的当前作业 UUID）。
  - 若 worker 正在处理或已生成产物，重复点击仅轮询状态并返回同一下载流；若遇到失败状态，显式重置作业锁后重试，避免向维护 worker 发送并发重复打包请求。
- **CSV 宽表与长表语义对齐**：
  - 宽表 `question_states`：将对象以稳定 JSON 字符串输出（如 `{"anxiety":2,"depression":null}`）。
  - 长表 `axis_answers` 行输出规范：
    - 字段：`[session_id, qid, axis_id, value, label, state]`。
    - **空值表示**：若受试者未作答某轴，`value` 留空字符串 `""`（或 `NULL`），`state` 记为 `UNTOUCHED`，`label` 记为 `""`。**严禁输出 `0` 或将 `null` 隐式转换为 `0`**，保障心理统计学数据纯洁性。

### 4. 路由隔离与管理入口收敛

- **入口隔离**：
  - 根路径 `/` 渲染管理员单密码登录页/控制台；旧 `/admin.html` 做同源同权兼容。
  - 调试诊断工具单独隔离在 `diagnostics.html`，且依赖相同鉴权。
  - 受试者仅且只能通过带参数的 `participate.html?version=...` 访问，页面完全剔除通往 `/` 的 DOM 节点与上下文感知。

MULTI_AXIS_ENDING_EXPORT_REVIEW_COMPLETE
