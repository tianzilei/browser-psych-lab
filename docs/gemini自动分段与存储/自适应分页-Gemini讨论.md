# Gemini Bridge 自适应分页讨论

请求：adaptive-questionnaire-20261011
结果：res_60c1ba0c5acb6ff79d76
完整性：complete
讨论链接：https://gemini.google.com/app/9b44c83b7522a950

以下为 Gemini 原始建议；具体实施选择见自适应问卷说明。未独立检索资料。

这是一份针对 **“长量表手机视口自适应排版 + 保持底层冻结协议/Page分段哈希链不变”** 的工程与体验评审方案。

### 一、 核心架构冲突与隐患警示

在给出方案前，必须明确指出当前改动隐藏的 **3 个致命冲突点**：

1. **“跨段（Page）答案不可逆” 与“视口动态分组跨越存储段边界”的冲突**：
  - 底层 7 个存储段（Page 0 ~ Page 6，每段 30 题）要求必须 `PAGE_SNAPSHOT` 并且 `seal`。服务端只认 `current_page_index` 对应的 scope。
  - 如果前端根据屏幕高度计算，把 Page 0 的第 29、30 题和 Page 1 的第 1 题凑在同一个“屏幕视口页”，用户点击“下一页”时就会**同时跨越两个存储段**。此时若 Page 0 还没完成 seal，Page 1 的数据绝不能往服务器传，否则触发**非法 scope / quarantine**。
  - **核心结论**：**“屏幕视口页的分组，绝对不能跨越 30 题存储段边界”**。即每个 30 题存储段内部独立进行屏幕小页切分（例如段内切为 10~15 个屏幕页）。到了段内最后一屏点“下一页”，正好天然触发该段的自动 `PAGE_SNAPSHOT` + `seal`，绝不跨段拼凑屏幕。
2. **Sync 队列中的“未来 Scope”穿透风险（Race Condition）**：
  - 现存机制是“批量上传所有未 ack 事件”。当用户在离线或弱网下快速答题，完成了 Page 0 并进入 Page 1，IDB 中同时存在 Page 0 和 Page 1 的 revision。
  - 原有的 sync 必须加一道“严格 Scope 栅栏（Scope Barrier）”：在服务器确认 Page 0 seal 成功并推进 `current_page_index` 之前，**禁止将 Page 1 的任何事件放入 HTTP 请求体**。
3. **视口测量闪烁与键盘弹起（Resize 重排）的灾难**：
  - 手机端如果依赖实时 DOM 测量，软键盘弹起（开头 15 位编号输入）或横竖屏切换时，`window.innerHeight` 会剧变。若此时动态重新计算每屏题数，会导致受试者正在作答的题目位置瞬间跳动，甚至造成答题丢失或重复。

### 二、 具体实施方案与设计

#### 1. 简洁配置、布局与动态分组算法

在 `questionnaire-v1` 中新增严格的可选字段（省略仍走单题模式）：

```
interface QuestionnaireLayoutOptions {
  viewport_adaptive?: {
    enabled: boolean;              // 显式 true 开启
    target_item_min_height?: number; // 默认 110px (题干 + 44px 按钮行 + margin)
    bottom_reserve?: number;       // 默认 120px 为顶部进度条 + 底部固定导航留白
  };
}
```

##### 动态分组算法（伪代码）

在每个 30 题存储段开始时计算一次该段的子分页（Sub-Pages / Batches）。不要在每次滚动或输入时重新测量。

```
interface SubPage {
  pageIndex: number;     // 0 ~ 6 (对应底层协议的 page)
  subPageIndex: number;  // 段内小页序号
  itemIndices: number[]; // 题目的绝对索引，如 [0, 1, 2]
}

function calculateSubPagesForSection(
  sectionItems: QuestionItem[],
  pageIndex: number,
  globalStartIndex: number
): SubPage[] {
  // 1. 获取可用高度（排除键盘状态，使用固定视口度量或初次载入高度）
  const viewportH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const availableH = Math.max(viewportH - 140, 300); // 扣除顶部总进度 + 底部 "下一页" 按钮

  // 2. 规则：手机竖屏(height < 800)通常 2~3 题；iPad/桌面通常 4~6 题
  // 15位编号输入题(第一段第0题)强制独占单屏或最多带1题
  const subPages: SubPage[] = [];
  let currentGroup: number[] = [];
  let currentAccumulatedH = 0;

  for (let i = 0; i < sectionItems.length; i++) {
    const item = sectionItems[i];
    const absIdx = globalStartIndex + i;
    
    // 估算或离屏测量高度（长题干或含文本输入框估算 180px，常规1~5单选估算 110px）
    const itemH = item.type === 'text' ? 180 : (item.prompt.length > 50 ? 140 : 110);

    // 遇到特殊文本输入、或加入后高度超出可用高度、或当前已积攒 4 题（移动端体验上限）
    const shouldBreak = currentGroup.length > 0 && (
      currentAccumulatedH + itemH > availableH ||
      currentGroup.length >= 4 ||
      item.type === 'text'
    );

    if (shouldBreak) {
      subPages.push({ pageIndex, subPageIndex: subPages.length, itemIndices: [...currentGroup] });
      currentGroup = [absIdx];
      currentAccumulatedH = itemH;
    } else {
      currentGroup.push(absIdx);
      currentAccumulatedH += itemH;
    }
  }

  if (currentGroup.length > 0) {
    subPages.push({ pageIndex, subPageIndex: subPages.length, itemIndices: [...currentGroup] });
  }

  return subPages;
}
```

