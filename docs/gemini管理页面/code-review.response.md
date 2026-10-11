针对本次提供的管理页面及后端导出/排序/改名实现代码节选，进行紧凑工程审阅。整体架构（原子全量校验重排、严格只读快照导出、三份独立 CSV 配套 BOM/BOM-free 处理、私有只读路径白名单等）设计周密，未发现致命阻断缺陷。仅有以下 2 项值得注意的工程边界问题：

### 1. `answers.csv` 构造未作答（NOT_REACHED）答卷时 `states[q.id]` 产生空指针崩溃风险

- **位置**：`EXPORT` worker 内部构建 `answers.csv` 处：`const parent=object(states[q.id]),common={snapshot_id:snapshot,...};`
- **机理**： 在遍历会话 `protocol.pages` 时，只有 `path.includes(page.id)`（已提交页）或 `index < session.page_index && !evaluate(...)`（跳过页）才会向 `states` 注入键值。对于被试尚未进行到的页面（即 `index >= session.page_index` 且未进入 `path` 的后续页，例如被试刚答完第 1 页就中途离开），`states[q.id]` 的值为 `undefined`。 如果辅助函数 `object(v)` 遵循项目严格规范（在输入为 `undefined` 时抛出 `ContractError` / `TypeError`），则导出包含中途退出或未完成答卷的问卷时，`object(states[q.id])` 会直接抛错导致整个 `EXPORT` 作业失败。
- **影响**：导出含不完整答卷的研究数据时 Worker 可能意外终止。
- **边界修复建议**：`const rawParent = states[q.id];
const parent = rawParent && typeof rawParent === 'object' && !Array.isArray(rawParent) ? rawParent : { state: 'NOT_REACHED', answer: null };`

### 2. 导出作业并发/复用时的前端跨标签页污染与按钮二次点击状态竞争

- **位置**：前端 `exportData` 函数：`const key=`lab-export-${study.study_id}`;let pending:...;
...
sessionStorage.removeItem(key);downloads.replaceChildren();
...
links.get(file)!.click();`
- **机理**：
  1. `sessionStorage.setItem(key, ...)` 使用了固定 study_id 作为键名，但在向后端发起 `/api/lab/jobs/export` 成功且完成本次下载动作前，直接执行了 `sessionStorage.removeItem(key)`。如果用户在后台正在生成大文件（如 50MB 轨迹数据需执行数秒）期间切换去点击“导出轨迹”或“导出问卷结果”，由于本地 key 已被清除或覆盖，会重新派发新的 `uid()` 创建新 job，失去复用既有运行中作业的幂等保护。
  2. 在同一个卡片上快速双击不同导出按钮（例如先点“导出问卷结果”，再点“导出轨迹”）时，因缺少针对具体 study 卡片的互斥锁（busy flag），可能会对同一个 study 并行发起两个不同的 `/api/lab/jobs/export` 请求，增加维护 worker 的无效排队压力。
- **影响**：大体积导出场景下，重复点击可能引发并发作业排队，造成网络与 IO 资源浪费。
- **边界修复建议**： 在 `exportData` 执行期间对当前 card 的导出相关按钮置 `disabled`，直到文件触发下载完成；并且仅在确定作业完成或报错清理时再安全重置 `sessionStorage` 或作业状态。

除上述 2 项在不完整答卷边缘情况与高频点击下的边界细节外，未发现新增阻断性缺陷。数据流转、CSV 转义安全性及排序/重命名的数据一致性保障均符合工程标准。

ADMIN_MANAGEMENT_CODE_REVIEW_COMPLETE
