# Gemini CSS 逐页讨论记录

本记录来自 2026-10-10 通过 `gemini-bridge` 与 Gemini 的多轮讨论，并根据当前工作区源码做了二次核对。Gemini 的建议保留为设计参考；“已确认”表示可以在当前代码中直接看到，“待验证”表示需要先确认运行时 DOM 或产品意图。

## 参与者页：`participate.html`

### 已确认

- 页面加载 `participant.css`，采用 `main` 两行 Grid、`.questionnaire` 三行 Grid、`.question-screen` 两行 Grid。
- `main` 已包含 `100dvh`、顶部安全区和底部安全区；按钮已有 `48px` 最小触控高度，且全局设置了 `touch-action: manipulation`。
- `.axis-control` 当前使用固定的 `1.5rem .75rem` 内边距；Gemini 提到的 `3dvh 2vw` 和 `10%/1fr/14%`、`38%/62%` 不存在于当前文件，不能按该前提修改。

### 建议

1. 保持现有 Grid 结构，先在真实设备上检查长题干、软键盘和短屏布局；不要直接改成 Flex，以免改变问卷分页的几何约束。
2. 量表的 `.axis-input` 已使用 `touch-action: none`，而 `.axis-control` 没有覆盖它。若要调整手势，只应改滑块输入本身并在真实触控设备回归，不能把 `touch-action: none` 扩大到整个控件。
3. 可评估给 `.question-nav` 增加 `padding-bottom: var(--safe-bottom)`；这是低风险的安全区补强，但需确认底部导航是否已经由父级安全区覆盖。

## 实验运行页：`run.html`

### 已确认

- `run.ts` 加载 `participant.css` 和 `runner.css`，没有加载 `style.css`，因此不存在 Gemini 所说的两套公共 CSS 直接覆盖冲突。
- 运行时通过 `lockParticipantViewport()` 和 `preventTaskGestures()` 锁定视口与手势；`body.running` 也会在正式运行时添加。
- `runner.css` 已提供 `.runner-stage`、`.canvas-slot`、`#stimulus` 和 `.response-buttons` 的布局，且没有发现 CSS transition/animation。

### 建议

1. 不要直接引入 `position: fixed`、`contain: strict` 或全局 `transition: none !important`。这些改动可能影响现有 `lockParticipantViewport()`、Canvas 尺寸测量和启动前几何一致性。
2. 可以先加入只读的浏览器回归检查：运行开始前后比较 Canvas 与按钮的 `getBoundingClientRect()`，这与现有 `geometry()` 校验一致。
3. 若需要强化实验态样式，应限定在 `body.running`，并先通过反应时与不同方向测试；不要对准备页和启动按钮套用运行态规则。

## 模拟页：`simulate.html`

### 已确认

- `simulate.ts` 加载 `participant.css` 与 `runner.css`，没有日志终端、`#log`、`#output` 或模拟控制表单；页面主要是通过 `postMessage` 接收协议并渲染 `.runner-stage`。
- 因此 Gemini 提出的“双栏控制台”和“日志独立滚动”选择器目前没有对应 DOM，不能直接添加。

### 建议

- 优先复用参与者页的 `.runner-stage`、`.canvas-slot`、`.response-buttons` 规则，检查图片、文字刺激和多按钮选择在窄屏下是否可见。
- 如果以后增加日志或控制面板，再根据实际 DOM 增加页面专属根类和滚动容器；不要预先加入未使用的 `#log`/`.simulate-controls` 规则。

## 管理页：`index.html` / `admin.html`

### 已确认

- 两页都加载 `admin.ts`；`admin.ts` 加载 `style.css` 和 `admin.css`。
- `main.wide`、`#app`、`#message` 和 `.simulation-overlay` 是实际选择器；弹层当前通过 Grid 排列关闭按钮和 iframe。

### 建议

1. 保留 `.simulation-overlay` 的全屏定位，并给 iframe 外层继续保持 `min-height: 0`；如实测矮屏下按钮不可见，再增加内部滚动约束。
2. `#message:empty { display:none }` 是低风险的空状态清理，可直接采用。
3. 表格横向滚动需要根据 `admin.ts` 实际生成的 DOM 决定容器选择器；不要使用过宽的 `div:has(> table)` 覆盖所有布局。
4. 管理页标题和提示文本存在乱码样式迹象，CSS 不能修复编码；应单独检查源文件 UTF-8 和构建链路。

## 诊断页：`diagnostics.html`

### 已确认

- 页面使用 `style.css`，Canvas 固有尺寸为 `480x100`，而 `style.css` 已有 `canvas { max-width: 100%; border-radius: 8px; }`。
- `main.ts` 只绘制 Canvas，不监听 Canvas 点击或根据 `getBoundingClientRect()` 反算坐标；因此 Gemini 提到的“CSS 缩放导致点击坐标映射偏移”当前不成立。

