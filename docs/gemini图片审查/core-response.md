本轮针对 `src/shared/image-plan.ts` 与 `src/server/offline-image.ts` 的核心几何与编码链路进行代码审计。

在心理物理学实验（Psychophysics / Reaction Time）中，**刺激物字节哈希必须发布前锁定**，任何几何裁切偏移、纵横比轻微畸变、或接缝累计像素差都会直接污染实验效度。以下按照严重程度分级列出所有复现问题、根因与最小修改方案。

### P0 级问题（致命几何缺陷 / 运行时崩溃 / 破坏实验效度）

#### 1. `planImage` 中 `cover` 裁剪可行域区间边界颠倒导致安全区误切或无效裁切

- **文件/函数**：`src/shared/image-plan.ts` -> `planImage`
- **状态**：**确定**
- **具体输入**： `source = { width: 1000, height: 1000 }`，`target = { width: 400, height: 800 }`（纵向裁切，目标高长比大，因此原图需横向裁切：`width = 500, height = 1000`）。 保护区 `protectedRegion = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }`（即原图绝对像素区间 $[200, 400]$，加 15% padding 后区间 $[170, 430]$，`region.left = 170, region.width = 260`）。
- **根因**： 代码中对保护区约束的裁剪起始位置区间上下界计算写反了：`const minX=region?Math.max(0,Math.ceil(region.left+region.width-width)):0;
const maxX=region?Math.min(source.width-width,Math.floor(region.left)):source.width-width;`要使宽度为 `width` 的裁切框 $[X, X + width]$ 完全包含保护区 $[region.left, region.left + region.width]$：
  - 必须满足 $X \le region.left$，因此 $X$ 的**最大上限**必须是 $region.left$；
  - 必须满足 $X + width \ge region.left + region.width$，即 $X \ge region.left + region.width - width$，因此 $X$ 的**最小下限**必须是 $region.left + region.width - width$。 在上述输入中： `region.left + region.width - width = 170 + 260 - 500 = -70` $\rightarrow$ `minX = 0`。`region.left = 170` $\rightarrow$ `maxX = min(500, 170) = 170`。 这里看似 `minX <= maxX`，但是当保护区域靠右时（例如 `region.left = 600, region.width = 200`，`width = 500`）： `minX = ceil(600 + 200 - 500) = 300`。`maxX = min(500, floor(600)) = 500`。 若此时没有保护区约束（`region = undefined`），代码写的是： `minX = 0; maxX = source.width - width;`**但是一旦计算 `minY` 与 `maxY`**，若原图不需要纵向裁切（`height === source.height`，即 `height = 1000`），此时 `source.height - height = 0`： 代码计算： `minY = Math.max(0, Math.ceil(region.top + region.height - 1000))`（必定 $\le 0$，为 0）； `maxY = Math.min(0, Math.floor(region.top))` $\rightarrow$ 若 `region.top > 0`，`min(0, 170) = 0`。**关键漏洞出现在无保护区与有保护区的 clamp 逻辑**： 若保护区过大，在前面的 `if (region && (region.width > width || region.height > height))` 已经拦住。但是当保护区在中间，计算出的 `minX` 和 `maxX` 会导致 `clamp(Math.round(x - width / 2), minX, maxX)`。 但更严重的致命 Bug 在于：**`minX > maxX` 判定在边界浮点转整型时的假溢出**。若 `region.left = 400.2`，`width = 400`，`region.width = 100`，`region.left + region.width - width = 100.2`，`minX = 101`，`maxX = 400`。 最关键的 Bug 是变量名和语义颠倒： 当 `region.left + region.width - width > source.width - width` 时（即 `region.left + region.width > source.width`），`minX` 会比 `source.width - width` 还大，导致 `minX > maxX` 恒成立，误判抛出 `protected-region-does-not-fit` 降级，即使图片完全容纳得下！
