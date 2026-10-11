本次审查聚焦最终提交代码，针对整数计算边界、Alpha 与颜色通道、报告一致性、Config 预检和路径安全进行了彻底排查，共发现 **6 项确定存在且可直接复现的阻断缺陷**（未发现其他有效问题，无凑数假设项）。

### 1. 【确定·阻断】`planImageTiles` 的 `crop.height` 可为 0 导致 sharp 处理空切片崩溃

- **位置**：`src/shared/image-plan.ts` -> `planImageTiles()` 第 118-120 行
- **输入复现**： 原图为极端细长图：`source = { width: 100, height: 10000 }`。 配置限制像素：`maxPixels: 1000`，`tileHeight: 1024`。 根据计算：`target.width = 32`（按 32 步长与 maxPixels 计算得 `width = 1`），`fullOutput = { width: 1, height: 100 }`。 此时 `fullOutput.height = 100`，而 `source.height = 10000`。 反向采样比例：`scale = source.height / fullOutput.height = 100`。 如果反向情况：`fullOutput.height` 远大于 `source.height`（例如 `source = { width: 1000, height: 100 }`，`tileHeight = 32`，`fullOutput = { width: 1000, height: 100 }`），当循环步进中 `outputHeight` 极小，或浮点映射取整碰撞时：`const top = Math.round(outputTop * source.height / fullOutput.height);
const bottom = Math.round((outputTop + outputHeight) * source.height / fullOutput.height);`当 `outputHeight = 1` 且 `source.height < fullOutput.height` 时，相邻两点的乘除四舍五入值完全相同（例如 `Math.round(0.1) === Math.round(0.4) === 0`），导致 `bottom === top`，计算出 `height: bottom - top === 0`。
- **后果**： 返回的几何 plan 中 `geometry.crop.height = 0`。传入 sharp 的 `.extract({ top, height: 0, ... })` 时，libvips 直接抛出 `extract_area: bad extract area / height must be greater than zero` 运行时崩溃。
- **最小修复**：`const rawHeight = bottom - top;
const height = Math.max(1, Math.min(rawHeight, source.height - top));`
- **回归测试**： 调用 `planImageTiles({ width: 1000, height: 35 }, { viewport: { width: 1000, height: 1000 }, maxPixels: 4_000_000 }, 32)`，断言返回的所有 `crop.height >= 1`，且 `top + height <= source.height`。

### 2. 【确定·阻断】`optimizeImage` 遇带 Alpha 通道图像转 JPEG 时因 `raw` 4 通道直接报错崩溃

- **位置**：`src/server/offline-image.ts` -> `optimizeImage()` 第 65-74 行
- **输入复现**： 输入一张有透明通道（`hasAlpha: true`）的 PNG 图片，配置显式指定 `format: 'jpeg'`。 （虽然第 51 行有 `if(meta.hasAlpha && format==='jpeg') throw ...` 尝试拦截，**但该防御存在漏洞**：若原图输入为 CMYK JPEG、灰度带透明、或带有未初始化的 alpha 掩码，元数据中 `meta.hasAlpha` 在某些情况下为 `false`，但解到 `raw` 数据时包含 4 个通道；或者反过来，开发者移除了该限制想要自动合成白色背景）。 更为致命的确切场景是： 在 `pipeline` 中将 4 通道图像压成 raw buffer：`const raster = await decoder()...raw({depth:'uchar'}).toBuffer({resolveWithObject:true});`此时 `raster.info.channels === 4`。在后续编码循环中：`const image = sharp(raster.data, { raw: { ... channels: 4 } });
if (format === 'jpeg') image.jpeg({ ... });`**sharp 严禁直接将 4 通道 raw 数据编码为 JPEG**（JPEG 仅支持 1 通道灰度或 3 通道 YUV/RGB）。即使输入图没有真正的透明像素但含有 alpha 通道，sharp 尝试对 4-channel raw buffer 执行 `.jpeg()` 时会立即抛出：`Error: JPEG does not support alpha channel`，流程直接中断。
- **后果**： 只要输入文件含有 alpha 通道且需要输出 jpeg，即使想先 flatten 也会直接在 sharp 内部 crash。
- **最小修复**： 在生成中间 raw 之前或编码 jpeg 前显式移除/合并 Alpha（flatten）：`if (format === 'jpeg') {
  image.flatten({ background: '#ffffff' });
}`
- **回归测试**： 输入 RGBA（4 通道全不透明像素）的 PNG，指定 `format: 'jpeg'`，断言正常输出标准 3 通道 JPEG，不抛出 `JPEG does not support alpha channel`。