- **体验细节**：
  - 1~5 量表采用水平 Flex 布局，每个数字按钮最小宽高 $44\text{px} \times 44\text{px}$，间距 $8\text{px}$。
  - 选中态使用高对比度描边 + 填充，无滑块默认值（防止习惯性跳过）。
  - 顶部常驻单行精简进度条：`第 34 / 191 题 (18%)`，完全隐藏底层 7 个 page 分段概念。

#### 2. 状态机与顺序保存设计（保留 7 个存储段）

系统状态机分为 **UI 展现层** 与 **后台持久化/上传 Worker（串行管线）** 两层。

```
[UI 交互]
   │
   ├─ 用户点选答案 ───> ① 内存更新 + 立即写入 IDB (PAGE_REVISION) 
   │                   └─> 触发防抖 Sync (Debounced Sync)
   │
   └─ 点击 [下一页] ───> 本屏必填校验通过
                          │
                          ├─ 若仍在当前 Page: 推进 subPageIndex，平滑滚动至顶
                          │
                          └─ 若已达当前 Page 最后一题:
                                ├─ 生成 PAGE_SNAPSHOT 写入 IDB
                                ├─ 触发该 Page 的 SEAL 流程
                                ├─ UI 前进到下一 Page 的 subPage 0 (乐观推进或等待微屏障)
                                └─ 后台管线严格串行处理
```

##### 状态机核心：严格串行 Sync / Seal 管线

为防止未来 Scope 泄露到服务端，必须在 Client Sync 模块中设立 **Scope 闸门**。

```
// 客户端后台单例调度器
class PageUploadPipeline {
  private activeSyncing = false;

  async triggerSync() {
    if (this.activeSyncing) return;
    this.activeSyncing = true;

    try {
      while (true) {
        // 1. 查询服务器当前接受的 page_index
        const serverPageIndex = await this.getServerCurrentPageIndex();
        const currentScope = `page-${serverPageIndex}`;

        // 2. 从 IDB 取出所有未 ack 且属于 currentScope 的事件
        // 【关键防御】严格过滤，绝不读取 serverPageIndex 之后的事件！
        const pendingEvents = await idb.getPendingEventsForScope(currentScope);

        if (pendingEvents.length > 0) {
          // 批量上传并等待 ACK
          await this.uploadBatch(currentScope, pendingEvents);
          await idb.markEventsAcked(pendingEvents.map(e => e.id));
        }

        // 3. 检查本地该 Page 是否已经生成了完整的 PAGE_SNAPSHOT
        const isLocallySealed = await idb.hasPageSnapshot(currentScope);
        const hasUnAckedInScope = await idb.hasUnackedEvents(currentScope);

        // 4. 仅当本地已拍快照且当前 scope 所有 revision 均已 ACK，才能提交 SEAL
        if (isLocallySealed && !hasUnAckedInScope) {
          await this.sendSealRequest(currentScope);
          // 服务器 seal 成功后会推进 current_page_index
          // 循环继续，自动开始下一个 page 的上传
          continue; 
        }

        // 当前段未完成或无待上传事件，退出本次管线
        break;
      }
    } catch (err) {
      console.warn('[Sync] 网络中断或重试中', err);
    } finally {
      this.activeSyncing = false;
    }
  }
}
```

##### 离线刷新与会话恢复（Restore）