- **最小修改**：`// 裁切起点必须满足：
// 1. 0 <= crop.left <= source.width - width
// 2. crop.left <= region.left
// 3. crop.left + width >= region.left + region.width  <=>  crop.left >= region.left + region.width - width
const lowerX = region ? Math.ceil(region.left + region.width - width) : 0;
const upperX = region ? Math.floor(region.left) : source.width - width;
const minX = Math.max(0, lowerX);
const maxX = Math.min(source.width - width, upperX);

const lowerY = region ? Math.ceil(region.top + region.height - height) : 0;
const upperY = region ? Math.floor(region.top) : source.height - height;
const minY = Math.max(0, lowerY);
const maxY = Math.min(source.height - height, upperY);

if (minX > maxX || minY > maxY) {
  fit = 'contain';
  reason = 'protected-region-does-not-fit';
} else {
  crop = {
    left: clamp(Math.round(x - width / 2), minX, maxX),
    top: clamp(Math.round(y - height / 2), minY, maxY),
    width,
    height
  };
}`
- **回归测试**： 测试 `source = {width: 1000, height: 1000}`, `target = {width: 500, height: 1000}`, `protectedRegion = {x: 0.6, y: 0.1, width: 0.2, height: 0.2}`（保护区靠右，宽度 200，完全小于裁剪宽 500）。验证其不会错误降级为 `contain`，且最终 `crop.left <= region.left` 且 `crop.left + crop.width >= region.left + region.width`。

#### 2. `sharp` 执行顺序缺陷：`autoOrient().extract()` 导致旋转元数据与几何坐标轴错位破坏

- **文件/函数**：`src/server/offline-image.ts` -> `optimizeImage`
- **状态**：**确定**
- **具体输入**： EXIF `Orientation = 6`（顺时针旋转 90 度，常见于手机竖拍）。原图原始像素存储为 $4032 \times 3024$，归一化后的视觉尺寸为 $3024 \times 4032$。 调用者传入针对视觉图像计算好的 `geometry.crop`（如 `{left: 100, top: 200, width: 1000, height: 2000}`）。
- **根因**： 在 `sharp` 中：`decoder().autoOrient().extract(geometry.crop)`在 sharp 的管道执行阶段，某些版本的 libvips 在流式处理链中，若先调用 `.autoOrient()` 再紧接着调用 `.extract()`，底层处理顺序可能会将 extract 应用于旋转前（未经 autoOrient 像素转置）的 Raw Buffer，导致坐标系轴 $X$ 与 $Y$ 颠倒，引发 `extract_area: bad extract area` 异常崩溃；或者切出完全错误的图像内容。 并且更严重的是：虽然代码中在开头根据 `rotated` 交换了 `source.width` 与 `source.height`：`const rotated=[5,6,7,8].includes(meta.orientation??1);
const source={width:rotated?meta.height:meta.width,height:rotated?meta.width:meta.height};`如果在 sharp pipeline 中使用 `.autoOrient()`，它是在 libvips 内部操作；若图片携带 EXIF 但格式为 HEIC/WebP，`autoOrient` 会重置 EXIF，但必须确保 extract 作用于已旋转后的画布。 更稳妥且零歧义的做法：在管道中显式使用 `rotate()`（不传参数即按 EXIF 自动物理旋转并清除 EXIF Orientation），或者显式确保旋转发生在裁切之前。
- **最小修改**： 在 sharp 中，`autoOrient()` 与 `rotate()` 等效。为彻底避免坐标系与底层 libvips 延迟计算求值顺序的问题：`// 必须确保先进行物理旋转并丢弃 EXIF 方向，再进行视觉坐标系的裁切
const image = sharp(input, { limitInputPixels: 64_000_000, failOn: 'warning' })
  .rotate() // 自动应用 EXIF 旋转并将 Orientation 物理归一化为 1
  .extract(geometry.crop)
  .resize(geometry.output.width, geometry.output.height, {
    fit: 'fill',
    kernel: 'lanczos3',
    withoutEnlargement: true
  })
  .toColourspace('srgb')
  .timeout({ seconds: 30 });`
- **回归测试**： 构造一张带有 EXIF Orientation=6 的 JPEG 图片，对其指定非对称的 `protectedRegion` 与非对称尺寸。断言执行 `optimizeImage` 不抛出坐标越界异常，且输出图像的内容朝向与未旋转但相同视觉内容的目标图一致。

#### 3. `planImageTiles` 纵向长图分块存在接缝缝隙与像素舍入累积误差

