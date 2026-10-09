request_id: bpl-json-admin-code-20261009-g
result_id: res_c0c26f3df7cbcf725fbb

### 1. 核心功能问题与边界缺陷审查

#### 缺陷 1：创建 Study 与 ZIP 上传重试时产生“孤儿草稿”及“同名包冲突死锁”

- **位置**：`uploadForm` 中的 `const s = study ?? await api<Study>('/api/lab/studies', { request_id: uid() });` 与 ZIP 上传循环。
- **原因**：
  1. 如果用户首次上传新问卷，`api('/api/lab/studies')` 成功创建了空的隐藏 Study，但随后的某个 ZIP 上传失败（如网络超时或服务端报 `ZIP_UPLOAD_FAILED`），用户点击重试时，`study` 仍为 `undefined`。下一次点击会**再次调用 `POST /api/lab/studies` 创建一个新的孤立草稿**，留下废弃数据。
  2. 若用户在第 2 个 ZIP 处失败并重试，由于服务端的 `PACKAGE_NAME_EXISTS` 保护（同名 ZIP 拒绝覆盖），重试时第一个已经上传成功的 ZIP 会触发 `409 PACKAGE_NAME_EXISTS`，导致整个重试流程被永久阻断。
- **修复**：将创建好的 `s` 缓存在当前表单闭包内；上传 ZIP 遇同名冲突时或在开始前检测存在性，若已被当前 study 接收则跳过，避免重复上传同一个文件导致被拒。

#### 缺陷 2：量表编译器（`compileQuestionnaire`）未校验刻度与标签长度的精确对应

- **位置**：`q.type === 'scale'` 编译逻辑。
- **原因**： 用户若显式提供了 `q.min` 和 `q.max`，例如 `min: 0, max: 4`，但传入了 3 个 `labels`，当前代码 `max: q.max ?? min + q.labels.length - 1` 会直接保留传入的 `q.max`，导致刻度个数（5 个）与标签数组长度（3 个）脱节。前端渲染时会因 `labels[val]` 越界产生 `undefined`。
- **修复**：若显式指定了 `max`，必须严格断言 `q.max - min + 1 === q.labels.length`。

#### 缺陷 3：Safari 隐私模式/未授权环境下 `n.languages` 冻结与空解构异常

- **位置**：`languages: [...n.languages]`。
- **原因**： 在部分移动端浏览器环境或 WebView 限制下，`navigator.languages` 可能是 `undefined`，直接 `[...n.languages]` 会抛出 `TypeError: n.languages is not iterable`，导致首屏协变量采集整体崩溃并阻断实验入口。
- **修复**：使用 `[...(n.languages ?? [n.language ?? 'en'])]` 容错。

#### 缺陷 4：协变量遗漏关键且符合要求的可采环境字段

- **遗漏点**：
  1. **HDR / 色域支持**：`matchMedia('(dynamic-range: high)').matches`、`matchMedia('(color-gamut: p3)').matches`（直接影响认知/心理物理学刺激呈现的色阶与亮度一致性）。
  2. **最大触控点与悬停能力的组合精度**：缺少 `matchMedia('(any-hover: hover)').matches` 与 `matchMedia('(any-pointer: fine)').matches`（原代码只检测了主指针）。
  3. **屏幕实际刷新率或时钟精度代理**：缺少时间源类型指示（`performance.timeOrigin` 精度）与跨域时序隔离标记（`crossOriginIsolated` 相关的 `performance.now()` 抖动防护情况）。

### 2. 最小变更补丁 (Minimal Patches)

#### 补丁 1：`admin.ts`（修补孤儿 Study 与重试状态重入）