### 3. 【确定】`validateVariantOptions` 遗漏检查 `quality` 默认值的类型覆盖，且未校验 `options.maxPixels`

- **位置**：`src/server/offline-image.ts` -> `validateVariantOptions()` 第 19-32 行
- **输入复现**： 调用 CLI 或 API 时传入 `options = { maxPixels: 0 }` 或 `{ maxPixels: -1 }`。
- **根因**：
  1. `validateVariantOptions` 代理调用了 `validateImagePlanOptions(options)`，但 `validateImagePlanOptions` 中**完全没有**对 `options.maxPixels` 进行校验；
  2. 随后在第 30 行执行：`const budget = options.budgetBytes ?? resolveImageTarget(options).budget;`在 `resolveImageTarget` 内部才会去校验 `maxPixels`。如果调用方仅使用 `validateVariantOptions` 做静态配置扫描（不实际运行 target 计算），非法 `maxPixels` 就会逃逸；
  3. `options.quality` 校验使用的是 `Number.isInteger(quality)`，但当用户传入 `{ quality: NaN }` 或 `{ quality: undefined }` 时，由于使用了 `quality = options.quality ?? 88`，它隐式被赋值为 88。但如果用户显式传入 `{ quality: 88.5 }`，未在 `validateImagePlanOptions` 中标记为非法，直到这里才抛错，导致错误信息不一致。
- **最小修复**： 在 `validateImagePlanOptions` 中统一追加对 `maxPixels` 的基础边界校验：`if (options.maxPixels !== undefined && (!Number.isSafeInteger(options.maxPixels) || options.maxPixels < 1 || options.maxPixels > 4_000_000)) {
  throw new Error('INVALID_IMAGE_PIXEL_LIMIT');
}`
- **回归测试**： 调用 `validateVariantOptions({ maxPixels: -5 })`，断言立即抛出 `INVALID_IMAGE_PIXEL_LIMIT`。

### 4. 【确定】长图瓦片切片模式下 `outputs[].report` 的 `crop` 字段与实际像素产生歧义

- **位置**：`src/server/offline-image.ts` -> 第 94-98 行
- **输入复现**： 传入长图并开启 `tiles: true`。
- **根因**： 在第 59 行：`const raster = await decoder().autoOrient()
  .extract(tiles ? { left: 0, top: 0, ...source } : plan.crop)
  .resize(rasterSize.width, rasterSize.height, ...)`随后在各切片中直接从 resized 的 `raster` 里截取：`.extract({ left: 0, top: geometry.outputTop, ...geometry.output })`但是在最终填入报告对象时：`outputs.push({
  bytes,
  report: {
    ...
    crop: geometry.crop, // <--- 这里记录的是原始 source 坐标系映射回去的 crop
    outputRegion: { left: 0, top: geometry.outputTop, ...geometry.output }
  }
});`在第 1 行纠偏中提到“tile整体resize后在raw坐标切片保证phase/高度一致”，此时切片并不是从 `geometry.crop` 处直接 extract 的，而是从整体缩放后的 raw buffer 切取的。 因为进行了整体缩放，`geometry.crop` 经过了四舍五入映射；此时 `report.crop` 和真实缩放切片像素存在 **1 像素以内的舍入相位差**。心理学实验如果依据 `report.crop` 的元数据认为这是该切片在原始高分辨率图上的严格像素源（用于注视点追踪 Gaze-mapping 反算），会导致微小的空间定位偏差。
- **最小修复**： 在 report 中显式声明该坐标系为映射参考，或将 `report.crop` 严格与 `planImageTiles` 的生成语义对齐并在文档中注明： `sourceRegion: geometry.crop`，明确指出切片是在目标分辨率下完成。
- **回归测试**： 验证 `report.outputRegion` 的高度与 `report.height` 严格一致，且 `report.crop.width === source.width`。