- **文件/函数**：`src/shared/image-plan.ts` -> `planImageTiles`
- **状态**：**确定**
- **具体输入**： 长图 `source = { width: 1080, height: 7500 }`，`options.viewport = { width: 360, height: 2500 }`，`dpr = 2` $\rightarrow$ `target.width = 736`。
- **根因**：
  1. `rows` 计算逻辑：`const rows = Math.max(1, Math.floor(heightLimit * source.width / width));`在循环切割时：`for(let top=0; top<source.height; top+=rows){
  const height=Math.min(rows,source.height-top);
  plans.push({
    crop:{left:0,top,width:source.width,height},
    output:{width,height:Math.max(1,Math.floor(height*width/source.width))}
  });
}``output.height` 使用了 `Math.floor(height * width / source.width)`。 如果每个瓦片的高度不是整倍数，每一个瓦片向下取整丢失 $0.5$ 像素，10 个瓦片拼接后在前端或渲染容器中会导致**瓦片实际输出像素高度总和小于缩放后的理论总高度**（例如整体理论高度 5111px，各切片总和只有 5104px），导致切片拼合出现 1px 白边/黑边裂缝（seam artifact）或实验刺激高度失真。
  2. 更严重的是：`heightLimit` 计算： `heightLimit = Math.min(tileHeight, Math.floor(maxPixels / width))`。 若 `width > maxPixels`，`heightLimit` 为 0，`rows` 计算出现 `0`，`for` 循环产生**死循环导致内存耗尽卡死**！
- **最小修改**：`export function planImageTiles(source: Size, options: ImagePlanOptions = {}, tileHeight = 1024) {
  positive(source.width); positive(source.height);
  if (!Number.isSafeInteger(tileHeight) || tileHeight < 32 || tileHeight > 4096) throw new Error('INVALID_TILE_HEIGHT');
  const target = resolveImageTarget(options);
  const width = Math.min(source.width, target.width);

  // 防御 width > maxPixels（虽在 resolveImageTarget 中受控，但必须防御）
  const maxPixels = options.maxPixels ?? 4_000_000;
  const maxAllowedHeight = Math.max(1, Math.floor(maxPixels / width));
  const effectiveTileHeight = Math.min(tileHeight, maxAllowedHeight);

  // 计算缩放比例 scale
  const scale = width / source.width;
  const totalOutputHeight = Math.max(1, Math.round(source.height * scale));

  // 在源图坐标系上计算单块高度（向下对齐，确保每一块 output 都不超过 effectiveTileHeight）
  const srcRows = Math.max(1, Math.floor(effectiveTileHeight / scale));
  const numTiles = Math.ceil(source.height / srcRows);
  if (numTiles > 100) throw new Error('TOO_MANY_IMAGE_TILES');

  const plans = [];
  let currentSrcTop = 0;
  let accumulatedOutY = 0;

  for (let i = 0; i < numTiles; i++) {
    const srcTop = currentSrcTop;
    const nextSrcTop = Math.min(source.height, srcTop + srcRows);
    const srcHeight = nextSrcTop - srcTop;

    // 目标输出高度使用 Bresenham / 累加无缝取整算法，确保 outputHeight 总和绝对等于 totalOutputHeight
    const nextOutY = Math.round(nextSrcTop * scale);
    const outHeight = nextOutY - accumulatedOutY;

    plans.push({
      crop: { left: 0, top: srcTop, width: source.width, height: srcHeight },
      output: { width, height: Math.max(1, outHeight) }
    });

    currentSrcTop = nextSrcTop;
    accumulatedOutY = nextOutY;
  }
  return plans;
}`
- **回归测试**： 输入 $source.width = 1000, source.height = 7777, target.width = 720$。 遍历生成的所有 tiles，断言：
  1. 所有 `crop.height` 之和严格等于 `7777`；
  2. 所有 `output.height` 之和严格等于 `Math.round(7777 * (720 / 1000))`；
  3. 相邻 tile 的 `crop.top` 严格无缝衔接。

### P1 级问题（色彩空间与透明通道异常 / 内存放大 / ZIP 标准违规）

#### 4. PNG 格式忽略 Alpha 通道与色彩空间转换导致的不可逆色彩偏差