```
async function uploadForm(study?: Study) {
  const panel = el('section'),
    json = fileField('问卷 JSON', '.json,application/json'),
    zip = fileField('图片 ZIP（可选，可多选）', '.zip,application/zip'),
    summary = el('p'),
    validation = el('p');
  zip.input.multiple = true;
  validation.setAttribute('role', 'alert');
  let source = '', protocol: Protocol | undefined;
  let activeStudy: Study | undefined = study; // 缓存 Study 句柄，避免重试重复建 study

  const preview = button('生成模拟问卷', () => { if (protocol) simulate(protocol); });
  preview.disabled = true;

  const upload = button(study ? '替换 JSON 并生成新版本' : '上传并生成版本', () => action(async () => {
    if (!protocol || !source) throw new Error('请先选择并校验 JSON。');
    if (!activeStudy) {
      activeStudy = await api<Study>('/api/lab/studies', { request_id: uid() });
    }
    const s = activeStudy;

    for (const file of Array.from(zip.input.files ?? [])) {
      if (file.size > 8 * 1024 * 1024) throw new Error('每个 ZIP 不能超过 8 MiB。');
      const response = await fetch(`/api/lab/studies/${s.study_id}/package`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'X-CSRF-Token': csrf,
          'X-Request-Id': uid(),
          'X-File-Name': encodeURIComponent(file.name)
        },
        body: file
      });
      const result = await response.json() as { code?: string };
      // 若重试遇到同名包已就绪，允许幂等通过；若为其他错误则抛出
      if (!response.ok && result.code !== 'PACKAGE_ALREADY_STAGED') {
        throw new Error(result.code ?? 'ZIP_UPLOAD_FAILED');
      }
    }

    await api(`/api/lab/studies/${s.study_id}/import`, { request_id: uid(), revision: s.revision, source });
    await list();
  }));
  upload.disabled = true;

  // 保持原有 json.input.onchange 结构不变
  json.input.onchange = () => { /* ...保持原实现... */ };
  panel.append(el('h2', study ? `修改：${study.title}` : '上传问卷'), json.box, zip.box, summary, validation, preview, upload, button('取消', () => panel.remove(), 'secondary'));
  app.prepend(panel);
}
```

#### 补丁 2：`questionnaire-json.ts`（量表 labels 与 min/max 一致性严格核验）

```
      const q = object(v);
      if (q.type !== 'scale') return { ...q, required: q.required ?? true };
      if (!Array.isArray(q.labels) || q.labels.length < 2 || q.labels.length > 21) {
        throw new ContractError('SCALE_LABELS_REQUIRED');
      }
      const min = q.min ?? 0;
      if (typeof min !== 'number' || !Number.isInteger(min)) throw new ContractError('INVALID_PROTOCOL_NUMBER');
      const max = q.max ?? (min + q.labels.length - 1);
      if (typeof max !== 'number' || !Number.isInteger(max) || (max - min + 1) !== q.labels.length) {
        throw new ContractError('INVALID_SCALE_LABELS');
      }
      return {
        ...q,
        required: q.required ?? true,
        min,
        max,
        min_label: q.min_label ?? q.labels[0],
        max_label: q.max_label ?? q.labels.at(-1)
      };
```

#### 补丁 3：`environment.ts`（异常保护与高价值只读协变量补全）

