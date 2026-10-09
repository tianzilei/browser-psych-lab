request_id: bpl-json-orientation-code-20261009-e
result_id: res_d2c1ddf8cfa95e1720aa

### 1. 核心功能缺陷与边界漏洞分析

#### 缺陷 1：`initialize` 缺少错误捕获导致 `gate` 永久死锁（拒绝 Retry）

- **位置**：`orientation-gate.ts` 中的 `let gate: Promise<void> | undefined; export function requireOrientation(version:string) { return gate ??= initialize(version); }`
- **问题**：如果网络闪断或服务端接口瞬时失败，`initialize` 返回的 rejected Promise 会被永久缓存在 `gate`。用户重试点击或重新调用 `requireOrientation` 时，始终拿到旧的 rejected 实例，无法重试请求。
- **修复**：在失败分支清理缓存：`.catch(err => { gate = undefined; throw err; })`。

#### 缺陷 2：`currentOrientation` 方向判断被键盘收起及尺寸重排污染

- **位置**：`currentOrientation`
- **问题**：
  1. `lastWidth` 仅在非输入状态更新。当输入法弹起导致 `width` 微变或未更新时，若用户在输入中旋转设备，`lastWidth` 保持旧值；键盘收起失去焦点后，下一次读取因条件不匹配可能误用陈旧的 `last`。
  2. 桌面端/iPad 侧分屏或正方形视口（`width === height`）时，`width > height` 会无脑判定为 `portrait`，且未优先读取系统级不可变方向。
- **修复**：优先使用标准 `screen.orientation?.type`（或 matchMedia 查询），不受软键盘挤压高度影响；仅在缺失时兜底使用视口宽高比。

#### 缺陷 3：`initialize` 中的 EventListener 内存泄漏与多次 resolve 违规

- **位置**：`orientation-gate.ts` 内的 `new Promise<void>(resolve => { ... })`
- **问题**：
  1. `check()` 在满足条件后调用了 `resolve()`，但**没有移除** `window` 和 `screen.orientation` 的 `change` / `resize` 监听器，随着页面生命周期会持续执行无用回调，甚至在用户后续旋转时反复操作 DOM（操作可能已卸载的 `overlay` 和 `main`）。
  2. 只有 `pagehide` 才会清理监听器，但 SPA 单页流转中 `pagehide` 不会触发。
- **修复**：在满足 `valid` 触发 `resolve()` 时，立即移除相关监听器。

#### 缺陷 4：`ParticipantAPI.open` 错误时序：未通过方向检查即采集成环境协变量

- **位置**：`ParticipantAPI.open`
- **问题**：代码执行顺序为：`const orientation = requireOrientation(version), ledger = await Ledger.open(version, writer), m = await ledger.state();
if(!m.environment) { ... await ledger.environment(...); }
await orientation;`需求严格限定：**“方向符合后才 createSession/下载图片”**。当前代码在 `await orientation` **之前** 就调用了 `collectEnvironment()` 并写入 ledger。此时设备可能仍处于错误方向，采得的 `screen`/`viewport`/`orientation` 协变量均为未校准的错误方向数据。
- **修复**：将 `await orientation` 提升到 `collectEnvironment` 之前。

#### 缺陷 5：模拟器 `resize` 监听判定条件导致方向切换失效

- **位置**：模拟器中的 `window.addEventListener('resize', () => { if (p && !document.querySelector('.questionnaire')) render(); });`
- **问题**：当问卷渲染后（`mountPage` 挂载了问卷），如果用户在模拟模式下旋转屏幕，因 DOM 存在对应结构，条件判断 `!document.querySelector(...)` 导致 `render()` 不被触发，无法展示“请将设备调整为横/竖屏”的阻断提示。同时缺少 `orientationchange` 监听。
- **修复**：统一监听并在方向改变时必定重新求值阻断逻辑。

### 2. 最小变更补丁 (Minimal Patches)

#### 补丁 1：`orientation-gate.ts`