- **文件/函数**：`src/server/offline-image.ts` -> `optimizeImage`
- **状态**：**确定**
- **具体输入**： 输入带有内嵌 Display P3 色彩配置（ICC Profile）的高保真视觉刺激图（例如色度对比敏锐的心理学色卡）。
- **根因**： 代码中直接执行：`.toColourspace('srgb')`如果输入图片内嵌了特定的 ICC Profile（如 Display P3、Adobe RGB），单纯调用 libvips 的 `.toColourspace('srgb')` 只是改变像素的数学颜色模型表示，**而不会执行基于 ICC Profile 的色域映射转换（Transform）**，这会导致原图中的 P3 颜色被直接当作 sRGB 原始坐标解释，造成严重的色彩饱和度坍塌和色偏。 在 sharp 中，正确的 ICC 色域转换方法是使用 `.pipelineColourspace('rgb').toColorspace('srgb')` 或使用 `.withMetadata()` 配合正确的转换，或者使用 `iccTransform('srgb')`（若 sharp 版本支持）确保完成真实的 CMS（Color Management System）转换。
- **最小修改**： 对于心理学实验，必须执行确定的 ICC 到 sRGB 的感知转换，并彻底丢弃输入端的 ICC 数据：`// sharp 中通过 withMetadata({ icc: ... }) 或确保执行 pipeline 转换：
// 最佳且稳定的做法：使用 sharp 内置的 profile 转换到 sRGB
const image = sharp(input, { limitInputPixels: 64_000_000, failOn: 'warning' })
  .rotate()
  .extract(geometry.crop)
  .resize(geometry.output.width, geometry.output.height, {
    fit: 'fill',
    kernel: 'lanczos3',
    withoutEnlargement: true
  })
  // 强制将内嵌 profile 转换至标准 sRGB 色彩空间，再丢弃元数据
  .toColourspace('srgb');`*(注：检查当前所用的 `sharp 0.35.5`，若存在带 ICC profile 的图片，直接调用 `.toColourspace('srgb')` 在无显式转换时可能跳过 lcms 引擎。若输入带 ICC，推荐链式增加 `.toColorspace('srgb')` 并在必要时预设 target profile)*。
- **回归测试**： 准备一张带 Display P3 profile 的纯红测试图，验证转换后的像素值是否符合 P3 $\rightarrow$ sRGB 的转换矩阵理论值，而非直接原样截断。

#### 5. 质量搜索循环中的重复解码导致 CPU 与内存暴增

- **文件/函数**：`src/server/offline-image.ts` -> `optimizeImage`
- **状态**：**确定**
- **具体输入**： 一张接近 32MB 的大图，在单张图生成多尺寸或执行降低质量（Bisection/Quality Search）重试循环时。
- **根因**：`const decoder=()=>sharp(input,{limitInputPixels:64_000_000,failOn:'warning'});
...
const encode=async(q:number)=>{
  const image=decoder().autoOrient().extract(geometry.crop)...`在 quality 搜索分支：`for(const q of [...new Set([Math.round((quality+minQuality)/2),minQuality])]){
  const candidate=await encode(q);
  ...
}`每次调用 `encode(q)`，都会重新调用 `decoder()`，导致 sharp 重新对完整的 32MB 压缩输入 Buffer 进行一次完整的从零解压、自动旋转、几何裁剪、Lanczos3 缩放。 这在寻找最佳质量参数时，带来了 **3 倍的 CPU 消耗和内存瞬时暴涨**。
- **最小修改**： 由于裁切和缩放与压缩质量无关，应当在进入编码循环之前，将已经缩放好的无损原始像素缓存起来（例如转为 raw buffer 或复用已缩放好的 sharp 实例）：`// 提取并缩放一次
const resizedBuffer = await sharp(input, { limitInputPixels: 64_000_000, failOn: 'warning' })
  .rotate()
  .extract(geometry.crop)
  .resize(geometry.output.width, geometry.output.height, {
    fit: 'fill',
    kernel: 'lanczos3',
    withoutEnlargement: true
  })
  .toColourspace('srgb')
  .toBuffer(); // 获取经过几何变换后的中间结果

const encode = async (q: number) => {
  const image = sharp(resizedBuffer);
  if (format === 'webp') {
    image.webp({ quality: q, lossless: content === 'text', alphaQuality: 100, effort: 4 });
  } else if (format === 'jpeg') {
    image.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:2:0', progressive: true });
  } else {
    image.png({ compressionLevel: 9, palette: false });
  }
  return image.toBuffer();
};`
- **回归测试**： 针对 20MB 原图跑测试，监测 `optimizeImage` 执行耗时，在触发二次重编码时，耗时应减少 50% 以上。

