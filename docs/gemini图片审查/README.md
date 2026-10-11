# Gemini bridge 图片代码审查（2026-10-10）

审查范围：image-plan.ts、offline-image.ts、prepare-images.mjs、image-output.mjs 和图片优化单元测试。仅本地上传前生成固定资产，生产上传/计时合同保持不变。

通过当前 [Gemini 会话](https://gemini.google.com/app/e7df010d227238a1) 完成两轮初审和一轮补丁复审。原文保留，不将 Gemini 的“确定”标签直接视为已确认缺陷。

| 轮次 | 请求 | 输入/答复 |
| --- | --- | --- |
| 核心 | req_C8mQqvZoGAHSfOD135x5eQ | [输入](core-input.md)、[答复](core-response.md) |
| CLI | req_QuLQ1vdBSr01w6SAX-18lg | [输入](cli-input.md)、[答复](cli-response.md) |
| 补丁 | req_UEL1q92K42Hv5v3SzJSTPA | [输入](final-input.md)、[答复](final-response.md) |

## 已采用

- 长图先生成整体缩放 raw 位图再切片。分数比例缩放/逐像素拼接用例证明与一次 Lanczos 缩放相同，避免累计高度误差和逐片滤波相位差。
- 单个 variant 几何变换一次，质量重试复用 raw；最多三次编码。没有采用 Gemini 建议中的无格式 toBuffer 中间文件，避免源为 JPEG 时再次有损编码。缩放位图最多 4MP，长图整体最多 16MP。
- 显式 ICC 转换 sRGB 并删除 profile，覆盖 P3 输入；广色域/HDR 的完整保真仍不承诺。
- ZIP 格式/后缀核对、大小写冲突与 Windows 保留名拒绝；配置全量预检并拒绝 null/错误类型；保护区域浮点边界容差为 8 个机器 epsilon。
- 源路径 realpath 分组，一组只读取一个 Buffer，不采用无界图库缓存。不同 variant 的独立几何仍分别解码。
- 输出临时目录写完后 rename 发布，附目标锁；正常失败清理自己创建的临时目录，拒绝覆盖已有目录。清理前验证实际绝对路径和父目录。
- 补丁复审发现静态校验在显式 budgetBytes 时可跳过 target/maxPixels 校验；改为无条件解析 target，新增回归用例。
- report 增加 cropSpace 区分源图准确裁切/输出切片的源坐标映射，以及 outputRegion、rasterBytes、encodeAttempts、sourceReads。

## 未采纳或纠偏

- “保护区上下界颠倒”：Gemini 建议公式与原实现等价；新增保护区域靠右且焦点冲突用例通过，不改变公式。
- “autoOrient().extract() 时序缺陷”：建议改 rotate 与自身声明等价；八种 EXIF 方向、非对称焦点与 PNG 像素对照通过，保留 autoOrient。
- “ICC 修复”原文存在重复相同调用的矛盾；采用 sharp 实际提供的 withIccProfile('srgb',{attach:false})，未采用虚构 API。
- “ZIP 日期33无效”：33 是 MS-DOS 1980-01-01，保留确定性时间戳。
- “defaults:null 抛原生TypeError”：原 record 的 !value 已拒绝；保留严格拒绝，不把 null 静默归一化为空对象。
- “tile heightLimit=0 死循环”：原 rows 已 Math.max(1,...)，目标面积还限制宽度；不接受该死循环结论。
- 补丁复审“零高度 crop”：width 不超过源宽，fullOutput.height 不超过源高；切片在输出坐标 extract，不使用近似源 crop 来截取。原论据不成立。
- 补丁复审“Alpha JPEG 崩溃”：透明输入按合同先拒绝，不自动 flatten 丢透明信息；RGB/JPEG 实际编码与拒绝 Alpha 用例通过。
- 补丁复审“EXDEV 必須递归复制回退”：临时/目标是同一 realpath 父目录，已有 symlink 经 lstat 拒绝。跨卷论据不适用；复制回退会重新暴露半成品，不采用。
- 补丁复审“反斜杠绕过”：imagePath 已拒绝反斜杠，新增用例固定该行为，不擅自归一化用户路径。
- 未采用“耗时下降50%/CPU暴涨3倍”等无实测百分比。复用计数说明处理方式，不能替代性能测量。

## 验证与边界

回归覆盖八方向 EXIF、P3 转换、透明度、分数比例长图逐像素拼接、质量下限、配置预检、重名/保留名/后缀、失败清理与重试、重复源读取。本轮最终执行：93/93 单元测试、typecheck、生产 build 和 git diff --check 通过。构建仍有既有 SurveyJS 检查页大包提示，与图片工具无关；本轮没有浏览器页面实现改动，未重复浏览器套件。

实际示例包生成于 `.local/mobile-images-gemini-reviewed/mobile-optimized.zip`，共 2 图、36,312 B，均未超过软预算。输出大小与优化前示例一致；本轮优化目标为正确性和重复处理开销，未宣称新增压缩率收益。

临时位图占用报告不等于整个进程峰值；缩放本身仍丢空间细节。强制杀进程/掉电可残留锁/临时目录，由用户确认没有任务运行后清理，或使用新的目标目录；不保证掉电持久化。另一个不遵守工具锁的进程主动替换目录不在本地 CLI 合同内。没有进行真机能耗/下载体验测量，没有改动已冻结资产。