```
import {request, el} from './dom.js';
import {applyParticipantBackground} from './participant-theme.js';

type Orientation = 'portrait' | 'landscape';

export function currentOrientation(): Orientation {
  // 1. 优先使用不受软键盘高度压缩影响的 Screen Orientation API
  const screenType = window.screen?.orientation?.type;
  if (screenType) {
    return screenType.startsWith('landscape') ? 'landscape' : 'portrait';
  }
  // 2. 媒体查询检测
  if (window.matchMedia?.('(orientation: landscape)').matches) return 'landscape';
  if (window.matchMedia?.('(orientation: portrait)').matches) return 'portrait';
  // 3. 兜底比较视口物理宽高
  const w = document.documentElement.clientWidth || window.innerWidth;
  const h = document.documentElement.clientHeight || window.innerHeight;
  return w > h ? 'landscape' : 'portrait';
}

let gate: Promise<void> | undefined;

export function requireOrientation(version: string): Promise<void> {
  if (!gate) {
    gate = initialize(version).catch(err => {
      gate = undefined; // 允许元数据获取失败后重试
      throw err;
    });
  }
  return gate;
}

async function initialize(version: string): Promise<void> {
  const meta = await request<{title: string; background: string; orientation: Orientation | null}>(
    `/api/participate/versions/${version}/metadata`
  );
  applyParticipantBackground(meta.background);
  if (!meta.orientation) return; // 历史无 orientation 版本兼容

  const overlay = el('div', undefined, 'orientation-gate');
  overlay.id = 'orientation-gate';
  overlay.setAttribute('role', 'alert');
  const icon = el('div', undefined, 'orientation-device');
  icon.dataset.orientation = meta.orientation;
  icon.setAttribute('aria-hidden', 'true');
  overlay.append(
    icon,
    el('p', meta.orientation === 'portrait' ? '请将设备调整为竖屏' : '请将设备调整为横屏'),
    el('span', '方向正确后自动继续')
  );
  document.body.append(overlay);
  const main = document.querySelector('main');

  await new Promise<void>(resolve => {
    const cleanup = () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
      screen.orientation?.removeEventListener('change', check);
    };

    const check = () => {
      const valid = currentOrientation() === meta.orientation;
      overlay.hidden = valid;
      if (main) main.inert = !valid;
      if (valid) {
        cleanup();
        resolve();
      }
    };

    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    screen.orientation?.addEventListener('change', check);
    window.addEventListener('pagehide', cleanup, {once: true});
    check();
  });
}
```

#### 补丁 2：`participant-api.ts`

```
  static async open(version: string, writer: string) {
    // 1. 优先方向门禁判定，未通过前阻断所有会话创建与环境测量
    await requireOrientation(version);

    const ledger = await Ledger.open(version, writer);
    const m = await ledger.state();

    // 2. 方向合格后，再执行一次性环境协变量采集
    if (!m.environment) {
      const {collectEnvironment} = await import('./environment.js');
      await ledger.environment(JSON.stringify(await collectEnvironment()));
    }

    // 3. 创建真实会话
    const initial = await request<LabSession>('/api/participate/sessions', {
      request_id: m.request_id,
      version_id: version,
      credential: m.credential
    });
    const api = new ParticipantAPI(ledger, initial);
    await api.refresh();
    return api;
  }
```

#### 补丁 3：`simulation-runner.ts`

```
// 统一监听视口及方向变动，移除妨碍方向提示呈现的 !document.querySelector('.questionnaire')
const recheck = () => {
  if (p) render();
};
window.addEventListener('resize', recheck);
window.addEventListener('orientationchange', recheck);
screen.orientation?.addEventListener('change', recheck);
```

### 3. 数据隔离与安全审计确认

1. **环境与答案双 Outbox 物理隔离**：
  - `sync()` 中 `environment` 独立投递至 `POST /covariates` 并完成 SHA-256 哈希回执防篡改校验。
  - 业务事件流独立打批次投递至 `POST /ingest`，通过 `acknowledge(receipts)` 推进各自分组游标，符合审计溯源要求。
2. **模拟沙箱隔离**：
  - `message` 严格校验 `event.origin === location.origin` 与 `event.source === parent`，仅解析 protocol 与本地渲染，无任何 `Ledger.open` 或 `POST /sessions` 调用，完全隔离生产数据。
3. **Canvas 任务 Fail-safe**：
  - 现有架构在 Canvas 运行期发生真正的 `resize` 时将直接触发中断，不变更原有实验时间语义。

JSON_ORIENTATION_CODE_REVIEW_COMPLETE