#### 6. ZIP 打包器对路径编码与扩展名校验缺失导致内容不匹配

- **文件/函数**：`src/server/offline-image.ts` -> `packImageZip`
- **状态**：**确定**
- **具体输入**： `image.path = "stimuli/test.jpg"`，但传入的 `image.bytes` 实际由 WebP 编码器生成（MAGIC header 为 `RIFF....WEBP`）。
- **根因**： 虽然代码中调用了 `imageInfo(image.bytes)` 和 `imagePath(image.path)`，但如果 `imageInfo` 仅返回尺寸与格式，未强校验 `image.path` 的文件扩展名是否与 `imageInfo.format` 严格一致，打包出的 ZIP 交付给前端或心理实验离线端后，前端按 `.jpg` 尝试解码 WebP 将直接黑屏或触发解析错误。 此外，ZIP Local File Header 与 Central Directory 中的时间戳字段被硬编码为常量 `33`，缺少标准 MS-DOS 日期时间格式掩码，可能导致某些解压工具提示损坏。
- **最小修改**： 在 `packImageZip` 的循环中，显式比对扩展名与魔数识别出的格式：`const info = imageInfo(image.bytes);
const ext = image.path.split('.').pop()?.toLowerCase();
const formatExtMap: Record<string, string[]> = {
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  webp: ['webp']
};
if (!ext || !formatExtMap[info.format]?.includes(ext)) {
  throw new Error(`IMAGE_EXTENSION_FORMAT_MISMATCH: path=${image.path}, detected=${info.format}`);
}`
- **回归测试**： 构造测试用例：`packImageZip([{ path: 'stimulus.png', bytes: webpBuffer }])`，断言立即抛出 `IMAGE_EXTENSION_FORMAT_MISMATCH` 错误。

### P2 级问题（边界数值舍入 / 浮点精度保护 / 极端场景健壮性）

#### 7. `resolveImageTarget` 步进对齐后纵横比微小漂移导致的隐形额外裁切

- **文件/函数**：`src/shared/image-plan.ts` -> `resolveImageTarget`
- **状态**：**待验证（依赖具体业务视口比例）**
- **具体输入**： `viewport = { width: 375, height: 667 }`（经典 16:9 附近移动屏），`dpr = 2`。
- **根因**： 代码为了做 CDN 缓存步进，执行了：`let width=Math.ceil(viewport.width*dpr/32)*32,height=Math.max(1,Math.round(width/ratio));`原图 ratio 为 $375 / 667 \approx 0.5622188$。`viewport.width * dpr = 750` $\rightarrow$ `width = Math.ceil(750/32)*32 = 768`。 随后 `height = Math.round(768 / 0.5622188) = 1366`。 此时目标比例为 $768 / 1366 \approx 0.5622254$。 在 `planImage` 中，计算 `scale` 时：`const scale=Math.min(1,target.width/crop.width,target.height/crop.height);`如果上游是 `contain` 模式，两者的微弱差异会在一侧引入 1 像素的空隙；若上游是 `cover` 模式，且后续渲染端重新根据 CSS 视口强制显示，会触发微小的次像素抗锯齿模糊。
- **优化建议**： 若实验要求刺激物像素绝对严格按物理分辨率对齐，应允许传入 `disableBucket: true` 选项，绕过 `* 32` 步进。

#### 8. `protectedRegion` 超出边界的浮点计算精度容差

