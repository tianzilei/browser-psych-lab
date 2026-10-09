# Browser Psych Lab

自托管的浏览器心理实验问卷平台，面向移动端普通问卷与固定图片选择任务，支持预加载、软件时序记录、可靠采集和有界动态补测。

当前状态：P0–P6 首版代码及本机软件流程已落实，包含研究管理、有限问卷/分支、图片门控、Canvas、动态补测、可靠采集、CSV、备份恢复和运维入口。正式 gate 默认关闭；目标服务器、真实设备和独立恢复仍需外部环境验收。

## 设计文档

- [P1–P6 实施与验收](docs/P1-P6实施与验收.md)：已落实功能、测试、预算和外部验收边界。
- [部署与恢复手册](docs/部署与恢复手册.md)：HTTPS/systemd 模板、备份 timer、完整恢复及正式准入。
- [会话排队与小规格部署](docs/会话排队与小规格部署.md)：全局同时 1–2 例、FIFO 等待、名额回收与 1c2g 试运行配置。
- [阿里云 1Mbps 部署与验证](docs/阿里云1Mbps部署与验证.md)：单图片流、旧冻结版本兼容与带宽测量边界。
- [全阶段进度](docs/实施进度.md)：代码完成与环境验收分开记录。
- [P0 实施与验收](docs/P0实施与验收.md)：可运行入口、代码与合同、故障测试、实施边界及剩余阶段。
- [轻量化架构与并发稳定性决策](docs/轻量化架构与并发稳定性决策.md)：13 个模块取舍、目标架构、已实施减负、替换条件及容量验收；运行架构以此修订优先。
- [问卷前端轻量化与纯色设计](docs/问卷前端轻量化与纯色设计.md)：固定视口、逐题按钮、李克特坐标轴、所有选项同屏、仅个人信息允许输入、灰色/深色冻结背景、Gemini 三轮讨论及构建体积对比。
- [完整自托管设计与实施契约](docs/浏览器心理实验问卷平台_完整自托管设计.md)：架构、编辑器、运行器、存储、数据合同及验收；第 18 节为实施契约。
- [SQLite 实施修订](docs/SQLite实施修订.md)：覆盖原设计的 PostgreSQL 专属实现，规定写事务、导出视图及联合备份路径。
- [开发环境与依赖](docs/开发环境与依赖.md)：初始化、运行、检查与依赖锁定。
- [参考代码入口](references/README.md)：本地源码、固定提交与许可证边界。
- [Gemini 六轮设计收敛记录](docs/设计收敛_多轮审查记录.md)：问题处理、审查取舍、结果追踪及采集准入事项。
- [Gemini 优化讨论原文](docs/gemini轻量化讨论/README.md)：架构与阿里云优化的完整输入／回复、采用与否决边界和测量原件。

## 技术基线

TypeScript 单仓库、Node.js 24/Fastify 单应用、SQLite（WAL＋FULL）、三个私有逻辑存储区。数据库由单 worker 处理，HTTP 接收与 RPC 队列均有界；单独的维护 worker 执行重放、导出、备份和派生重建。正式问卷采用固定视口、原生按钮和独立纯色样式，仅个人信息题可使用文字输入，SurveyJS 仅供检查页显式加载；检查页与 P0 可靠问卷分入口，公共构建文件预压缩；原始事件／发件箱／提交意图使用一个 IndexedDB 事务。

服务端生产直接依赖为 Fastify、@fastify/static 和 better-sqlite3；图片包只解包与标头校验，不做图像解码或转码，sharp 仅作为开发测试工具。SurveyJS/idb 在构建时安装并进入浏览器产物。保留现有库，无需增加 ORM、Redis 或集群。

用户指定阿里云 Ubuntu 26.04、系统盘 2120 IOPS / 106.0 MB/s、1Mbps 公网带宽，最初为 2c4g，正在评估 1c2g。最新需求为整个参加者会话同时 1–2 例：`SESSION_CONCURRENCY=2` 默认双例，设为 1 使用单例；其余进入持久 FIFO 等待，最多 64 个有效条目。图片另设 `PREPARATION_CONCURRENCY=1` 保持单图片流，下载和解码串行，组内停止全部轮询。目标主机及微信等内置浏览器支持仍需实测。

## 实施入口

```sh
nvm use
npm run auth:setup
npm run dev
```

管理端仅输入密码登录，不区分研究者／维护者；`auth:setup` 只配置 `ADMIN_PASSWORD_HASH`。本地模拟管理端的固定密码见下方预览说明。