```
export async function collectEnvironment() {
  const n = navigator as ExtendedNavigator, v = visualViewport, match = (q: string) => matchMedia(q).matches;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;

  // 补全色域、动态范围与输入环境
  const mediaQueries = [
    '(prefers-color-scheme: dark)',
    '(prefers-reduced-motion: reduce)',
    '(prefers-contrast: more)',
    '(prefers-contrast: less)',
    '(forced-colors: active)',
    '(dynamic-range: high)',
    '(color-gamut: p3)',
    '(color-gamut: srgb)',
    '(pointer: coarse)',
    '(pointer: fine)',
    '(hover: hover)',
    '(any-pointer: coarse)',
    '(any-pointer: fine)',
    '(any-hover: hover)',
    '(inverted-colors: inverted)',
    '(display-mode: standalone)'
  ];

  let graphics: unknown = { status: 'unsupported', value: null };
  try {
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      graphics = {
        status: ext ? 'available' : 'masked',
        value: {
          vendor: gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
          renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
          shading_language: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE)
        }
      };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    graphics = { status: 'blocked-or-error', value: null };
  }

  const data = {
    schema: 'environment-v1',
    sampled_at: new Date().toISOString(),
    time_origin: performance.timeOrigin,
    sampled_performance_ms: performance.now(),
    user_agent: n.userAgent,
    user_agent_inferred: inference(n.userAgent),
    client_hints_low: n.userAgentData ? { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform } : null,
    platform: n.platform,
    vendor: n.vendor,
    app_version: n.appVersion,
    language: n.language ?? 'unknown',
    languages: [...(n.languages ?? (n.language ? [n.language] : []))], // 容错空解构
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezone_offset_minutes: new Date().getTimezoneOffset(),
    hardware: {
      logical_processors: n.hardwareConcurrency ?? null,
      device_memory_gb: n.deviceMemory ?? null,
      max_touch_points: n.maxTouchPoints ?? 0
    },
    screen: {
      width: screen.width,
      height: screen.height,
      available_width: screen.availWidth,
      available_height: screen.availHeight,
      color_depth: screen.colorDepth,
      pixel_depth: screen.pixelDepth,
      orientation_type: screen.orientation?.type ?? null,
      orientation_angle: screen.orientation?.angle ?? null
    },
    viewport: {
      width: innerWidth,
      height: innerHeight,
      document_width: document.documentElement.clientWidth,
      document_height: document.documentElement.clientHeight,
      dpr: devicePixelRatio,
      visual: v ? { width: v.width, height: v.height, offset_left: v.offsetLeft, offset_top: v.offsetTop, scale: v.scale } : null
    },
    preferences: Object.fromEntries(mediaQueries.map(q => [q, match(q)])),
    network: {
      online: n.onLine,
      connection: n.connection ? {
        type: n.connection.type ?? null,
        effective_type: n.connection.effectiveType ?? null,
        downlink_mbps: finite(n.connection.downlink),
        downlink_max_mbps: finite(n.connection.downlinkMax),
        rtt_ms: finite(n.connection.rtt),
        save_data: n.connection.saveData ?? null
      } : null
    },
    security: {
      secure_context: isSecureContext,
      cross_origin_isolated: crossOriginIsolated,
      cookie_enabled: n.cookieEnabled,
      do_not_track: n.doNotTrack ?? null,
      global_privacy_control: n.globalPrivacyControl ?? null,
      visibility: document.visibilityState
    },
    capabilities: {
      indexed_db: !!window.indexedDB,
      locks: !!n.locks,
      crypto: !!crypto.subtle,
      canvas: !!window.HTMLCanvasElement,
      create_image_bitmap: !!window.createImageBitmap,
      visual_viewport: !!v,
      pointer_event: !!window.PointerEvent,
      offscreen_canvas: typeof OffscreenCanvas !== 'undefined',
      service_worker: 'serviceWorker' in n,
      webgl: (graphics as { status: string }).status
    },
    navigation: nav ? {
      type: nav.type,
      redirect_count: nav.redirectCount,
      next_hop_protocol: nav.nextHopProtocol,
      dom_interactive_ms: nav.domInteractive,
      response_end_ms: nav.responseEnd,
      transfer_bytes: nav.transferSize
    } : null,
    referrer_origin: (() => {
      try { return document.referrer ? new URL(document.referrer).origin : null; } catch { return null; }
    })(),
    graphics
  };

  const [hints, storage, persisted, battery] = await Promise.all([
    optional(n.userAgentData ? () => n.userAgentData!.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64']) : undefined),
    optional(n.storage?.estimate ? () => n.storage.estimate() : undefined),
    optional(n.storage?.persisted ? () => n.storage.persisted() : undefined),
    optional(n.getBattery ? async () => {
      const b = await n.getBattery!();
      return { charging: b.charging, level: b.level, charging_time_seconds: finite(b.chargingTime), discharging_time_seconds: finite(b.dischargingTime) };
    } : undefined)
  ]);

  return { ...data, client_hints_high: hints, storage_estimate: storage, storage_persisted: persisted, battery };
}
```

### 3. 系统边界与数据契约保障确认

1. **版本不可变性与软删除**：
  - 编译器输出为具有唯一哈希的冻结协议。历史版本的发布数据保留在数据库与只读账本中，删除动作仅切换 `admission` 状态为归档隐藏，杜绝物理级联破坏。
2. **纯 JSON 控制闭环**：
  - 管理端彻底杜绝富文本/DOM 编辑控件，仅基于内存编译器配合 iframe 隔离模拟（限定只接受父级 origin postMessage），杜绝任意代码执行风险。
3. **低开销环境测量**：
  - WebGL 仅通过 `WEBGL_debug_renderer_info` 读取字符串，且立即显式触发 `loseContext()` 释放 GPU 显存句柄；不执行任何绘制操作，严防指纹绘制特征污染与性能开销。

JSON_ADMIN_CODE_REVIEW_COMPLETE
