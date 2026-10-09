request_id: bpl-json-workflow-20261009-d
result_id: res_02e22088c47866d93d6c

### 1. 架构审查与关键边界评估

#### 1.1 离散坐标轴美化与状态管理

- **数值语义与显示解耦**：
  - 原生 HTML `<input type="range">` 仅处理物理拖拽，保持 `min`, `max`, `step=1`。
  - **未激活状态**：通过 CSS 类名控制视觉。未发生 input 交互前，Thumb 保持半透明/虚线或仅绘制 Track，`touched: false`。
  - **标签映射**：答案存储保持整数（如 `0..4`），UI 显示容器动态取 `labels[value]`。零仍为有效值，提交 payload 仅在 `touched === true` 时写入有效整型；若未交互则拦截“继续”按钮或视题型定义阻止提交。
- **物理触控与零滚动排版**：
  - 移动端屏幕（如 360–390px 宽）排不下 5 个完整长文本。**方案**：刻度轴仅标注端点和中间数字/小圆点，轴下方设置**单行动态反馈区**，选定后显示当前刻度文本；长标签禁止换行撑高，超出容器使用单行截断（`text-overflow: ellipsis`）。

#### 1.2 Questionnaire-v1 到 Study-v1 编译器与管理端

- **管理端最小闭环**：
  - 仅提供：上传/替换 JSON、软删除（`status: 'archived'`，数据表关联查询不可见但只读留存）、开放/隐藏切换（`status: 'published' | 'draft'`）、下载模板、客户端模拟预览。
  - **严格校验管线**：
    1. `JSON.parse` 基础语法检查。
    2. 基于 TypeScript/Zod 的 Schema 校验（`stripUnknown: false` / `.strict()`，**发现未知键立刻抛出 400 异常**）。
    3. 语义校验（验证 `default_page`、跳转逻辑是否成环、引用的 `package/path` 是否在资产表存在）。
- **版本不可变性 (Immutability)**：
  - 一旦有受试者生成 session 或存在 response 写入，该问卷定义哈希不可修改。管理端“替换”操作本质是创建新版本（`version + 1`），或必须显式归档旧版。

#### 1.3 Orientation Gate 与 iOS/软键盘防御

- **软键盘防误触关键**：
  - 唤起软键盘时，`window.visualViewport.height` 会骤降（例如 844px 降至 450px），但 `window.screen.orientation` 或 `window.matchMedia('(orientation: portrait)').matches` **不会改变**。
  - **稳定判定原则**：
    1. 首选 `screen.orientation.type`（如 `'portrait-primary'`）。
    2. 兼容兜底取物理比例：`window.screen.width <= window.screen.height` 判定为纵向。
    3. **禁止**使用 `window.visualViewport` 的长宽比判定屏幕旋转。
- **时序与资产阻断**：
  - 客户端进入只下载 `GET /api/study/:id/meta`（返回 `{ id, title, orientation, version }`）。
  - 仅当当前设备方向与 `orientation` 一致，才触发完整 session 创建、Canvas 计时运行器和图像资产拉取。
  - 若在 Canvas 任务进行中触发了真正的 `screen.orientation.change`，触发实验 Fail-safe：立即终止并上传已收集片段，打上 `abort_reason: "orientation_breach"`，保留时间语义。

#### 1.4 资产 ZIP 管道与无解码校验风险

- **ZIP 架构适用性**：完全可行且符合实验包一致性要求。
- **无服务端重编码的风险控制**：
  - **Zip-Slip 攻击**：检查所有 entry 名称，严禁 `..`，严禁以 `/` 开头，严禁非法字符，解压过程禁止跟随符号链接（Symlink）。
  - **Zip 炸弹**：限制压缩包大小 $\le 8\text{MiB}$，解压后总容量累计 $\le 32\text{MiB}$，条目数 $\le 100$。
  - **Magic Bytes 与标头解析**：
    - 不做全图转码，但必须检查前 16 字节 Magic Number（PNG: `89 50 4E 47`；JPEG: `FF D8 FF`；WEBP: `RIFF....WEBP`）。
    - 解析 IHDR/SOF0/VP8 块提取宽高（限制分辨率 $\le 4096\times 4096$），防止客户端 Canvas 解码内存耗尽（Pixel Bomb）。
    - 拒绝动图（检测 APNG 的 `acTL` 块或 Animated WEBP 的 flag）。
  - **确定性资产寻址**：
    - 计算每个文件的 SHA-256，以 `sha256(file_bytes)` 作为不可变物理名存储或做唯一索引。若 ZIP 中包含相同路径但 hash 不同的文件，直接驳回发布。

#### 1.5 环境元数据采集与 Formbricks 对标