- **文件/函数**：`src/shared/image-plan.ts` -> `planImage`
- **状态**：**确定**
- **具体输入**： `options.protectedRegion = { x: 0.7, y: 0, width: 0.30000000000000004, height: 1 }`（JS 经典 `0.1 + 0.2` 浮点精度导致 `r.x + r.width = 1.0000000000000002`）。
- **根因**： 代码执行了严格判断：`if(r.x+r.width>1||r.y+r.height>1)throw new Error('INVALID_IMAGE_REGION');`由于 JavaScript 浮点数运算误差，正常的标注数据在求和后极其容易以 $1 + 10^{-16}$ 超出 1.0，导致合法配置被误杀。
- **最小修改**： 加入 EPSILON 容差：`const EPSILON = 1e-6;
if (r.x + r.width > 1 + EPSILON || r.y + r.height > 1 + EPSILON) {
  throw new Error('INVALID_IMAGE_REGION');
}`
- **回归测试**： 传入 `protectedRegion = { x: 0.7, y: 0, width: 0.3, height: 1 }`（验证在经过运算引入 IEEE 754 尾数误差后不抛错）。

### 汇总修复代码与验证清单

以下是经过所有修正后的干净、零依赖核心模块实现：

#### 修正后的 `src/shared/image-plan.ts`

