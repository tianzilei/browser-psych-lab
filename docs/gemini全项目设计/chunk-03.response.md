**业务作用**： 完成试次时序/ISI预算与评级组限制检查、变体与布局解析；提供问卷页面快照计算（含跳题与答案状态）；启动问卷编译解析器及刺激包/图片路径安全校验。

**设计建议**： 在 `pageSnapshot` 中，对 `q.type === 'scales'` 答案遍历使用了 `values[axis.id]`，建议先校验 `values` 的原型安全（或通过 `Object.create(null)` 解构），防注入 `constructor` 键导致逻辑污染。
