### 一、 真实 Bug

#### 1. 文本题变更被过滤，导致无法保存修订且阻塞提交

- **位置**：`update(event)` 内：`const text = row.question.type === 'text';
if (text ? event.type === 'change' : event.type !== 'change') return;`
- **机理**：
  - 当文本题触发 `input` 事件时，`text === true` 且 `event.type === 'input'`，该条件满足 `event.type === 'change'` 为假，导致 `text ? false : ...` 求值为 `false`。
  - 但当 `event.type === 'change'` 时，`text ? true : ...` 求值为 `true`，**直接被 `return` 拦截**。
  - 结果是：**文本题只有 `input` 能通过，`change` 被过滤**。
  - 更严重的是，用户如果在文本框输入过程中通过回车或快捷键触发表单 `submit`，由于回车触发的提交在许多浏览器（及 IME 确认后）派发的是 `change` 事件而非新的 `input`，若发生剪切、自动填充或失焦触发的 `change`，最新数据全部被抛弃。
  - 同时，条件中 `if (text ? event.type === 'change' : event.type !== 'change')` 逻辑本身写反了（本意如果是“文本题不吃 change 只吃 input，选项题只吃 change”，实际写成了反向排除）。
- **后果**：文本控件的 `change` 事件被彻底吞掉；若某些浏览器仅在失焦派发 `change`，修订将永久丢失。且该三元判断极易混淆，直接破坏“每个实际变化的 input 即时 revision”的数据合同。
- **修复**：明确事件分流：`if (text ? (event.type !== 'input' && event.type !== 'compositionend') : event.type !== 'change') return;`

#### 2. `compositionend` 事件中 `event.target` 取值错误导致捕获不到输入控件

- **位置**：`form.addEventListener('compositionend', event => { composing = false; update(event); });`
- **机理**：`compositionend` 监听在 `form` 上。虽然输入法合成事件在冒泡阶段能到达 `form`，但在某些浏览器（如 WebKit/Safari）或特定输入法下，`compositionend` 的 `event.type` 为 `'compositionend'`，传入 `update(event)` 后：
  1. `event.type` 既不是 `'input'` 也不是 `'change'`；
  2. 哪怕通过了，`event instanceof InputEvent` 为假，`event.isComposing` 为 `undefined`；
  3. 此时文本条件判断 `dependencies.has(...)` 会直接被 `event.type` 过滤阻断，**合成结束后的最终文本无法触发 `visibility()` 分支计算**。
- **后果**：依赖文本输入内容控制显隐的下游分支题，在 IME 打字完成后无法展示或隐藏，出现分支状态不一致。
- **修复**：在 `compositionend` 处理函数中显式派发或调用文本更新并强制执行显隐计算：`form.addEventListener('compositionend', event => {
  composing = false;
  if (event.target instanceof HTMLInputElement) {
    update(event);
    if (dependencies.has(event.target.name)) visibility();
  }
});`

#### 3. 题目进入隐藏态未清理 `aria-invalid`

- **位置**：`if (row.box.hidden === shown) {
  row.box.hidden = !shown; row.box.disabled = !shown;
  if (!shown) clearError(row);
}`以及 `submit` 校验逻辑：`for (const row of rows) {
  if (row.box.hidden) continue;
  // ...
  if (message) {
    row.error.textContent = message; row.error.hidden = false;
    for (const input of row.controls) input.setAttribute('aria-invalid', 'true');
    first ??= row.controls[0];
  } else clearError(row);
}`
- **机理**：首次点击提交时，若题目 A 校验失败，其控件被赋予 `aria-invalid="true"`。若随后题目 A 因上游分支变化变为隐藏，上述逻辑调用了 `clearError(row)`（清除了 `row.error.hidden` 与 `aria-invalid`）。然而，当上游再次修改使题目 A 重新显示时，题目 A 是空的但已处于显示态；如果用户提交表单，由于循环直接 `if (row.box.hidden) continue`，如果题目 A 变成隐藏前曾经有报错，但在它隐藏期间依赖发生连锁变动，其 DOM 节点的错误提示文本未清空；更关键的是，若提交失败聚焦到首个错误项时：`if (first) { first.focus(); return; }`如果上一次提交报错项现在被隐藏，由于 `first` 是每轮提交动态选出的尚属正常；但是 `row.error.textContent` 在隐藏时并未清空字符串，辅助技术读屏仍可能保留滞留错误信息。

### 二、 可选改善

1. **单选按钮（Radio）原生取消勾选的空值处理**：
  - 原生 radio 组在用户选中一项后，原生交互无法直接取消选择（变为 null）。如果此题非必填（`required: false`），用户一旦误触便无法清空。若协议允许单选题置空，建议业务层确认是否需要“清除选择”或无选态设计。
2. **CSS 媒体查询宽度覆盖冲突**：
  - 样式中先声明了 `main { max-width: 680px; margin: 24px auto; padding: 0 16px; }`，紧接着在下方声明了 `main { max-width: 920px; margin: 16px auto; }`。
  - 下方的 920px 规则直接无条件覆盖了问卷所期望的 680px 宽度，破坏了“问卷最大宽 680px”的视觉边界限制。建议将 `.runner-stage main` 与问卷 `main` 通过命名空间或类选择器隔离。
3. **`snapshot` 浅拷贝嵌套数组风险**：
  - `copyAnswer` 仅处理了 `Array.isArray(answer) ? [...answer] : answer`。对于当前 `string | string[] | number | null` 已经足够，但若未来扩展对象型回答需改用深度克隆。
4. **`dataset.theme` 命名语义**：
  - 亮色模式下设置了 `root.dataset.theme = 'gray'`，但属性如果传入 `#ffffff` 等非灰色亮色，标记为 `gray` 略显违和，建议使用 `'light'` 或 `'dark'`。

### 三、 不能从源码推出的推测

1. **“每次按键立即向 IndexedDB 写修订会导致掉帧”**：
  - 源码中 `revision()` 是外部注入的异步/同步函数，无法从本模块源码确定其内部是否进行了事务排队、微任务批处理或 Web Worker 转移，不可推测其必然造成卡顿。
2. **“30 道题每次按键顺序评估条件（evaluate）会导致输入延迟”**：
  - 30 个纯内存求值的逻辑条件，在现代 JavaScript 引擎中耗时低于 0.1ms，在无性能剖析数据支持下，不可推定存在性能瓶颈。
3. **“无 debounce 必然在低端机丢失按键焦点”**：
  - 原生 DOM 中只要不对受控组件进行强制 value 改写（`input.value = ...` 重设），单纯读取 `input.value` 并派发外部回调不会导致焦点或光标位置跳跃。

FRONTEND_CODE_REVIEW_COMPLETE