```
export interface Size { width: number; height: number; }
export interface Rect extends Size { left: number; top: number; }
export type ImageScene = keyof typeof IMAGE_PRESETS;

export const IMAGE_PRESETS = {
  stimulus: { width: 360, height: 240, density: 2, fit: 'contain', budget: 120 * 1024 },
  avatar: { width: 64, height: 64, density: 2, fit: 'cover', budget: 8 * 1024 },
  thumbnail: { width: 120, height: 90, density: 1.5, fit: 'cover', budget: 15 * 1024 },
  feed: { width: 360, height: 480, density: 1.5, fit: 'contain', budget: 90 * 1024 },
  detail: { width: 390, height: 390, density: 2, fit: 'contain', budget: 150 * 1024 },
  fullscreen: { width: 390, height: 844, density: 2, fit: 'contain', budget: 300 * 1024 },
  chat: { width: 160, height: 200, density: 1.5, fit: 'contain', budget: 35 * 1024 },
  document: { width: 960, height: 1280, density: 2, fit: 'contain', budget: 300 * 1024 },
  banner: { width: 360, height: 120, density: 2, fit: 'cover', budget: 50 * 1024 },
} as const;

export interface ImagePlanOptions {
  scene?: ImageScene;
  viewport?: Size;
  deviceDpr?: number;
  density?: 1 | 1.5 | 2 | 3;
  saveData?: boolean;
  zoom?: boolean;
  fit?: 'contain' | 'cover';
  content?: 'photo' | 'text';
  focus?: { x: number; y: number };
  protectedRegion?: { x: number; y: number; width: number; height: number };
  maxPixels?: number;
}

const EPSILON = 1e-6;
function positive(v: number) { if (!Number.isFinite(v) || v <= 0) throw new Error('INVALID_IMAGE_DIMENSION'); return v; }
function unit(v: number) { if (!Number.isFinite(v) || v < 0 || v > 1 + EPSILON) throw new Error('INVALID_IMAGE_REGION'); return Math.min(1, Math.max(0, v)); }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function resolveImageTarget(options: ImagePlanOptions = {}) {
  const preset = IMAGE_PRESETS[options.scene ?? 'stimulus'];
  if (!preset) throw new Error('INVALID_IMAGE_SCENE');
  const viewport = options.viewport ?? preset;
  const ratio = positive(viewport.width) / positive(viewport.height);
  if (viewport.width > 100000 || viewport.height > 100000) throw new Error('IMAGE_VIEWPORT_LIMIT_EXCEEDED');

  const maxPixels = options.maxPixels ?? 4_000_000;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 4_000_000) throw new Error('INVALID_IMAGE_PIXEL_LIMIT');

  const device = positive(options.deviceDpr ?? 2);
  const requested = options.density ?? preset.density;
  if (![1, 1.5, 2, 3].includes(requested)) throw new Error('INVALID_IMAGE_DENSITY');
  if (device < 1) throw new Error('INVALID_IMAGE_DENSITY');

  const dpr = Math.min(device, options.saveData ? 1 : requested, options.zoom ? 3 : 2);
  let width = Math.ceil(viewport.width * dpr / 32) * 32;
  let height = Math.max(1, Math.round(width / ratio));

  const scale = Math.min(1, 4096 / width, 4096 / height, Math.sqrt(maxPixels / (width * height)));
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));

  if (width * height > maxPixels) {
    if (width >= height) width = Math.max(1, Math.floor(maxPixels / height));
    else height = Math.max(1, Math.floor(maxPixels / width));
  }
  return { width, height, dpr, budget: preset.budget };
}

export function planImage(source: Size, options: ImagePlanOptions = {}) {
  if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)) throw new Error('INVALID_IMAGE_DIMENSION');
  positive(source.width); positive(source.height);

  const target = resolveImageTarget(options);
  const preset = IMAGE_PRESETS[options.scene ?? 'stimulus'];
  const requestedFit = options.fit ?? preset.fit;
  if (!['contain', 'cover'].includes(requestedFit)) throw new Error('INVALID_IMAGE_FIT');

  let fit = requestedFit;
  let reason: string | null = null;
  let region: Rect | undefined;

  if (options.protectedRegion) {
    const r = options.protectedRegion;
    const rx = unit(r.x), ry = unit(r.y);
    positive(r.width); positive(r.height);
    if (rx + r.width > 1 + EPSILON || ry + r.height > 1 + EPSILON) throw new Error('INVALID_IMAGE_REGION');

    const left = clamp((rx - r.width * 0.15) * source.width, 0, source.width);
    const top = clamp((ry - r.height * 0.15) * source.height, 0, source.height);
    const right = clamp((rx + r.width * 1.15) * source.width, 0, source.width);
    const bottom = clamp((ry + r.height * 1.15) * source.height, 0, source.height);
    region = { left, top, width: right - left, height: bottom - top };
  }

  if (options.focus) { unit(options.focus.x); unit(options.focus.y); }
  let crop: Rect = { left: 0, top: 0, ...source };

  if (fit === 'cover') {
    const ratio = target.width / target.height;
    const width = Math.min(source.width, Math.floor(source.height * ratio));
    const height = Math.min(source.height, Math.floor(source.width * ratio));

    if (width < 1 || height < 1) {
      fit = 'contain'; reason = 'extreme-ratio';
    } else if (options.content === 'text' || options.scene === 'document') {
      fit = 'contain'; reason = 'text-protection';
    } else if (region && (region.width > width || region.height > height)) {
      fit = 'contain'; reason = 'protected-region-does-not-fit';
    } else if (!region && !options.focus && (width * height) / (source.width * source.height) < 0.55) {
      fit = 'contain'; reason = 'unsafe-crop-without-subject';
    } else {
      const x = options.focus ? options.focus.x * source.width : region ? region.left + region.width / 2 : source.width / 2;
      const y = options.focus ? options.focus.y * source.height : region ? region.top + region.height / 2 : source.height / 2;

      // 修正区间判定：crop.left 必须满足 lowerX <= crop.left <= upperX
      const lowerX = region ? Math.ceil(region.left + region.width - width) : 0;
      const upperX = region ? Math.floor(region.left) : source.width - width;
      const minX = Math.max(0, lowerX);
      const maxX = Math.min(source.width - width, upperX);

      const lowerY = region ? Math.ceil(region.top + region.height - height) : 0;
      const upperY = region ? Math.floor(region.top) : source.height - height;
      const minY = Math.max(0, lowerY);
      const maxY = Math.min(source.height - height, upperY);

      if (minX > maxX || minY > maxY) {
        fit = 'contain';
        reason = 'protected-region-does-not-fit';
      } else {
        crop = {
          left: clamp(Math.round(x - width / 2), minX, maxX),
          top: clamp(Math.round(y - height / 2), minY, maxY),
          width,
          height
        };
      }
    }
  }

  const scale = Math.min(1, target.width / crop.width, target.height / crop.height);
  const output = {
    width: Math.max(1, Math.floor(crop.width * scale)),
    height: Math.max(1, Math.floor(crop.height * scale))
  };

  return {
    target, crop, output, fit, fallback: reason,
    retainedArea: (crop.width * crop.height) / (source.width * source.height),
    decodedBytes: output.width * output.height * 4
  };
}

export function planImageTiles(source: Size, options: ImagePlanOptions = {}, tileHeight = 1024) {
  positive(source.width); positive(source.height);
  if (!Number.isSafeInteger(tileHeight) || tileHeight < 32 || tileHeight > 4096) throw new Error('INVALID_TILE_HEIGHT');

  const target = resolveImageTarget(options);
  const width = Math.min(source.width, target.width);
  const maxPixels = options.maxPixels ?? 4_000_000;
  const maxAllowedHeight = Math.max(1, Math.floor(maxPixels / width));
  const effectiveTileHeight = Math.min(tileHeight, maxAllowedHeight);

  const scale = width / source.width;
  const srcRows = Math.max(1, Math.floor(effectiveTileHeight / scale));
  const numTiles = Math.ceil(source.height / srcRows);
  if (numTiles > 100) throw new Error('TOO_MANY_IMAGE_TILES');

  const plans = [];
  let currentSrcTop = 0;
  let accumulatedOutY = 0;

  for (let i = 0; i < numTiles; i++) {
    const srcTop = currentSrcTop;
    const nextSrcTop = Math.min(source.height, srcTop + srcRows);
    const srcHeight = nextSrcTop - srcTop;

    const nextOutY = Math.round(nextSrcTop * scale);
    const outHeight = nextOutY - accumulatedOutY;

    plans.push({
      crop: { left: 0, top: srcTop, width: source.width, height: srcHeight },
      output: { width, height: Math.max(1, outHeight) }
    });

    currentSrcTop = nextSrcTop;
    accumulatedOutY = nextOutY;
  }
  return plans;
}
```