- IDB 中持久化一条轻量游标：`client_ui_cursor: { pageIndex, subPageIndex, globalItemIndex }`。
- 刷新页面时：
  1. 读取本地 IDB 中的所有作答值注入表单。
  2. 调一次轻量 `/api/lab/session-status` 获取服务端的 `server_page_index`。
  3. **游标对齐校验**：`client_ui_cursor.pageIndex` 不能小于 `server_page_index`。若本地游标停留在已 seal 过的旧段，强制跳到 `server_page_index` 的第 0 个小页。
  4. 重新执行分组算法，恢复到受试者中断的位置。

#### 3. 是否允许跨存储段回退？（答案修改契约）

**强烈建议：严禁跨已封存存储段（Page）回退。仅允许在“当前未封存的段（30 题）内部”点击上一页。**

- **为什么不能跨段回退？**
  - 当前架构核心是“哈希链不可变”与“每段完成即 Seal 并合并答案”。
  - 如果允许退回上一段修改，意味着要撤销已在服务器落库并合入结果集的 `PAGE_SNAPSHOT` 和 Seal 状态。这需要重写哈希链或追加“修订补丁（Re-opening Scope）”，彻底击穿了现有服务端与数据库的冻结不可变规则。
- **界面与心理学体验对齐**：
  - 在当前段的第 1 屏，将“上一页”按钮**置灰禁用**或直接隐藏，并提示：“*前 30 题已保存归档，无法回退修改*”。
  - 心理学长量表（190 题）采用 30 题为节点归档是极合理的“心理里程碑”，受试者很容易接受分段归档不可逆。
- **完卷最终等待态（Final Submission Barrier）**：
  - 当受试者在 Page 6 最后一屏点击“完成问卷”时，弹出加载态 Modal：`正在加密同步最终结果，请勿关闭页面...`
  - 此时前端轮询/等待 `PageUploadPipeline` 把 Page 6 的所有 revision 和 seal ACK 均拿齐。
  - 只有在拿到最后一个 Seal 的成功回调后，才提示“提交成功，感谢作答”，彻底杜绝“伪后台保存”导致的离线关页丢数据。

#### 4. 核心端到端验收用例（4 条）

| 用例编号 | 场景 | 关键验证步骤 | 预期通过标准 |
| --- | --- | --- | --- |
| **TC-01** | **手机高密自适应与单屏必填拦截** | 移动端（375x667 视口）打开问卷。观察首屏 15 位编号，后续每屏题数。尝试漏填其中 1 题直接点击“下一页”。 | 首屏编号独占/自适应；后续每屏严格展现 2~3 题；量表按钮 $\ge 44\text{px}$；漏填时页面**红框高亮且不翻页**，全填后平滑翻页至下一小屏。 |
| **TC-02** | **段边界平滑过渡与自动 Seal 触发** | 受试者连续作答至第 30 题（Page 0 最后一题），点击“下一页”。 | UI 无感切换至第 31 题（Page 1 首屏）；网络面板捕获到 Page 0 的 `PAGE_SNAPSHOT` 自动发送并触发 `seal` 请求，无需用户额外弹窗确认。 |
| **TC-03** | **弱网离线与未来 Scope 拦截（防 Quarantine）** | 在 Page 0 第 28 题时断网（DevTools Offline），继续答完第 29、30 题并进入 Page 1 答至第 35 题。随后恢复网络。 | 本地 IDB 正常记录两段答案；恢复网络后，网络面板**严格先发** Page 0 剩余 revision 及 seal；在 Page 0 收到 200 ACK 前，**绝对没有**发起包含 `page-1` 的任何上传；服务端 0 报错。 |
| **TC-04** | **跨段回退限制与意外刷新恢复** | 答题至第 35 题（处于 Page 1），观察“上一页”按钮行为。回退到第 31 题后直接刷新浏览器（F5）。 | 在第 31 题时“上一页”置灰，不可退回 Page 0；刷新恢复后，所有已选答案正确还原，视口停留在 Page 1 且能顺利提交至第 191 题完毕。 |

### 三、 推荐的最小稳健实施路径总结

1. **协议层**：仅在 JSON 增加 `viewport_adaptive.enabled = true`，省略时不走新逻辑，保护既有协议。
2. **UI 层**：分组逻辑按 30 题段做隔离（段内算 subPages，跨段归零），绝不跨段拼凑屏幕。
3. **网络层**：在现有的 `sync` 上传前，加一个基于 `server_page_index` 的 Scope 过滤器，多余的段留在 IDB 排队。
4. **体验层**：按钮大、无默认选中、禁止跨段回退、完成时全屏 Loading 等待最终 Seal，彻底兼顾操作精简度与数据严密性。

