针对上述具体方案及准备阶段的异步时序与几何核验，给出如下针对性静态优化建议：

### 一、 关键缺陷判定与最小修复补充

#### 1. 选填格式文本题清空时校验拦截（`survey-page.ts`）

- **病因**：在 `validate()` 中，判定条件为 `if (q?.type === 'text' && typeof answers[q.id] === 'string' && q.input_match && !inputMatchRegex(q.input_match).test(answers[q.id]))`。当非必填文本题被输入后又完全删空时，`answers[q.id]` 为 `""`。但各类 `preset`（如 `digits` 的 `^[0-9]+$`）均要求至少 1 个字符，导致空串匹配失败并阻断翻页，且与服务端 `pageSnapshot` 中非必填空串跳过正则的契约产生分歧。
- **补丁建议**：`const textVal = answers[q.id];
const isFilled = typeof textVal === 'string' && textVal.length > 0;
if (q?.type === 'text' && isFilled && q.input_match && !inputMatchRegex(q.input_match).test(textVal)) {
  message.textContent = inputMatchMessage(q.input_match);
  return false;
}`

#### 2. 评分拖动切换到年龄题后指针释放异常（`rating-run.ts`）

- **病因**：`choose(value)` 内部硬编码读取当前题目序号：`const range = ranges[question]!`。若被试在滑块上按住拖拽时，通过外部事件或按键切入到了年龄录入阶段（`question === items`），延迟到达的 `pointerup`/`pointermove` 将调用 `choose`，使 `ranges[question]` 为 `undefined`，导致 `range.dataset.answered` 抛出空指针异常崩溃。
- **补丁建议**： 在 `choose` 入口增加界限保护；且滑块自身的 `pointerup` 更新应当定向作用于当前捕获事件对应的 `range` 实例自身，而非全局 `ranges[question]`：`if (phase !== 'rating' || submission || stopped || question >= ranges.length) return;`

#### 3. 准备阶段异步等待后的取消与几何二次校验（`run.ts`）

- **病因**：
  1. `prepare()` 中在 `await reserve()`、`await prepareImages()`、`await storageProbe()` 之间经历多次长时间网络与微基准测量。若被试在此期间点击取消返回，Promise 恢复后若未立即抛出中断，后续代码仍会强行给 `body` 增加 `runner-layout` 并挂载画布。
  2. `start` 按钮触发后，在 `await reserve()` 到请求 `permit` 之间存在网络延迟。若移动端浏览器在此期间完成工具栏收起或微小布局重排，提交到 `permit` 的仍为旧的 `ready` 几何，导致第一帧 `tick` 立即命中 `VISIBILITY_OR_GEOMETRY_CHANGED` 而误判中断。
- **补丁建议**：`const next = await reserve();
reservation = next;
const currentGeo = measuredGeometry();
if (JSON.stringify(currentGeo) !== JSON.stringify(ready)) throw new Error('准备后布局已变化，请重新准备。');
const permit = await request<NonNullable<LabSession['permit']>>(api!.path('permit'), {
  ...,
  readiness: { ..., geometry: currentGeo }
});`
  - 在每一个核心 `await` 恢复之后显式加入 `preparing.signal.throwIfAborted()`。
  - 在向 `/permit` 发送请求前一刻，重新刷新并核准真实几何，确保发往服务端的快照与当前物理 DOM 绝对一致：

### 二、 拟采纳方案的工程落地建议

1. **快照编码字节预算（`interaction-recorder.ts`）**： 在 `screen()` 遍历提取节点样式与文本时，维护一个增量 `jsonLength` 估算值。当估算体积超过 80KB 时立即跳出循环，设置 `truncated = true` 并输出带有完整包装结构的快照。这既能保障被试端的快速响应，又绝对避免了因超出 IndexedDB 单事件 128KB 预算而触发致命中断。
2. **异常重试解绑输入监听（`run.ts`）**： 在 `finish()` 的 `catch (error)` 块顶部立即调用 `remove()`。这确保了当由于网络原因导致 `seal` 失败并弹出恢复重试界面时，被试在恢复界面上的点击与按键不会被当成任务运行中的多余输入记录到底层账本中。
3. **并发锁失锁界面支持重试（`participant.ts`）**： 当 `navigator.locks.request` 返回 `lock === null` 时，除了展示“在其他页面打开”提示外，保留一个“重新检测并进入”的按钮，被试关闭冲突标签页后点击该按钮即可重新请求锁，而无需强刷页面丢失会话状态。
4. **评分组件按键切题后的焦点衔接（`rating-run.ts`）**： 在 `submit.onclick` 步进到下一题后，调用 `ranges[question]?.focus({ preventScroll: true })`（进入年龄题时则聚焦到对应输入区域），防止当前元素变为 `disabled` 导致焦点回落至 `<body>` 而阻断纯键盘无障碍流程。

INTERACTION_AUDIT_DONE
