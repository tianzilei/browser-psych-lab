# Gemini bridge 刺激任务设计讨论（原始答复）

- Request: `req_Ve-NppBmkUkb9yjrvYP3Gg`
- Result: `res_4ffc78af71c99f2ca630`
- 保存时间: 2026-10-09T05:46:59.746378Z
- 完整性: complete
- [会话](https://gemini.google.com/app/71c7ead686e53505)

以下为 Gemini 的原始建议，并非最终配置规范。实际字段及取舍见 [刺激任务设计](../刺激任务设计.md)。

### 1. 架构原则与确定性回放模型

在 Browser Psych Lab 中，保证**服务端 `RunReplay` 与前端 Canvas 离线/在线事件回放完全一致**的前提是：

1. **计划确定性（Deterministic Plan）**：所有试次顺序、刺激时长（含 Jitter 离散化毫秒数）、ISI、类别抽样，**必须且仅能在服务端由 `GroupPlan` 生成时确定**，写入不可变清单（Manifest）。前端仅作为无状态执行器（Executor），严禁在浏览器端动态使用 `Math.random()` 派生时间或试次。
2. **时间轴严格等长（Strict Timeline Invariance）**：作答反应、视觉确认高亮、即时反馈（Feedback）的出现，**严禁截断或延长当前试次的物理持续时间**。Trial 的总生命周期在计划生成时即被固化为固定毫秒数。
3. **兼容旧版协议（Backward Compatibility）**：旧版无新字段协议在反序列化时，自动赋予 `schema_version: 0` 或默认静态值，走回退路径，保证哈希不变与无缝重放。

### 2. 增强型 JSON Schema 设计

在 `questionnaire-v1.json` / `study-v1.json` 的 Group 层级与 Trial 层级增加以下标准化结构：

```
{
  "schema_version": 2,
  "groups": [
    {
      "id": "lexical_decision_task",
      "timing_defaults": {
        "stimulus_ms": { "base": 3000, "jitter": 500 },
        "isi_ms": { "base": 1000, "jitter": 200 }
      },
      "feedback_config": {
        "enabled": true,
        "duration_ms": 400,
        "show_correctness": true
      },
      "ordering": {
        "mode": "category_interleaved",
        "category_key": "category",
        "max_run_length": 3
      },
      "input_modes": ["pointer", "keyboard"],
      "choices": [
        { "id": "yes", "label": "是 (F)", "key": "KeyF" },
        { "id": "no", "label": "否 (J)", "key": "KeyJ" }
      ],
      "repeats": 0,
      "trials": [
        {
          "root_id": "t1",
          "stimulus_type": "text",
          "text": "APPLE",
          "text_style": { "font_size_px": 48, "color": "#ffffff" },
          "category": "word",
          "correct": "yes"
        },
        {
          "root_id": "t2",
          "stimulus_type": "image",
          "asset_id": "img_uuid_01",
          "category": "non_word",
          "correct": "no",
          "stimulus_ms": 2500
        }
      ]
    }
  ]
}
```

#### 关键字段语义：

- **`stimulus_type`**：`"image" | "text"`（旧协议无此字段时，若存在 `asset_id` 则隐式推导为 `"image"`）。
- **`stimulus_ms` / `isi_ms`**：支持数值（显式硬编码）或 `{ "base": number, "jitter": number }`。若 trial 级别显式配置为数字，**完全覆盖** group 的 `timing_defaults`。
- **`choices[i].key`**：标准化 `KeyboardEvent.code`（如 `"KeyF"`, `"KeyJ"`, `"Space"`）。

### 3. Jitter 伪随机与组内零和平衡算法

心理物理学中常需要固定均值的刺激/空屏间隔抖动（Jitter）。为了在同一种子（PRNG）下完全可复现，且总任务时长严格锁定，必须采用**受限伪随机排列（Shuffled Latin Squares/Permutation Slots）与余数平摊算法**。

#### 3.1 离散步进与帧量化（Frame Quantization）

屏幕按刷新率（60Hz、120Hz）离散刷新。毫秒抖动若非刷新率整数倍会引起帧抖动（Frame Jitter）。

- **设计规则**：设定离散步进量 $\Delta = 16.666\text{ ms}$ 或标准量化网格（例如 $50\text{ ms}$ 或 $100\text{ ms}$）。
- 允许的抖动偏离集：以 $K$ 步离散网格划分。例如 base = 3000, jitter = 500, step = 50，则偏移集合为 $\{-500, -450, \dots, 0, \dots, 450, 500\}$。

#### 3.2 零和多重集分配算法（Zero-Sum Balance）

为保证该组内所有 trial 的总时长等于 $N \times \text{base}$，Jitter 必须在一个平衡池（Balance Pool）内取值：

1. **剔除显式设定项**：遍历组内所有 Trial，若某 Trial 显式定义了 `stimulus_ms: 2500`，该 Trial **不参与配额池**，直接写入其固定值。
2. **构建平衡阶梯**：设待平衡试次数量为 $M$。
  - 当 $M$ 为偶数时：成对生成对称偏离对 $(+\delta_i, -\delta_i)$。
  - 当 $M$ 为奇数时：保留一个 $0$，其余成对分配。
  - 若 $M$ 小于偏移集合的步数，取最大对称子集；若 $M$ 超过集合步数，周期性循环平铺该集合。
3. **余数平摊**：若 $M$ 个偏离槽（slots）求和 $\sum \delta_i \neq 0$（例如受限于离散步长与最大范围），计算残差 $R = - \sum \delta_i$。在 PRNG 随机选择的槽位上，以步长 $\pm \Delta$ 微调，直至 $\sum \delta_i = 0$。
4. **确定性洗牌（Deterministic Shuffle）**：使用当前 Session 的 `seed`，通过带状态的 Mulberry32 或 PCG32 生成器对离散偏移数组进行 Fisher-Yates 洗牌，依次赋给各 Trial。
5. **补测试次（Practice / Catch / Repeat Trials）**：
  - **明确规则**：补测或因错误重复的试次（Repeats）**严禁拉伸或污染原始试次的总体平衡**。补测试次使用自己的局部 Jitter（取偏移集中最接近 0 的确定性值，或由其专用独立子种子生成），**不计入全局总和抵消计算**。

### 4. 刺激顺序生成策略与冲突降级

支持三种模式：`"fixed"`（固定）、`"shuffle"`（全局伪随机）、`"category_interleaved"`（分类平衡交错）。

#### 4.1 分类交错与最大连续限制算法（Max-Run Constrained Shuffle）

实验常要求“同一类别（如负向情绪面孔）最多连续出现 $K$ 次（`max_run_length`）”。

1. **多桶抽样算法**：
  - 将各 Trial 按类别划分至对应的 List。
  - 维护上一个被选中的类别及当前连续计数 `current_run`。
  - 候选集为：若 `current_run >= max_run_length`，排除当前类别；从其余非空类别桶中根据 PRNG 随机选出一个。
2. **不可满足（回溯失败/死胡同）的确定性降级处理**：
  - 若剩余元素仅剩同一类别（由于各类别基数悬殊，导致无法满足 `max_run_length`）：
  - **不可抛出运行时未定义行为**。执行确定性降级规则：
    1. 最多尝试回溯（Backtracking）32 次置换。
    2. 仍不可解时，**记录警告并在 Plan 中标记 `constraint_violated: true`**，强制将剩余同类元素平铺于尾部，同时在 Replay 签名中包含此确定性产物。保证任何机器回放时均完全一致。

### 5. 交互输入、防止误触与无偏响应窗口

#### 5.1 响应窗口切分与视觉状态机

每个 Trial 的生命周期被划分为三个严格时序阶段：

$$
\text{Total Duration} = T_{\text{stimulus}} + T_{\text{isi}}
$$

```
[ Trial 开始 ]
  │
  ├─ 刺激窗口 (Stimulus Window: 0 ~ T_stimulus)
  │    ├─ 渲染刺激 (Image 或 Text)
  │    ├─ 开放输入监听 (is_accepting_input = true)
  │    ├─ 用户首答 (First Response) ──────> 锁定答案，记录 RT，
  │    │                                    切换按键/屏幕为 "active" 高亮状态，
  │    │                                    若启用 Feedback 则切换显示反馈内容。
  │    │                                    (注意：时序不中断，继续运行)
  │    └─ 窗口结束 ──────────────────────> 关闭输入监听，清空刺激
  │
  ├─ 间隔窗口 (ISI Window: T_stimulus ~ T_stimulus + T_isi)
  │    ├─ 渲染注视点 (+) 或黑屏
  │    └─ 拒绝任何输入 (任何点击/按键均丢弃或标记为早冲动)
  │
[ Trial 结束，切换下一试次 ]
```

- **首答保护（First Response Latch）**：仅记录刺激窗口内的首次有效输入。后续输入忽略，避免抖动双击。
- **时序刚性**：无论用户在 200ms 还是 2500ms 作答，或者超时未答（Timeout），Trial 都必须在 $T_{\text{stimulus}}$ 毫秒准时切入 ISI，并在 $T_{\text{stimulus}} + T_{\text{isi}}$ 准时结束。

#### 5.2 阻止浏览器默认误触行为

必须在 Canvas 挂载容器与全局窗口上消除长按、上下文菜单与手势缩放干扰：

1. **禁止右键菜单与文本选择**：`canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.style.userSelect = 'none';
canvas.style.webkitUserSelect = 'none';
canvas.style.touchAction = 'none'; // 彻底禁用双指缩放与平移`
2. **过滤非主键点击**：
  - 监听 `pointerdown` 时，**强制判断 `e.button === 0`**。
  - 若 `e.button !== 0`（如右键、滚轮中键、侧键），直接忽略，严禁记录为作答。
3. **防止跨试次长按作答**：
  - 维护 `active_pointer_id: number | null = null`。
  - 仅在当前试次内、且无按压残留（`pointerup` 已释放）的前提下，才接收新的 `pointerdown`。
  - 若受试者在 ISI 期间按住不放进入下一试次，该接触点直接作废，直至捕获到全局 `pointerup` 释放。

#### 5.3 键盘与触摸共用审核管线（Unified Input Pipeline）

不管是 Pointer 还是 Keyboard，进入事件系统的抽象结构必须归一化：

```
interface NormalizedInputEvent {
  choice_id: string;
  source: 'pointer' | 'keyboard';
  raw_code: string; // 'button_0' 或 'KeyF'
  client_time_ms: number; // 相对 Trial 刺激呈现的 performance.now() 偏移
}
```

- **键盘监听边界**：
  - 使用 `e.code` 匹配，不受输入法（IME）或 CapsLock 影响。
  - 必须阻断默认行为：若匹配中目标键（如 `KeyF`, `Space`），调用 `e.preventDefault()` 防止页面触发滚动或快捷键。
  - **忽略按键重复**：严格检查 `if (e.repeat) return;`。

### 6. 服务端与客户端一致性验证机制

在客户端向服务端提交 `RunRecord` 时，服务端 `RunReplay` 进行无状态确定性推演验证：

1. 服务端根据协议原始 JSON + Session 种子，重新初始化 PRNG，运行完全相同的 `GroupPlan` 生成器，得出预期的每个 Trial 呈现毫秒数矩阵与刺激序列。
2. 校验客户端上传的每一个事件：
  - 检查客户端上报的响应延迟 $RT$ 是否满足：$0 \le RT \le T_{\text{stimulus}} + \text{网络/帧宽限容差 (如 32ms)}$。
  - 检查输入源：若是键盘输入，按键代码必须在协议的 `choices[].key` 映射表中；若是触摸，点击坐标必须在对应 Choice 按钮的 Bounding Box 内。
  - 验证总时序总和：客户端整个组的耗时必须与服务端计划时长吻合（在累计帧时间漂移容差范围内，通常容许 $\pm 1$ 帧/Trial）。

### 7. 必须覆盖的自动化测试清单 (Test Matrix)

为确保该模块不破坏单写入隔离与确定性重放，必须编写以下具体用例：

#### 7.1 Jitter 与时间确定性测试

1. **同种子一致性测试**：使用相同 Seed 对包含 100 个 Trial 的分组运行计划生成器 1000 次，生成的刺激呈现时长数组与 ISI 数组的 SHA-256 哈希值必须 100% 相同。
2. **零和平衡测试**：验证在任意输入试次数（如 $N=1, 2, 7, 50, 99$）下，$\sum (T_{\text{stimulus}} - \text{base}) = 0$ 且 $\sum (T_{\text{isi}} - \text{base}) = 0$。
3. **显式覆盖隔离测试**：为第 3 个 Trial 显式指定 `stimulus_ms: 1200`，测试其余参与 Jitter 的 Trial 是否依然保持自身的均值平衡，且第 3 个 Trial 时长恒等于 1200。
4. **帧量化整除测试**：测试生成的离散时间数组中，每一个数值都能被定义的步长（如 50ms）整除，且不越界 $[base - jitter, base + jitter]$。

#### 7.2 顺序与类别交错测试

1. **最大连续运行截断测试**：给定两个类别 A (50个) 和 B (50个)，设置 `max_run_length: 2`，断言生成的序列中绝不存在连续 3 个相同的类别。
2. **极端不可满足容错测试**：给定 A (90个) 和 B (10个)，设置 `max_run_length: 2`。断言算法在有限回溯步数内安全终止，生成确定性降级序列，不抛出死循环异常，并正确标记非致命状态。

#### 7.3 输入与误触防御测试

1. **右键/非主键丢弃测试**：模拟发送 `pointerdown { button: 2 }`（右键）与 `pointerdown { button: 1 }`（中键），断言 Canvas 状态机未记录选择，未触发 visual feedback，且未改变当前 Trial 状态。
2. **按住跨试次（Pointer Sticky）拦截测试**：在 Trial 1 的刺激呈现期间触发 `pointerdown`，不触发 `pointerup`；跨越 ISI 进入 Trial 2，断言 Trial 2 不会自动拾取按压，必须在触发 `pointerup` 后下一次新的 `pointerdown` 方可生效。
3. **键盘重复忽略测试**：模拟按住按键触发连续的 `KeyboardEvent { repeat: true }`，断言仅第一个事件触发有效作答，后续被完全抑制。
4. **首答不可变性测试**：在单个刺激窗口内连续触发两次合法作答（如先点 Choice A，随后点 Choice B），断言输出记录中仅保留 Choice A，且总显示时长未发生任何偏移。

#### 7.4 协议兼容性与重放回归测试

1. **Schema v0/v1 回归重放测试**：读取历史已冻结的无 `stimulus_type`、无 `key`、无 `timing_defaults` 的旧版本 JSON 文本，输入到现有 `RunReplay` 中，断言其生成的执行树与历史记录事件完全匹配通过。
2. **视觉确认不影响时序测试**：模拟开启 Feedback（400ms 高亮）与关闭 Feedback，两者的生命周期总帧数（rAF 调用次数）完全相同。