管理主页：`http://127.0.0.1:5173/`；开发检查页：`http://127.0.0.1:5173/diagnostics.html`（登录后访问）；可靠保存测试：`http://127.0.0.1:5173/p0.html`。首次在其他机器使用时，按[开发环境说明](docs/开发环境与依赖.md)安装与初始化。`npm run doctor` 检查环境与源码，`npm run check` 执行类型、构建、数据库、单元／故障及浏览器验证。

本机 1/5/10/20 个会话集中到达、最多双例活动的混合采集测量见[双例报告](docs/混合采集本机测量.json)，单例配置见[单例报告](docs/单例排队本机测量.json)。`npm run profile:mixed -- 报告路径.json` 可重跑，命令前设置 `SESSION_CONCURRENCY=1` 可验证单例。部署、独立备份目标和真实手机请按运维手册验收；未填写真实证据不能开放正式研究。

`npm run profile:bandwidth -- 报告路径.json` 可重跑 [1Mbps 排队测量](docs/1Mbps排队本机测量.json)：20 个会话先排整例队列，再按 FIFO 下载并核对原图，累计响应正文限速 125000 B/s。下载后 TEST_ONLY 终止释放名额；总等待仍由图片大小和共享带宽决定，测量不包含 TLS、实际 ECS 网络与真实设备。

首版仅报告软件时序；正式采集前须完成设备、容量和独立备份恢复验收。

## 本地模拟问卷

```sh
npm run build
npm run preview:questionnaire
```

打开 `http://127.0.0.1:3081/questionnaire-preview.html` 选择灰色或深色背景。两份 TEST_ONLY 问卷包含知情同意、预设两端文字的单／多李克特坐标轴、单选、多选、可选个人信息分支、结束语，以及可选择继续查看的长说明、8 个同屏选项和完整选项换行。

本地管理主页：`http://127.0.0.1:3081/`，密码 `TEST_ONLY-local-preview`，无需选择角色。

预览只监听本机，数据库及存储独立保存在 `.local/questionnaire-preview`，不使用既有研究数据或修改 `.env`。每次启动创建新的问卷版本，可重新体验；链接和进程号写入该目录的 `links.json`。Ctrl+C 停止，端口可用 `QUESTIONNAIRE_PREVIEW_PORT` 指定。

管理端已改为 JSON 文件上传／替换、校验、模拟、开放／隐藏及软删除。量表每个刻度对应预设文本；方向通过后进入，图片用 ZIP 名称和内部路径引用，首屏环境协变量独立持久保存。模板、图片样例、元数据字段及兼容规则见 [JSON 问卷与图片包](docs/JSON问卷与图片包.md)。


手机局域网测试使用 `npm run preview:questionnaire -- --lan`。HTTP 默认在 `0.0.0.0:3081`，HTTPS 在 `0.0.0.0:3082`；终端及 `.local/questionnaire-preview/links.json` 显示当前局域网地址。手机与电脑须连接同一 Wi-Fi。首次打开 `http://<局域网IP>:3081/phone-setup`，下载并信任本机测试 CA，然后进入 `https://<局域网IP>:3082/questionnaire-preview.html`。其他 HTTP 路径自动跳转 HTTPS，保留问卷路径与 version。HTTPS 主页 `/` 仍是管理登录，受试者只收到问卷链接。

LAN 模式使用 OpenSSL 生成独立的本地 CA 与含 LAN IP/localhost/127.0.0.1 的服务证书，保存在 `.local/questionnaire-preview/tls`；私钥不会公开，不自动改变系统信任设置。根证书沿用，服务证书每次启动重新签发。iOS 安装描述文件后还需在“通用 → 关于本机 → 证书信任设置”开启完全信任；Android 在系统“安装证书”中选择 CA 证书。浏览器仍使用真实 Web Crypto、UUID 与 Web Locks，不以测试模式替换这些接口。可用 `QUESTIONNAIRE_PREVIEW_IP` 指定本机局域网接口地址，`QUESTIONNAIRE_PREVIEW_TLS_PORT` 指定 HTTPS 端口。

JSON 顶层 `consent: {"title":"知情同意书","text":"研究者编写的完整说明"}` 配置同意页；模板仅包含模拟测试说明。方向符合后显示，长文优先保留整段并用按钮翻段，最后一段才启用同意。拒绝不创建作答会话、不采集设备协变量；同意后保存文档哈希与服务器接受时间，下载数据包含 `consents` 表。已有冻结版本保持原文与哈希；修改同意书须上传 JSON 生成新版本。
