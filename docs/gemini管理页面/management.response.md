针对本地 Fastify + better-sqlite3 架构及纯原生 TypeScript DOM 前端，提供以下紧凑、无外部新依赖的管理页设计与实现建议。

### 1. 管理卡片布局、状态反馈与手机可用性

- **紧凑单列流式卡片 (Mobile-First)**：
  - 每份问卷为一个独立 `<section class="study-card">`，固定边框与纯色背景，宽度 100%，消除横向溢出。
  - **头部信息**：顶部左侧为展示名与 `study_id`（等宽字体），右侧为状态徽标（`[公开中]` 绿色 / `[已隐藏]` 灰色）与版本号。
  - **主操作网格 (触控尺寸 ≥ 44×44px)**：
    - 第一行（展示与控制）：`[改名]`、`[↑ 上移]`、`[↓ 下移]`、`[隐藏/公开]`。首尾卡片的上移/下移按钮增加 `disabled`。
    - 第二行（数据与分析）：`[查看答卷]`（跳转现有查看器）、`[导出数据]`（异步触发 Worker 作业并展示进度）。
- **内联修改与状态反馈**：
  - 点击 `[改名]` 在卡片内原地切换为 `<input type="text">` + `[确认]` `[取消]`，避免弹出层在移动端虚拟键盘唤起时出现视口错位。
  - 操作触发时，按钮设置 `disabled` 并替换文字（如 `保存中...`、`导出中...`）。
  - 错误反馈使用卡片内底部内联 `<p class="error-banner" role="alert">` 显示错误码（如 `REVISION_CONFLICT`、`ORDER_STALE`），无需弹窗，3秒后自动淡出或手动关闭。

### 2. 改名与冻结版本的语义隔离及提示

- **概念清晰分离**：
  - `lab_studies.title` 仅是管理索引和前台列表的**展示名**。
  - `lab_versions.protocol.title` 是**已冻结协议的固定内容**，与哈希及数字签名绑定，作答页面内始终显示发布时的原始协议名称。
- **UI 明确提示**：
  - 改名输入框下方固定显示辅助提示文字：*“注意：此处仅修改列表展示名。已发布的答卷协议与作答页面内的实验标题已冻结封存，不可变更。”*
  - 若展示名与当前最新版本的协议名不同，卡片元信息区小字标出：`协议原名: {protocol.title}`。
- **乐观并发控制**：
  - 提交 payload: `{ study_id, title, expected_revision }`。
  - 写入 Worker 执行：`UPDATE lab_studies SET title = ?, revision = revision + 1 WHERE study_id = ? AND revision = ?`。
  - 若 `changes === 0`，服务端返回 `409 REVISION_CONFLICT`，前端提示被其他操作更新，保留未保存内容并引导刷新。

### 3. 列表排序的迁移与并发方案

- **持久化方案**：
  - 在 `lab_studies` 增加 `sort_order INTEGER NOT NULL DEFAULT 0`。
  - **初次迁移 (保持当前 rowid 倒序)**：`WITH ranked AS (
  SELECT study_id, ROW_NUMBER() OVER (ORDER BY rowid DESC) AS rnk
  FROM lab_studies
)
UPDATE lab_studies SET sort_order = (SELECT rnk FROM ranked WHERE ranked.study_id = lab_studies.study_id);
CREATE INDEX IF NOT EXISTS idx_lab_studies_sort_order ON lab_studies(sort_order);`
  - 公开列表与管理列表查询统一改为 `ORDER BY sort_order ASC`。
- **原子交换与快照校验 (避免覆盖)**：
  - 采用相对位移方案，前端上移/下移发送： `{ moved_id, direction: 'up'|'down', snapshot_ids: string[] }`。
  - 写入 Worker 在**同一个事务**内：
    1. 查询当前所有 study 的 ID 列表及当前顺序。
    2. 核对 `snapshot_ids` 与数据库实际序列是否完全一致（集合完整且顺序匹配）。若不一致，抛出 `ORDER_STALE`，事务回滚并返回最新顺序。
    3. 找到目标项与相邻项，原子交换两者的 `sort_order`（或对全量更新 `sort_order = index`）。

### 4. 导出 CSV 字段设计、空值/多坐标处理与防注入

- **`answers.csv` (扁平结构，一题/一轴一行)**：
  - **字段**：`session_id, study_id, version_id, session_state, page_id, question_id, axis_id, question_type, answer_text, answer_numeric, scale_label, is_sealed, recorded_at`。
  - **空值处理**：未作答、跳过或非必填为空时，文本列输出 `""`（空串），数值列输出留空，绝不填充 `"NULL"` 或 `"undefined"`。未确认（未 seal）答卷通过 `is_sealed=0` 明确标出。
  - **多维度量表 (scales)**：拆分为多行输出，每行填充对应的 `axis_id`、数值得分及端点文字标签。
- **`trajectories.csv` (细粒度事件与样本)**：
  - **字段**：`session_id, version_id, scope, sequence, event_kind, time_origin, sample_time_ms, event_type, target, x, y, key_code, valid, payload_json`。
  - `event_kind` 区分 `INPUT_DIAGNOSTIC`（UI操作）与 `GROUP_RECORD`（试次呈现/按键）。
  - 必须同时提供页面基准 `time_origin` 和事件相对时间 `sample_time_ms`，严禁格式化为本地易读时间以避免时区精度损失。
- **CSV 公式注入防护 (Formula Injection)**：
  - 处理所有字符串字段（特别是 `title`, `answer_text`, `target`）：`function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // 防御 Excel / Calc 动态代码注入：若首字符为 =, +, -, @, \t, \r 则前置单引号
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  // RFC 4180 规范转义
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}`
- **下载安全控制**：
  - 仅管理员鉴权后允许下载；文件名基于内存白名单校验，仅允许下载 `answers.csv`、`trajectories.csv`、`data.csv`、`manifest.json`。禁止输出任何 `credential` 或敏感散列。

### 5. 关键回归场景

1. **改名并发冲突**：在两个标签页同时打开同一问卷，A 标签修改标题并保存成功；B 标签以旧 revision 提交改名，服务端必须准确拒绝并返回 `REVISION_CONFLICT`，A 的修改不受影响。
2. **移动端首尾排序越界与乱序**：列表第 1 项上移及末项下移应在前端严格禁用；模拟并发交换排序，若快照已过时，校验返回 `ORDER_STALE` 且所有问卷顺序完全不发生错乱。
3. **隐藏后现有答卷流转隔离**：将问卷切换为 `PAUSED` 后，验证公开入口无法初始化新答卷；而通过原页面已进入的在途 session 仍可正常 `claim`、保存 `PAGE_REVISION`、提交并成功封存（`SEALED`）。
4. **CSV 注入与特殊字符转义**：题干及问卷文字题输入包含 `=cmd|' /C calc'!A0`、双引号、多行回车及中文字符，验证导出的 `answers.csv` 在 Excel / Numbers 中打开无公式告警，无串行或错位。
5. **不完整/中断答卷的轨迹导出**：验证包含被试中途退出（`TERMINATED`）、未 seal 答卷、多坐标/多轴连续评分场景下，`trajectories.csv` 时间戳无 `NaN`，`answers.csv` 的空值与轴标识匹配严格，`manifest.json` 哈希与实际文件完全吻合。

ADMIN_MANAGEMENT_DESIGN_COMPLETE
