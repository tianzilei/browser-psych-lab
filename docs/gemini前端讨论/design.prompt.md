请与我共同审查 Browser Psych Lab 的问卷前端轻量化设计。用户明确要求“问卷前端尽可能简洁减少占用和计算，纯色前端，包括灰色 background 和深色 background，页面文本做限制，文本渲染简洁”。请只讨论以下给定工程上下文，不需要网络研究，也不要给无实测的性能数字。

项目：TypeScript/Vite，多入口，Fastify/SQLite，自托管，1Mbps 带宽，同时1–2个参加者，其余 FIFO。正式问卷 participant.ts 动态 import survey-page.ts，目前 survey-page.ts 使用 SurveyJS Model/renderSurvey/整套 survey-core.min.css。只支持四型 single/multi/scale/text，文本用 textContent 避免 Markdown/HTML。检查页有一个显式加载的 SurveyJS demo 可继续保留。共用 style.css 现在浅绿色根背景+白色 section、绿色按钮、圆角，问卷和Canvas使用它。
协议 page 最大30题，single/multi 2–20项，scale最多21个整数值，text.max_length=1..4000。已有字段上限：研究/页/组标题200字符，题目1000，说明8000，选项200。pageSnapshot服务端逐题按顺序 evaluate 条件：只引用之前的题，隐藏题effective answer=null，required只验证显示题。隐藏答案保留在浏览器但服务器记录SKIPPED。answers: string|string[]|number|null；revision callback逐事件写 IndexedDB，complete写snapshot+封存。不可丢失分支/已保存答案、不能 debounce 掉原始修订、不能以主题改变Canvas的冻结背景或在图片运行中改几何。
当前 mountPage 大意：
new Model({showTitle:false,showCompletePage:false,completeText:'提交本页',clearInvisibleValues:'none',elements:...4 types});
survey.data=values;
visible() {effective={...previous}; for(q of page.questions) {shown=evaluate(q.condition,effective);survey.getQuestionByName(q.id).visible=shown;effective[q.id]=shown?survey.data[q.id]??null:null;}}
onValueChanged -> visible(); revision(name,value??null,survey.data); onComplete -> complete(survey.data).

拟实现：
1. 原生 form/fieldset/legend/input radio/checkbox/text + integer scale radio，单次挂载；form委托 input/change/submit监听；仅在值变化时对最多30题顺序计算条件并只改变hidden状态，不整页重建；快照复制以保护异步修订。
2. 参加者独立的最小CSS，系统字体，无外部字体、阴影、渐变、动画、Markdown、复杂文本DOM。页面标题+说明+题目+一枚提交按钮；保留必要状态文本与错误恢复。
3. 使用已有 protocol.layout.background（#RRGGBB）确定一次固定纯色页面背景和中性文本色。新草稿默认gray #e5e5e5，研究管理提供gray/dark #202020预设，保留历史自定义色。主题随研究冻结，无参加者运行中开关。Canvas仍用精确的protocol.layout.background。
4. 文本设更小的“新草稿保存/发布”预算，旧冻结仍按原有schema恢复，不在渲染时截断研究文本。候选上限：研究/页/组标题120、题目300、说明2000、选项80、文本答案1000。需考虑知情同意说明或已有长草稿，避免把展示budget当语义删除。也可沿用既有硬上限只加强编辑器maxLength+清晰发布校验。请给明确取舍。
5. 图片运行期间目前每次ONSET更新status文字；可先不改时序链路，或者仅确有安全的事件更新。
请评估设计、可能回归、可访问性、输入法/键盘、多选与量表空值、分支隐藏恢复、文本预算与冻结兼容。给可直接实施的建议，指出错误和你建议的最小边界。末尾写 FRONTEND_DESIGN_REVIEW_COMPLETE。