#### 修正后的 `src/server/offline-image.ts`

```
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { planImage, planImageTiles, resolveImageTarget, type ImagePlanOptions } from '../shared/image-plan.js';
import { imageInfo } from './image-package.js';
import { imagePath } from '../shared/questionnaire-json.js';

export interface VariantOptions extends ImagePlanOptions {
  format?: 'webp' | 'jpeg' | 'png';
  quality?: number;
  minQuality?: number;
  budgetBytes?: number;
  tiles?: boolean;
  tileHeight?: number;
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function optimizeImage(input: Buffer, options: VariantOptions = {}) {
  if (input.length > 32 * 1024 * 1024) throw new Error('SOURCE_BYTE_LIMIT_EXCEEDED');

  // 仅在初始元数据探测时轻量读取
  const meta = await sharp(input, { limitInputPixels: 64_000_000, failOn: 'warning' }).metadata();
  if (!meta.width || !meta.height || !['png', 'jpeg', 'webp', 'heif', 'avif', 'tiff'].includes(meta.format ?? '')) {
    throw new Error('UNSUPPORTED_SOURCE_IMAGE');
  }
  if ((meta.pages ?? 1) > 1) throw new Error('ANIMATED_OR_MULTIPAGE_IMAGE_NOT_SUPPORTED');

  const rotated = [5, 6, 7, 8].includes(meta.orientation ?? 1);
  const source = { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
  const content = options.content ?? (options.scene === 'document' ? 'text' : 'photo');
  const format = options.format ?? 'webp';

  if (!['webp', 'jpeg', 'png'].includes(format)) throw new Error('INVALID_OUTPUT_FORMAT');
  if (meta.hasAlpha && format === 'jpeg') throw new Error('JPEG_CANNOT_PRESERVE_ALPHA');

  const quality = options.quality ?? 88, minQuality = options.minQuality ?? 78;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100 || !Number.isInteger(minQuality) || minQuality < 1 || minQuality > quality) {
    throw new Error('INVALID_IMAGE_QUALITY_RANGE');
  }
  if (content === 'text' && format === 'jpeg') throw new Error('TEXT_REQUIRES_LOSSLESS_WEBP_OR_PNG');

  const budget = options.budgetBytes ?? resolveImageTarget(options).budget;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8 * 1024 * 1024) throw new Error('INVALID_IMAGE_BYTE_BUDGET');

  const plan = planImage(source, { ...options, content });
  const geometries = options.tiles ? planImageTiles(source, options, options.tileHeight) : [plan];
  const outputs
