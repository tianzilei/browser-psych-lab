**业务作用**： 定义协议变体与预算约束；提供稳定 JSON 序列化；严密校验输入匹配规则（防 ReDoS）、条件跳转表达式及问卷页面/题目（单选/多选/单量表/多轴量表/文本）与实验组基本骨架。

**设计建议**： `evaluate()` 中 `answers[c.question]` 若为多轴量表对象时，`a = value[c.axis]` 应校验 `Object.prototype.hasOwnProperty.call(value, c.axis)`，防止原型污染属性引起误判。
