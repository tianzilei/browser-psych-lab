# 知情同意与手机局域网测试讨论

- request_id: bpl-consent-lan-20261009
- conversation: https://gemini.google.com/app/71c7ead686e53505
- saved_result: res_1e82258091c189428c1e
- Transport timeout 后读取当前对话；对应 user prompt 与完成标记匹配，turn 13 未停止且不再生成，completeness=complete。

## User

继续优化当前浏览器心理问卷平台。新增 JSON 配置 consent:{title,text} 知情同意页，灰/深纯色，必须竖/横方向符合后显示；长文按钮翻段无横纵滚动，末段明确“我已阅读并同意”或“不同意并退出”。同意前不创建参与会话，不采集浏览器协变量；服务器校验固定版本同意文档 hash 并记录 server accepted_at，CSV 导出 consent 记录。旧冻结问卷没有 consent 时保持历史 hash 和兼容。请审查交互及数据方案，不撰写正式伦理文书。  此外用户要求本机 0.0.0.0 局域网手机浏览测试；现有代码依赖 crypto.subtle/randomUUID/navigator.locks，LAN HTTP 非 secureContext 不可用。我打算测试服务器绑定0.0.0.0并使用本地自签 HTTPS（SAN含192.168.0.2/127.0.0.1/localhost），提供 HTTP 同端或另一端口跳转 HTTPS，私有证书仅.local。不加入弱化的加密/互斥 fallback。请给出可行的最简手机测试流程、证书提示限制以及设计改进。不要改变正式实验的单写入和原始事件 hash 协议。结尾标记 CONSENT_LAN_REVIEW_COMPLETE。

## Gemini

### 1. 知情同意页 (`consent`) 交互与数据契约审查

- **状态机流转与时序栅栏**：
  - **时序严格定序**：
    1. 请求轻量元数据 `GET /api/participate/versions/:version/metadata`（包含 `orientation`、`background`、`consent_hash`）。
    2. 进入 `Orientation Gate`，屏幕方向校准通过。
    3. 挂载 `Consent` 流程（若配置存在）。
    4. 受试者点击“我已阅读并同意”。
    5. **此时才触发**：环境协变量采样 (`collectEnvironment`) $\rightarrow$ 创建会话 (`POST /api/participate/sessions`) $\rightarrow$ 下载实验图片包。
  - **未授权零泄露原则**：
    - 同意前**严禁调用 `collectEnvironment`**，**严禁向 SQLite 写入任何 Ledger 记录**，**严禁在服务器持久化任何 Session 记录**。
    - 受试者若点击“不同意并退出”，直接清空当前 DOM，呈现终结文字（“您已退出实验，可直接关闭此页面”），不发送任何网络退出请求，不留存孤立未完成数据。
- **长文分段与零双向滚动物理交互**：
  - 采用与 `ending` 相同的分段翻页模型。按段落切分页面：
    - 第 $1 \sim (N-1)$ 段底部仅提供“下一页”纯按钮。
    - 最终第 $N$ 段展示两个明确按钮：“我已阅读并同意”（主操作）与“不同意并退出”（次级操作）。
  - 样式与主题：继承 `layout.background`（`#e5e5e5` 或 `#202020`），视口锁死，字号与行距固定，空间溢出时由分段引擎提前分页，杜绝任何纵向/横向滚动条。
- **版本冻结哈希与兼容性**：
  - **哈希计算**：将 `consent: { title, text }` 纳入 `protocol` 的不可变哈希计算（`stableJSON(consent)` 计入版本根哈希）。
  - **旧版本兼容**：若旧版本 `consent` 为 `undefined` 或 `null`，编译出的 `consent_hash` 记为 `null`；客户端跳过同意页流程，直接沿用原有启动时序（方向校准 $\rightarrow$ 采集 $\rightarrow$ 创建 Session），历史协议哈希完全不被破坏。
- **服务端凭证记录与导出规范**：
  - `POST /api/participate/sessions` 请求体增加字段：`{ consent_hash: string | null }`。
  - 服务端严格校验客户端提交的 `consent_hash` 与该版本数据库固化的哈希一致，校验失败直接返回 `400 CONSENT_HASH_MISMATCH` 并拒绝创建。
  - 服务端入库记录 `server_accepted_at`（纳秒或毫秒 Unix 时间戳）。
  - **CSV 导出列**：在 `manifest.json` 与主导出表追加 `consent_hash` 和 `consent_accepted_at`。旧版或无 consent 的数据统一输出为空字符串 `""`，不得填充虚假时间戳。

### 2. 局域网（LAN）移动端 HTTPS 测试架构与证书限制

由于系统深度依赖 `isSecureContext`（包含 `crypto.subtle`、`crypto.randomUUID`、`navigator.locks`），且严禁为开发环境引入不安全的假实现/降级 Fallback，必须建立可行的本地 TLS 信任链。

#### 2.1 浏览器与移动端证书硬性限制

- **纯 IP SAN 的信任阻断**：
  - iOS Safari 与现代 Android Chrome 对仅包含 IP（如 `192.168.0.2`）的自签证书极为苛刻，甚至直接隐藏“继续访问”入口，或拒绝为未受信任的自签证书激活 `navigator.locks` / Web Crypto 完整能力。
- **CA 链依赖**：
  - 浏览器不接受直接把叶子证书当根证书信任。**必须建立两级结构：本地私有根 CA（Local Root CA）+ 签发的叶子证书（Leaf Certificate）**。

#### 2.2 最简本地测试测试流程（推荐 `mkcert` 方案）

不引入生产复杂依赖，本地开发机使用静态生成方案：

1. **生成私有 CA 与通配/多 SAN 证书**： 在开发机生成包含当前局域网 IP 与本地域名的证书（例如使用 `mkcert`）：`# 生成支持本机所有测试入口的证书
mkcert -install
mkcert 127.0.0.1 localhost 192.168.0.2 psych-lab.local
# 产出：cert.pem, key.pem 以及根证书 rootCA.pem`
2. **手机端安装并完全信任 Root CA**（只需一次）：
  - **iOS**：将 `rootCA.pem` 通过隔空投送（AirDrop）或本地简易文件服务下载到手机 $\rightarrow$ 设置中安装描述文件 $\rightarrow$ 进入 `设置 -> 通用 -> 关于本机 -> 证书信任设置`，**勾选开启对该根证书的完全信任**。
  - **Android**：下载 `rootCA.pem` $\rightarrow$ `设置 -> 安全 -> 从存储设备安装证书 -> CA 证书` 安装即可。
3. **服务端口与重定向编排**：
  - 服务端绑定 `0.0.0.0`：
    - `8443`（或 `443`）：挂载生成的 `key.pem` 与 `cert.pem` 启动 TLS 服务。
    - `8080`（或 `80`）：轻量 HTTP 服务，拦截所有请求直接返回 `301/302` 重定向至 `https://<LAN-IP>:8443...`。
  - 参与者手机连接同一 Wi-Fi 后，直接扫码或访问 `[https://192.168.0.2:8443/participate.html?version=](https://192.168.0.2:8443/participate.html?version=)...`，浏览器直接显示安全小锁，标准 Web Crypto 与 Locks API 正常工作，完全维持测试与生产环境一致的底层语义。

CONSENT_LAN_REVIEW_COMPLETE
