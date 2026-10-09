## 1. 架构与边界评估

### 核心结论

完全赞同在 `participant.ts` 的正式问卷路径中剥离 SurveyJS 核心库及 `survey-core.min.css`，替换为原生 HTML 表单渲染器。

当前在 1Mbps 带宽与低算力场景下，SurveyJS 引入了庞大的 DOM 树、内联样式计算与虚拟化/状态观察开销。原方案仅使用 `single`、`multi`、`scale`、`text` 4 种题型，原生语义化标签足以完全覆盖。

### 最小实现边界

- **保留 SurveyJS**：仅在管理端/检查页（Check Page Demo）按需加载，维持调试用途。
- **正式问卷独立化**：正式 `survey-page.ts` 零第三方运行时依赖，仅导出统一接口 `mountPage(...)` 与清理回调。
- **完全隔离 CSS**：正式问卷**不再加载共用 `style.css`**（避免引入未清理的渐变、圆角、绿色按钮等样式）。正式问卷提供一份内联或极小独立 CSS 文件。

## 2. 详细技术点审查与回归风险

### 2.1 表单挂载、事件委托与快照复制

- **`input` vs `change` 事件分流**：
  - **单选（radio）/多选（checkbox）/量表（scale radio）**：监听 `change` 事件触发即时持久化。
  - **文本输入（text input/textarea）**：不可在每次按键（`input`）触发全局显隐重新求值或全量 IndexedDB 写入；但用户输入未离焦（`blur`/`change`）时若发生断电或崩溃会丢字。
  - **实施方案**：单/多选/量表统一由 `change` 处理。文本题在 `input` 时更新本地轻量 draft 缓存并节流/防抖写入临时草稿，或严格在 `change`（失焦）时发起正式 `revision`。**切记：不能丢弃用户的原始修订事件序列，每次提交的 payload 必须为深拷贝快照**：`const currentSnapshot = JSON.parse(JSON.stringify(answers));
revision(name, value ?? null, currentSnapshot);`
- **单次挂载与纯 hidden 切换**：
  - 使用 HTML `hidden` 属性（或 `display: none`）切换题目的可见性，严禁动态 `innerHTML` 重建，确保焦点不漂移、输入法状态不中断。
  - 仅针对可见题型校验 HTML5 `required`，隐藏的题目设置 `disabled = true` 或在验证逻辑中排除，防止浏览器原生表单验证阻止表单提交。

### 2.2 键盘、无障碍（a11y）与输入法（IME）

- **语义结构**：
  - 每道题目为一个 `<fieldset data-qid="...">`，题干使用 `<legend>`（使用 `textContent` 注入）。
  - 选项使用 `<label><input type="radio|checkbox"> <span>...</span></label>` 嵌套结构，增大点击热区并保证原生键盘空格/箭头导航可用。
  - 文本题使用 `<label for="qid">` + `<textarea id="qid">`。
- **输入法兼容（IME）**：
  - 文本题必须尊重 `compositionstart` / `compositionend`。在合成未结束前不要触发任何可能重设值或触发分支判断的动作。

### 2.3 多选、量表与空值/隐藏数据合同

- **多选值合同**：
  - 多选若全不选，统一为 `[]`（或按服务端合同为 `null`，建议严格保持与旧 SurveyJS 行为一致，若旧合同为未选即 `null` 或 `[]`，必须完全同构）。
- **量表（scale）数据类型**：
  - 原生 radio 的 `value` 为字符串。在读取与存储时，必须做 `Number(rawVal)` 转换，确保写进 IndexedDB 和提交服务端的类型为严格的 `number` 而非 `"1"`。
- **分支隐藏时的恢复与求值**：
  - **核心规则**：当题 A 改变使题 B 隐藏时，题 B 在客户端内存中的值保留（不擦除），但在执行 `visible()` 顺序求值时，题 B 的 `effectiveAnswer` **强制视作 `null`**；提交时服务端同样视作 `SKIPPED`。
  - 若后续操作让题 B 重新显示，输入框原值仍存在且重新成为有效值。这与原服务端的“逐题顺序求值、只引用之前题目”算法完全一致。