- **Formbricks 官方设计参考**：
  - 在 [Formbricks 官方文档中（User Metadata）](https://formbricks.com/docs/surveys/general-features/metadata)，默认自动捕获的系统与环境上下文字段包括：`Browser`、`OS`、`Device`、`Country`（IP 推导）、`URL`、`Source` 等；底层数据模型将这些字段与会话隔离并提供只读审计能力。
- **本系统规范（零提示极限采集）**：
  - 在实验首屏（计时任务前）单次同步+限时异步采样，固化于 Outbox 并写入 SQLite，运行期绝对不在每帧采集。
  - **不采集**：不弹权限窗（不测 Geolocation、麦克风、陀螺仪高频权限），不读取含 PII 的 URL 参数，不进行 CPU 密集型的 WebGL 渲染指纹绘制（只读 `WEBGL_debug_renderer_info` 的 `UNMASKED_RENDERER_WEBGL` 字符串）。

### 2. 核心数据结构与 Schema

#### 2.1 极简模板 `questionnaire-v1.json`

```
{
  "$schema": "https://lab.local/schemas/questionnaire-v1.json",
  "version": "1.0.0",
  "title": "情绪与认知评估实验",
  "background": "#202020",
  "orientation": "portrait",
  "stimuli_package": {
    "package": "stimuli_v1.zip",
    "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "pages": [
    {
      "id": "scale_page_1",
      "type": "discrete_scale",
      "prompt": "我对当下的任务感到胸有成竹。",
      "scale": {
        "min": 0,
        "max": 4,
        "step": 1,
        "labels": ["非常不同意", "不同意", "一般", "同意", "非常同意"]
      }
    },
    {
      "id": "canvas_trial_1",
      "type": "timed_canvas",
      "duration_ms": 3000,
      "stimulus_image": "images/card_01.png"
    }
  ]
}
```

#### 2.2 环境协变量数据模型 `EnvironmentMetadata`

```
export interface EnvironmentMetadata {
  sampled_at_unix: number;

  // 1. 客户端设备与标识
  user_agent_raw: string;
  client_hints?: {
    mobile?: boolean;
    platform?: string;
    platform_version?: string;
    model?: string;
    architecture?: string;
  };
  inferred_os: string;
  inferred_browser: string;

  // 2. 显示与视口（首屏单次测量）
  screen: {
    width: number;
    height: number;
    avail_width: number;
    avail_height: number;
    color_depth: number;
    device_pixel_ratio: number;
  };
  layout_viewport: {
    width: number;
    height: number;
  };
  visual_viewport: {
    width: number;
    height: number;
    scale: number;
  };
  orientation_state: {
    type: string;
    angle: number;
  };

  // 3. 硬件能力与平台参数
  hardware: {
    concurrency?: number;
    device_memory_gb?: number;
    max_touch_points: number;
    platform: string;
    vendor: string;
  };

  // 4. 环境与系统偏好
  preferences: {
    prefers_color_scheme: 'light' | 'dark' | 'no-preference';
    reduced_motion: boolean;
    contrast: 'more' | 'less' | 'no-preference' | 'custom';
    pointer: 'fine' | 'coarse' | 'none';
    hover: 'hover' | 'none';
  };

  // 5. 语言、地域与网络
  locale: {
    timezone: string;
    timezone_offset_minutes: number;
    language: string;
    languages: readonly string[];
  };
  network?: {
    save_data?: boolean;
    downlink_mbps?: number;
    effective_type?: string;
    rtt_ms?: number;
  };

  // 6. 安全与执行沙箱
  security_context: {
    secure_context: boolean;
    cross_origin_isolated: boolean;
    cookie_enabled: boolean;
    do_not_track: string | null;
    global_privacy_control: boolean;
  };

  // 7. 只读硬件/图形标头（非侵入式探测）
  graphics?: {
    unmasked_vendor?: string;
    unmasked_renderer?: string;
  };

  // 8. 电池状态（50ms 快速探测，超时即跳过）
  battery?: {
    charging: boolean;
    level: number;
  };
}
```

### 3. 前端执行层关键实现

#### 3.1 坐标轴 UI 与状态解耦组件

```
interface ScaleProps {
  id: string;
  labels: string[];
  onChange: (val: number) => void;
}

export function renderDiscreteScale(container: HTMLElement, props: ScaleProps) {
  const min = 0;
  const max = props.labels.length - 1;
  let touched = false;

  container.innerHTML = `
    <div class="scale-widget" style="width: 100%; max-width: 480px; margin: 0 auto; user-select: none;">
      <input type="range" min="${min}" max="${max}" step="1" value="${min}"
             class="scale-range untouched"
             style="width: 100%; height: 36px; -webkit-tap-highlight-color: transparent;" />
      <div class="scale-ticks" style="display: flex; justify-content: space-between; padding: 0 4px; font-size: 12px; color: #888;">
        ${props.labels.map((_, i) => `<span>${i}</span>`).join('')}
      </div>
      <div class="scale-status" style="margin-top: 14px; text-align: center; height: 24px; font-size: 14px; color: #e5e5e5;">
        <span class="placeholder-text" style="color: #666;">请在轴上滑动或点击选项</span>
      </div>
    </div>
  `;

  const input = container.querySelector<HTMLInputElement>('.scale-range')!;
  const status = container.querySelector<HTMLElement>('.scale-status')!;

  const updateState = (val: number) => {
    if (!touched) {
      touched = true;
      input.classList.remove('untouched');
    }
    status.innerHTML = `已选：<strong>${props.labels[val]}</strong>`;
    props.onChange(val);
  };

  input.addEventListener('input', (e) => {
    updateState(Number((e.target as HTMLInputElement).value));
  });

  input.addEventListener('pointerdown', (e) => {
    // 适配 iOS 仅触控点击未滑动时不触发 input 事件
    const rect = input.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const discreteVal = Math.round(ratio * max);
    input.value = String(discreteVal);
    updateState(discreteVal);
  });
}
```

#### 3.2 稳健的 Orientation Gate 判定器

```
export function evaluateOrientation(): 'portrait' | 'landscape' {
  // 1. 首选标准化 Screen Orientation API
  if (window.screen?.orientation?.type) {
    return window.screen.orientation.type.startsWith('portrait') ? 'portrait' : 'landscape';
  }

  // 2. 匹配方向 Media Query（不受键盘唤起影响）
  if (window.matchMedia('(orientation: portrait)').matches) {
    return 'portrait';
  }
  if (window.matchMedia('(orientation: landscape)').matches) {
    return 'landscape';
  }

  // 3. 兜底比较物理 Screen 宽高（规避 visualViewport 键盘高度塌陷）
  return window.screen.width <= window.screen.height ? 'portrait' : 'landscape';
}

export function setupOrientationGate(
  targetOrientation: 'portrait' | 'landscape',
  onPassed: () => void,
  onBreached: () => void
) {
  let hasPassed = false;

  const check = () => {
    const current = evaluateOrientation();
    if (current === targetOrientation) {
      if (!hasPassed) {
        hasPassed = true;
        onPassed();
      }
    } else {
      if (hasPassed) {
        // 实验进行中违规旋转
        onBreached();
      } else {
        // 首屏方向不符合，维持遮罩提示
        showRotateGateUI(targetOrientation);
      }
    }
  };

  window.addEventListener('orientationchange', check);
  window.screen?.orientation?.addEventListener('change', check);
  check();
}

function showRotateGateUI(required: string) {
  const el = document.getElementById('orientation-gate-mask') || document.createElement('div');
  el.id = 'orientation-gate-mask';
  el.style.cssText = 'position:fixed;inset:0;background:#202020;color:#e5e5e5;z-index:99999;display:flex;align-items:center;justify-content:center;';
  el.innerText = `请将设备旋转至${required === 'portrait' ? '竖屏' : '横屏'}后继续`;
  if (!el.parentNode) document.body.appendChild(el);
}
```

### 4. 浏览器不确定性与局限声明

1. **Client Hints 异步可用性**：
  - `navigator.userAgentData.getHighEntropyValues()` 在非 Chromium 内核（如 iOS Safari、Firefox）中完全缺失，采样需提供 Promise 超时 fallback（设定 80ms 上限）。
2. **电池 API 弃用与权限**：
  - `navigator.getBattery` 在 Firefox 及多数新版移动浏览器已被彻底移除或废除，仅 Chromium 在部分系统支持。探测时必须置于 `try/catch` 并在 50ms 内超时返回 `null`。
3. **WebGL Renderer 伪装**：
  - 部分开启隐私保护的浏览器（如 Brave、Safari 隐私模式）会固定返回通用的 `WebKit WebGL` 或屏蔽 `WEBGL_debug_renderer_info` 扩展。该字段仅能作为弱特征，不可作为决定性硬件分群凭证。
4. **iOS 软键盘视口重叠**：
  - iOS Safari 唤起虚拟键盘时，虽不触发 orientation 变化，但会改变 `visualViewport.offsetTop`。必须锁死 `visualViewport` 并禁用整页弹性滑动（`overscroll-behavior: none`），仅允许需要输入的文字表单在其局部区域滚动。

JSON_WORKFLOW_REVIEW_COMPLETE