### 建议

- 可补充 `canvas { display:block; height:auto; }`，但属于视觉细节，不是当前阻塞问题。
- `#checks` 目前是普通列表；如需要状态刷新稳定，可增加 `font-variant-numeric: tabular-nums`，并保留现有 `li[data-status="failed"]` 的错误颜色。
- 诊断页的 section 卡片、窄屏间距和按钮热区属于体验优化，建议在不改变 Canvas 的实际绘制尺寸前提下进行。

## P0 页：`p0.html`

### 已确认

- 页面加载 `style.css`；真实结构包括 `#status`、`#questionnaire`、`fieldset`、`#retry`、`#unknown-close` 和 `#evidence`。
- `#evidence` 实际是普通段落，不是 `<pre>`；当前内容是短状态和完成凭证，但未来错误信息可能变长。

### 建议

- `fieldset { min-width: 0; box-sizing: border-box; }` 和 `#evidence { overflow-wrap:anywhere; user-select:text; }` 是低风险防御性补丁。
- 两个操作按钮可保持至少 `48px` 高度，并在窄屏下改为纵向排列；这不会影响正式实验主链路。
- 不建议为 P0 页引入复杂主题变量或外部字体，保持 `style.css` 的轻量基础规则。

## 优先级

1. **先验证再改**：参与者页长题干/软键盘/安全区；运行页启动前后几何一致性。
2. **低风险可改**：管理页空消息、P0 的 fieldset 和证据文本保护、诊断页数字等宽显示。
3. **暂不实施**：模拟页双栏日志工作台、运行页全局固定定位和严格 containment；当前 DOM 或脚本没有支持这些假设。

## 高风险提醒

- 任何会改变 `.runner-stage`、Canvas 或按钮 `getBoundingClientRect()` 的规则，都可能触发现有准备阶段的布局一致性校验。
- 不要把滑块的 `touch-action: none` 扩散到整个问卷容器；应保留页面滚动能力。
- 不要用 CSS 缩放 Canvas 后再假设内部坐标仍与 CSS 像素相同；若未来增加 Canvas 交互，必须同步做 DPR/缩放换算。

## 最终收敛方案（第二轮 Gemini 审查）

本轮进一步核对了 `TextPager`、`run.ts` 的几何校验和各页真实 DOM，最终只保留以下候选。最小补丁已应用到源码；参与者页保持不变。

### 已应用的最小补丁

```css
/* runner.css */
body.running #stimulus,
body.running .response-buttons button {
  transition: none !important;
  animation: none !important;
}

/* style.css */
#canvas { height: auto; }
fieldset { min-width: 0; }
#evidence { word-break: break-all; max-height: 12rem; overflow-y: auto; user-select: text; }
```

- `body.running` 只在 `run.ts` 完成 `geometry()` 校验并开始正式运行后添加，不改变启动阶段盒尺寸。
- `#canvas` 只存在于诊断页；`style.css` 已有 `canvas { max-width: 100%; }`，补充 `height:auto` 后可在窄屏保持比例。当前诊断脚本没有 Canvas 坐标交互。
- `fieldset` 是防止原生最小宽度撑裂的通用重置；提交前仍应观察管理端动态表单样式。
- `#evidence` 只存在于 P0 页，保留普通段落语义，同时允许长错误串换行、局部滚动和复制。

应用文件：`src/web/runner.css`、`src/web/style.css`。

验证结果：`npm run typecheck` 通过；`npm run test:unit` 共 74 项，71 项通过，3 项失败，失败来自 Windows symlink 权限、测试依赖的 `python3` 命令不可用，以及已有归档表示断言，与本次 CSS 修改无关。

### 明确不提交的建议

- 不修改 `.reading-text` 的高度、`display`、`overflow` 或对齐方式；`TextPager` 依赖这些几何量进行分页。
- 不给 `.question-nav` 添加 `sticky` 或重复的安全区；当前已有 Grid 第三行和 `padding-bottom: var(--safe-bottom)`。
- 不重构参与者页 Grid/Flex，不使用 `position: fixed`、`contain: strict`，不新增模拟页日志/控制台选择器。

### 验证标准

1. 参与者页长题干和分页阅读仍能正常翻页，`TextPager` 不提前截断或死循环。
2. `run.html` 启动前几何校验通过；运行后 `body.running` 下刺激和响应按钮没有过渡动画。
3. 诊断页在 360px 宽度下 Canvas 等比缩放且无横向滚动；桌面端保持 480×100 的内在尺寸。
4. P0 页注入无空格长错误串后，页面不横向溢出，证据区域可滚动和复制。
5. 管理端已有字段集在窄屏下不出现横向撑裂。