## 3. 背景色、主题与 Canvas 冻结一致性

- **页面背景渲染**：
  - 问卷页根据 `protocol.layout.background`（例如 `#e5e5e5` 或 `#202020`）直接设置在 `document.documentElement` 或独立挂载容器上。
  - **文本前景色计算**：禁止使用复杂 CSS 变量切换系统，直接根据背景亮度（如通过相对亮度公式或简单的 Hex RGB 分量计算）固定中性文本色：
    - 浅色背景（如 `#e5e5e5`）$\rightarrow$ 文本 `#111111`，边框 `#999999`。
    - 深色背景（如 `#202020`）$\rightarrow$ 文本 `#eeeeee`，边框 `#555555`。
- **Canvas 几何与背景硬隔离**：
  - 问卷的 CSS 必须彻底限制在问卷容器内部，**绝对不能改写全局 `body` 的 `overflow`、`margin` 或 Canvas 视口几何**。
  - 图片运行阶段 Canvas 继续独占屏幕，继续采用原有的精准十六进制背景色，禁止任何外部主题变更干扰 Canvas 的像素级渲染。

## 4. 文本预算与向后兼容取舍

关于字段长度上限，**强烈建议：沿用既有数据硬上限（协议与数据库 Schema 不变），仅在研究设计器（Editor）中加强软性建议与输入验证**。

| 字段 | 既有硬上限 | 建议设计器限制 | 取舍理由 |
| --- | --- | --- | --- |
| **研究/页标题** | 200 字符 | 120 字符 | 避免多行折行破坏纯色单页排版 |
| **题目** | 1000 字符 | 300 字符 | 问卷题干应简明，长题干不利于移动/低分辨率显示 |
| **说明（Instruction）** | 8000 字符 | **保持 8000 字符硬预算** | **绝对不能截断至 2000 字符**。心理学实验知情同意书（Informed Consent）、伦理批件文本往往极长，截断会导致知情同意书无法发布 |
| **选项** | 200 字符 | 80 字符 | 选项过长导致布局对齐错乱 |
| **文本作答（Text Ans）** | 4000 字符 | 4000 字符 | 由协议中的 `text.max_length` 决定，不人为缩水 |

- **向后兼容原则**：对于已冻结（Frozen）的历史协议，前端渲染时**一律不做文本截断（不使用 `slice`/`substring`）**，避免产生语义丢失或伦理合规风险。

## 5. 图片运行期间的状态文本更新

- **时序安全性判断**：图片刺激呈现要求帧级准确。目前“每次 ONSET 更新 status 文字”直接触发了 DOM 修改（哪怕是 `textContent` 也会触发重排/重绘），存在导致下一帧丢帧的风险。
- **改进策略**：
  - 刺激呈现进行中（Stimulus Running）**严禁更新任何 DOM**。
  - 状态文字更新仅在 Trial 间隙（Inter-Trial Interval, ITI）、Block 切换或真实安全暂停阶段同步。

## 6. 极简 CSS 落地规范（独立于 style.css）

为参加者问卷使用一份极小样式表，剥离所有视觉装饰：

```
/* participant-survey.css 示例，极简且无动画 */
.survey-root {
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.4;
  max-width: 680px;
  margin: 0 auto;
  padding: 24px 16px;
}
.survey-root fieldset {
  border: 1px solid currentColor;
  margin: 0 0 16px 0;
  padding: 12px;
}
.survey-root legend {
  font-weight: bold;
  padding: 0 4px;
}
.survey-root label {
  display: block;
  margin: 6px 0;
  cursor: pointer;
}
.survey-root input[type="text"],
.survey-root textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  padding: 6px;
}
.survey-root button[type="submit"] {
  font: inherit;
  padding: 8px 16px;
  cursor: pointer;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
}
.survey-root [hidden] {
  display: none !important;
}
```

FRONTEND_DESIGN_REVIEW_COMPLETE
