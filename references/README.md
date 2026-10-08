# 参考代码入口

核对日期：2026-10-08（Asia/Shanghai）。源码位于 `references/checkouts/`，该目录已加入 `.gitignore`。提交、许可证文件和 SHA-256 摘要保存在 [manifest.lock.json](manifest.lock.json)，许可证原文副本保存在 `licenses/`。`npm run references:fetch` 可重建源码；有本地修改或不同提交时会拒绝覆盖。

已独立下载并核对下表源码身份与许可证文件。核对范围是来源、固定身份与许可证文本，不代表完整源码审计、兼容验收或法律意见。参考仓库不执行自己的 install/build 脚本，运行依赖来自本项目 npm 锁文件。

| 源码 | 固定身份 | 许可证范围 | 首先阅读 |
| --- | --- | --- | --- |
| [SurveyJS Library](https://github.com/surveyjs/survey-library/tree/be9813ce647e050476667535b6648d31f1081680) | v3.2.0 / be9813ce647e | 根许可证 MIT | `packages/survey-core/src/survey.ts`、`page.ts`、`packages/survey-js-ui/entries/index.ts` |
| [idb](https://github.com/jakearchibald/idb/tree/654c746bef13f9fe7f5871e03ac58015cebace5a) | v8.0.4 / 654c746bef13 | ISC | `src/entry.ts`、`src/wrap-idb-value.ts`、README 中事务完成与生命周期章节 |
| [Fastify](https://github.com/fastify/fastify/tree/ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6) | 5.12.5 / ba235fdcd9a8 | MIT | `fastify.js`、`lib/route.js`、`docs/Reference/Validation-and-Serialization.md` |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/tree/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb) | 13.0.3 / dbc2ea1165fe | 驱动 MIT；SQLite 源文件有自身声明 | `lib/methods/transaction.js`、`backup.js`、`docs/api.md`、`deps/sqlite3/sqlite3.c` |
| [jsPsych](https://github.com/jspsych/jsPsych/tree/3e24c16c04dc3d2c6406c219126a9c9dc4737627) | 固定提交 3e24c16c04dc | MIT | `packages/jspsych/src/timeline/`、`packages/plugin-preload/src/index.ts`、`packages/plugin-image-button-response/src/index.ts` |
| [lab.js](https://github.com/FelixHenninger/lab.js/tree/b8206ad7e558476a7222adc91c0bc184329832d9) | 固定提交 b8206ad7e558 | **核心库 Apache-2.0；builder AGPL-3.0** | `packages/library/src/core/timeline/`、`src/canvas/`、`src/flow/` |
| [JATOS](https://github.com/JATOS/JATOS/tree/de1654b91a4b42e16dd4953da466ef27b659b642) | 固定提交 de1654b91a4b | 根许可证 Apache-2.0；内含第三方组件另查 | `modules/publix/public/javascripts/jatos.js`、`app/services/publix/ResultCreator.java`、`StudyAuthorisation.java` |
| [Form.io 前端](https://github.com/formio/formio.js/tree/455e2d5e895190e9d2c42e2b4b892c3a0cfd979a) | 固定提交 455e2d5e8951 | 此前端仓库根许可证 MIT；不推及后端与企业产品 | `src/Webform.js`、`WebformBuilder.js`、`components/_classes/component/Component.js` |

SurveyJS v3.2.0 的官方 tag 最终提交与 npm 包的 `gitHead` 不同。本次使用官方 tag 的真实提交作为源码参考，npm 包则由各自锁定的下载完整性摘要识别；不声称两者逐字相同。idb 的 tag 是 annotated tag，锁定的是解引用后的真实 commit，而不是 tag 对象 ID。

SurveyJS、idb、Fastify 和 better-sqlite3 是本项目运行依赖。jsPsych、lab.js、JATOS 和 Form.io 只借鉴机制。未准备 PostgreSQL 驱动、SurveyJS Creator、S3 服务／SDK 或其他延后组件。

## PRNG 原始参考与黄金输出

`prng/xoshiro128starstar.c` 与其包含的 `f2x.c` 来自[算法作者站点](https://prng.di.unimi.it/)，保留原始文件和许可头，摘要已锁定。参考文件说明该生成器是 xoshiro128** 1.1，scrambler 使用 `s[1]`。`generate-vectors.c` 在两个固定状态下分别运行 16 次，生成 [golden-vectors.json](prng/golden-vectors.json)。

```sh
cc -std=c99 -O2 references/prng/generate-vectors.c -o .local/prng-vectors
.local/prng-vectors
```

黄金输出已由本机 C 编译器执行原始参考得到，可作为后续 TypeScript 实现的对照；P0 已实现 TypeScript PRNG、有界拒绝抽样、draw_budget 和调度纯逻辑，并通过全部锁定黄金输出与截止点测试。真实图片运行器与设备预算仍待 P4 验收。

## 取材顺序

P0 先阅读 idb 事务生命周期、SQLite 事务／backup 与 PRNG 参考，编写数据合同和确定性故障夹具。普通问卷阶段阅读 SurveyJS 页面与渲染接口；实验阶段再比较 jsPsych 的预加载／timeline 和 lab.js 的 Canvas／节点机制。研究生命周期与编辑器参考分别取自 JATOS 和 Form.io，保留本项目自己的接收、封存与权限合同。