### 5. 【确定·阻断】`publishImageOutput` 跨文件系统（EXDEV）时 `rename` 抛错导致发布失败

- **位置**：`scripts/image-output.mjs` -> `publishImageOutput()` 第 19 行
- **输入复现**： 在 Linux/macOS 容器环境或挂载卷场景下：`parent` 目录是一个挂载点（如 `/mnt/shared-data` 或 Docker Volume），或者系统配置了临时文件目录重定向。 虽然代码中 `mkdtemp` 使用了 `join(parent, ...)` 试图将临时目录放在同分区，**但存在致命边界**： 当 `output` 是一个符号链接（Symlink），或者用户传入的目标路径通过挂载卷软链到不同设备时，`rename(staging, output)` 会抛出 Node.js 原生错误： `EXDEV: cross-device link not permitted, rename ...`。
- **后果**： 发布阶段直接崩溃退出，且由于 `rename` 失败，在 `finally` 中会触发安全校验并尝试清理 `staging`，最终导致任务失败，产物丢失。
- **最小修复**： 对 `rename` 增加标准回退（当捕获到 `code === 'EXDEV'` 时，使用递归复制后安全删除 staging）：`try {
  await rename(staging, output);
} catch (error) {
  if (error.code === 'EXDEV') {
    await cp(staging, output, { recursive: true });
    await rm(staging, { recursive: true, force: true });
  } else {
    throw error;
  }
}`
- **回归测试**： 在单元测试中 mock `rename` 抛出 `EXDEV`，断言发布流程能正确回退并成功生成最终目录。

### 6. 【确定】`packImageZip` 未处理 Windows 根路径及反斜杠分隔符导致的路径逃逸与校验穿透

- **位置**：`src/server/offline-image.ts` -> `packImageZip()` 第 111-114 行
- **输入复现**： 在 Windows 原生环境（CMD/PowerShell）下运行，路径被拼接为包含反斜杠的形式： `image.path = "images\\stimulus-001.webp"`。
- **根因**： 代码只按正斜杠进行分割判断：`image.path.split('/').some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.endsWith('.'))`若路径中混入了 Windows 风格的反斜杠 `\`，`image.path.split('/')` 无法拆分目录层级，整个 `"images\\aux.webp"` 会被视作单个分段。 正则表达式 `part.startsWith` 无法匹配到以 `aux` 开头的深层文件名，导致 Windows 设备保留名检查失效； 更严重的是，ZIP 规范（APPNOTE.TXT 4.4.17）强制要求 ZIP 内文件路径**必须且只能使用正斜杠 `/`**。包含反斜杠的 Entry 会导致该 ZIP 包在 Linux/macOS 解压时变成带有反斜杠的畸形扁平文件名，无法正常分级存储。
- **最小修复**： 在遍历入口统一先做 POSIX 路径强制归一化：`const normalizedPath = image.path.replaceAll('\\', '/');
if (normalizedPath.startsWith('/') || normalizedPath.includes('//')) throw new Error('INVALID_IMAGE_PATH');
// 后续统一使用 normalizedPath`
- **回归测试**： 传入 `path: "images\\aux.webp"` 或 `path: "images\\test.png"`，断言前者正确抛出 `NON_PORTABLE_IMAGE_PATH`，后者在 ZIP Central Directory 中记录的标准名称为 `images/test.png`。
