方案整体精简且符合单管理员/自托管实验系统的演进目标。审查出的关键修正、迁移风险与交互细节如下：

### 1. 数据库迁移与安全边界修正

- **迁移幂等性与旧表替换时序**：
  - 重启可重复执行时，不能简单 `ALTER TABLE DROP COLUMN`（兼容旧版 SQLite 及潜在锁冲突）。推荐标准表重建法，且必须在单一独占事务中包裹：`-- 仅当旧表仍存在 role 列时迁移
CREATE TABLE IF NOT EXISTS lab_admin_tokens_new (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO lab_admin_tokens_new (token_hash, csrf, expires_at)
  SELECT token_hash, csrf, expires_at FROM lab_admin_tokens WHERE expires_at > unixepoch();
DROP TABLE lab_admin_tokens;
ALTER TABLE lab_admin_tokens_new RENAME TO lab_admin_tokens;`
  - **必须清理过期 Token**：迁移时顺带过滤 `expires_at > unixepoch()`，避免遗留历史已失效凭证。
- **单 Writer 与屏障互斥**：
  - 虽然去掉了角色检查，但**后台长任务（备份、Replay/Rebuild、包解包）与参与者写入的独占屏障（Busy/Pause Barrier）必须保持不变**。原先路由中间件中的 `requireRole('maintainer')` 应统一替换为单管理员鉴权中间件 `requireAdmin`，原各底层的状态机约束（如 `idle_required`、写入锁）完全保留。
- **速率限制与防爆破隔离**：
  - 仅剩单个密码后，防爆破（Brute-force throttle）的桶键（Bucket Key）不能按 `username` 划分。必须基于 `client_ip`（及同源请求指纹）做指数退避或固定窗口锁定（例如 15 分钟内连续失败 5 次封禁 IP 15 分钟），防止单管理员被脱机字典快速撞库。

### 2. 交互细节与前端改造

- **键盘与无障碍提交**：
  - 密码框外层必须使用原生 `<form>` 标签包裹并监听 `submit` 事件（`e.preventDefault()`），以原生方式保障移动端虚拟键盘的“前往/完成 (Go/Done)”与桌面端 `Enter` 键均可平滑触发提交，避免仅在 `input` 上监听 `keydown` 产生的输入法冲突。
  - 移除 `role` 下拉框后，保留 `autocomplete="current-password"` 与 `autofocus`。
- **`/api/auth/me` 契约简化**：
  - 原接口若返回 `{ role: 'researcher' | 'maintainer', csrf }`，需改为返回 `{ authenticated: true, csrf }`，管理端前端移除所有依赖 `role` 的条件渲染分支，保持问卷列表、上传、发布等界面行为对单管理员完全一致。
- **自动脚本与 CLI 统一**：
  - `auth:setup` 仅生成单个 `ADMIN_PASSWORD_HASH`（写入环境变量或配置文件）。
  - 既有端到端测试（E2E）或本地预览脚本若有 hardcode `role: 'researcher'` 的 Payload，需同步剔除该字段，避免在严格 JSON Schema 校验下直接被服务端抛出 400（严禁未知字段）。

ADMIN_PASSWORD_REVIEW_COMPLETE
