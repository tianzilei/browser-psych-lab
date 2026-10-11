**业务作用**： 实现 `questionnaire-v1` DSL 向底层 `study-v1` 协议的降解与归一化编译，支持图片包解引用、量表端点自动补齐、默认变体组装，并提供标准内置问卷模板。

**设计建议**： 自动生成变体的 `trial_order` 遍历使用了 `compiled.map`，当且仅当存在重名 `group.id` 时会被隐式覆盖；宜在编译入口对 `compiled` 中 `g.id` 的唯一性提前执行 `Set` 断言，阻断歧义。
