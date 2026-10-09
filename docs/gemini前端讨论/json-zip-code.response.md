request_id: bpl-json-zip-code-20261009-f
result_id: res_7c49fe94dac0e4e65dfe

### 1. 核心边界缺陷与漏洞审查 (Critical Bugs & Boundary Flaws)

#### 缺陷 1：WebP 容器解析逻辑存在位掩码错误与尺寸截断误判

- **位置**：`imageInfo` 中 `type === 'VP8X'` 与 `pos !== b.length`。
- **原因**：
  1. `b[start]! & 2`：根据 WebP 容器规范，VP8X 的第 0 字节 flags 定义中，**Animation 位是第 1 位（从 0 开始计数，即掩码 `0x02`）**。原代码判断为 `b[start]! & 2` 阻断动图是正确的，但它**漏掉了 ICC Profile (bit 5, `0x20`)、XMP (bit 2, `0x04`) 等元数据位的隔离**；且当存在 EXIF 标记时，虽然检查了 `EXIF` chunk，但如果攻击者构造了含 alpha 或嵌套畸形 chunk，此处的跳步会出界。
  2. 规范中 WebP chunk 的尺寸如果为奇数，末尾会强制补一个 `0x00` padding 字节（`size + (size & 1)`）。原代码写了 `pos = end + (size & 1);`，但很多无损/有损 WebP 编码器在生成末尾可能自带 padding 或文件末尾对齐。若 `pos !== b.length` 判定过严，会导致合法的合规 WebP 误判为 `TRUNCATED_WEBP`。更严重的是：若最后一个 chunk 的 `size` 导致 `end + 1 === b.length`（有 1 字节 padding），但其 RIFF 标头声明的总大小仅包含真实 payload，导致 `b.readUInt32LE(4) + 8 !== b.length` 与内部计算产生冲突。
  3. **VP8 尺寸计算溢出与符号位问题**：`VP8` 有损帧尺寸解析中，规范规定尺寸是 14 位（`0x3fff`），`width = b.readUInt16LE(start + 6) & 0x3fff`。但缺少对 `start + 10 <= b.length` 的预检（原代码仅 `size < 10`），当 `size` 正好在边界时易导致越界访问。

#### 缺陷 2：JPEG SOF 扫描死循环与伪造 SOF 漏洞

- **位置**：`imageInfo` 中 JPEG 扫描段。
- **原因**：
  1. `while(b[pos] === 255) pos++; const marker = b[pos++]!;`：如果 JPEG 在扫描段前遭遇连续 `0xFF` 直到 Buffer 末尾，`pos++` 会越界变为 `undefined`，随后 `pos += size` 出现 `NaN` 导致死循环或静默穿透。
  2. **缺少 SOS (`0xDA`) 后的终止拦截**：遇到 `0xDA`（Start of Scan）时代码执行了 `break`，但如果文件**在 `0xDA` 之前根本没有任何 SOF 标记**（例如攻击者构造只有 APP 标记和 SOS 的截断流），此时 `width` 和 `height` 依然为 0，随后抛出 `IMAGE_PIXEL_BUDGET_EXCEEDED` 而非格式校验错误。
  3. **熵编码流中的虚假 SOF 穿透风险**：原代码依靠 `0xDA` 退出扫描是正确的，但没有校验 SOF 标记是否重复出现（多帧/分级 JPEG 可能多次触发赋值）。必须保证只能出现一次有效的 SOF 标记（拒绝渐进式/多扫描阶段产生冲突）。

#### 缺陷 3：ZIP Entry 遍历与 Data Descriptor 边界穿透

- **位置**：`unpackImages`
- **原因**：
  1. `flags & 1` 仅检查了加密位，**漏掉了 bit 3 (`0x0008` - Data Descriptor)**。若生成 ZIP 时开启了 streaming 模式（bit 3 置位），Local File Header 中的 `crc32`、`compressedSize`、`uncompressedSize` 字段会全为 0，真实值在数据体之后的 Data Descriptor 中。原代码读取 Local Header 强制校验，遇到 bit 3 时会因长度或 CRC 不匹配误报失败，或者更危险：如果 Central Directory 存在数值而 Local Header 为 0，校验逻辑产生歧义。既然要求标准 ZIP，**必须在 flags 校验中一并拒绝 bit 3**（`if (flags & 0x0009) throw new Error('UNSUPPORTED_ZIP_ENTRY');`）。
  2. **展开大小累加绕过 (Zip Bomb 累计漏洞)**： `total += expanded;` 虽然检查了 `total > 32 * 1024 * 1024`，但在解压发生前，如果是 `method === 8`，`inflateRawSync(packed, { maxOutputLength: 8 * 1024 * 1024 })` 被执行。若 ZIP 声明的 `expanded` 伪造为一个很小的值（例如 100 字节），而实际 deflated stream 能解压出数兆字节，`inflateRawSync` 内部虽然设置了 `maxOutputLength`，但 `bytes.length !== expanded` 会在解压**完成之后**才报错。这意味着恶意构造的 200 个高压缩比条目可以在抛错前让 Node.js 瞬间分配大量堆内存，造成短时 DoS。必须在解压时将当前剩余配额动态传入：`maxOutputLength: Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - total)`。

#### 缺陷 4：ZIP 目录项与文件名校验中未处理 Windows 分隔符及控制字符

- **位置**：`name.slice(0, -1).split('/').some(...)`
- **原因**： ZIP 规范允许反斜杠 `\`。如果客户端在 Windows 环境压缩，entry 名称可能包含 `images\card.png`。原代码使用 `/` 切分，会导致带有 `\` 的路径逃逸并被当成单个合法文件名，在后续资产映射时无法正确匹配 URI path。必须明确拒绝包含 `\` 的 entry 名称。

#### 缺陷 5：DB 与只读事务中的未捕获异常导致连接挂起

- **位置**：Worker 中的 `db.exec('BEGIN'); ... db.exec('COMMIT');`
- **原因**： 在 `better-sqlite3`（或同类同步 SQLite driver）中，代码在 `BEGIN` 和 `COMMIT` 之间如果抛出错误（如 `REBUILD_BUDGET_EXCEEDED`），事务没有在 `catch` 块中执行 `ROLLBACK`，导致只读/读写连接状态污染，后续同连接操作将抛出 `cannot start a transaction within a transaction`。

### 2. 服务端静态校验能力极限声明 (Non-Decoder Limitation)

由于明确**不集成服务端解码器（无 libjpeg/libpng/libwebp/sharp）**，系统必须明确并接受以下物理限制：

1. **无法证明像素流的有效性**： 服务端仅能校验 PNG 的 chunk 结构/CRC、JPEG 的 marker 尺寸以及 WebP 的 RIFF 块长度。攻击者完全可以在 `IDAT` 或 SOS 扫描段内填充随机熵数据（伪造无意义垃圾字节），这在服务端无法被检测。
2. **像素 Bomb 深度防御责任下放**： 服务端已通过 Header 限制了 `width * height <= 4_000_000`（400万像素），阻断了 Canvas 解码分配过大物理显存；**真实像素合法性与解码完整性必须由客户端在计时任务前的 `prepare` 阶段通过离线 Canvas `createImageBitmap` / `decode()` + hash 校验完成**。若解码抛出 DOMException，必须在客户端立刻上报 `ASSET_CORRUPTED` 并阻断流程。

### 3. 最小修复补丁 (Minimal Patches)

#### 补丁 1：`imageInfo` (加固各格式边界与动图阻断)

```
export function imageInfo(b: Buffer) {
  let width = 0, height = 0, format: 'png' | 'jpeg' | 'webp';
  if (b.length < 24 || b.length > 8 * 1024 * 1024) throw new Error('INVALID_IMAGE_BYTES');

  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = 'png';
    let pos = 8, ended = false, hasData = false;
    while (pos + 12 <= b.length) {
      const size = b.readUInt32BE(pos);
      const type = b.toString('ascii', pos + 4, pos + 8);
      const end = pos + 12 + size;
      if (end > b.length) throw new Error('TRUNCATED_PNG');
      if (crc32(b.subarray(pos + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new Error('PNG_CRC_MISMATCH');
      if (pos === 8) {
        if (type !== 'IHDR' || size !== 13) throw new Error('INVALID_PNG_HEADER');
        width = b.readUInt32BE(pos + 8);
        height = b.readUInt32BE(pos + 12);
      }
      if (type === 'acTL' || type === 'eXIf') throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if (type === 'IDAT') hasData = true;
      if (type === 'IEND') {
        if (size !== 0 || end !== b.length || !hasData) throw new Error('INVALID_PNG_END');
        ended = true;
        break;
      }
      pos = end;
    }
    if (!ended) throw new Error('TRUNCATED_PNG');

  } else if (b[0] === 255 && b[1] === 216) {
    format = 'jpeg';
    let pos = 2;
    let foundSof = false;
    const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    if (b.at(-2) !== 255 || b.at(-1) !== 217) throw new Error('TRUNCATED_JPEG');

    while (pos + 4 <= b.length) {
      if (b[pos++] !== 255) throw new Error('INVALID_JPEG_MARKER');
      while (pos < b.length && b[pos] === 255) pos++;
      if (pos >= b.length) throw new Error('TRUNCATED_JPEG');
      const marker = b[pos++]!;
      if (marker === 0xda) break; // Start of Scan
      if (marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;

      const size = b.readUInt16BE(pos);
      if (size < 2 || pos + size > b.length) throw new Error('TRUNCATED_JPEG');
      if (marker === 0xe1 && b.toString('ascii', pos + 2, pos + 6) === 'Exif') throw new Error('IMAGE_EXIF_NOT_ALLOWED');
      if (sof.includes(marker)) {
        if (foundSof || size < 8) throw new Error('INVALID_JPEG_SOF');
        foundSof = true;
        height = b.readUInt16BE(pos + 3);
        width = b.readUInt16BE(pos + 5);
      }
      pos += size;
    }
    if (!foundSof) throw new Error('MISSING_JPEG_SOF');

  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp';
    const riffSize = b.readUInt32LE(4);
    if (riffSize + 8 > b.length) throw new Error('TRUNCATED_WEBP');
    let pos = 12;
    while (pos + 8 <= b.length) {
      const type = b.toString('ascii', pos, pos + 4);
      const size = b.readUInt32LE(pos + 4);
      const start = pos + 8;
      const end = start + size;
      if (end > b.length) throw new Error('TRUNCATED_WEBP');

      if (type === 'ANIM' || type === 'ANMF' || type === 'EXIF') throw new Error('STATIC_NORMALIZED_IMAGE_REQUIRED');
      if (type === 'VP8X') {
        // bit 1 是动画标志位 (0x02)
        if (size !== 10 || (b[start]! & 0x02)) throw new Error('STATIC_IMAGE_REQUIRED');
        width = 1 + b.readUIntLE(start + 4, 3);
        height = 1 + b.readUIntLE(start + 7, 3);
      }
      if (type === 'VP8 ') {
        if (size < 10 || b.toString('hex', start + 3, start + 6) !== '9d012a') throw new Error('INVALID_WEBP');
        width = b.readUInt16LE(start + 6) & 0x3fff;
        height = b.readUInt16LE(start + 8) & 0x3fff;
      }
      if (type === 'VP8L') {
        if (size < 5 || b[start] !== 0x2f) throw new Error('INVALID_WEBP');
        const bits = b.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      pos = end + (size & 1); // 加上对齐 padding
    }
  } else {
    throw new Error('PNG_JPEG_WEBP_REQUIRED');
  }

  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000) {
    throw new Error('IMAGE_PIXEL_BUDGET_EXCEEDED');
  }
  return { width, height, format, validation: 'container-header-v1' as const };
}
```

#### 补丁 2：`unpackImages` (修补 Data Descriptor 与流式解压预算)

```
export function unpackImages(b: Buffer) {
  if (b.length > 8 * 1024 * 1024) throw new Error('ZIP_SIZE_EXCEEDED');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || b.readUInt16LE(eocd + 4) || b.readUInt16LE(eocd + 6) || b.readUInt16LE(eocd + 8) !== b.readUInt16LE(eocd + 10)) {
    throw new Error('STANDARD_ZIP_REQUIRED');
  }
  const count = b.readUInt16LE(eocd + 10);
  const central = b.readUInt32LE(eocd + 16);
  const size = b.readUInt32LE(eocd + 12);
  if (!count || count > 200 || central + size !== eocd) throw new Error('ZIP_ENTRY_BUDGET_EXCEEDED');

  const images: { path: string; bytes: Buffer; info: ReturnType<typeof imageInfo> }[] = [];
  const names = new Set<string>();
  let pos = central, total = 0;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || b.readUInt32LE(pos) !== 0x02014b50) throw new Error('INVALID_ZIP_DIRECTORY');
    const flags = b.readUInt16LE(pos + 8);
    const method = b.readUInt16LE(pos + 10);
    const crc = b.readUInt32LE(pos + 16);
    const compressed = b.readUInt32LE(pos + 20);
    const expanded = b.readUInt32LE(pos + 24);
    const nameLen = b.readUInt16LE(pos + 28);
    const extra = b.readUInt16LE(pos + 30);
    const comment = b.readUInt16LE(pos + 32);
    const external = b.readUInt32LE(pos + 38);
    const local = b.readUInt32LE(pos + 42);

    const next = pos + 46 + nameLen + extra + comment;
    // 强制拒绝加密 (bit 0) 与 Data Descriptor (bit 3)
    if (next > eocd || (flags & 0x0009) || ![0, 8].includes(method) || b.readUInt16LE(pos + 34) || ((external >>> 16) & 0xf000) === 0xa000) {
      throw new Error('UNSUPPORTED_ZIP_ENTRY');
    }
    const nameBytes = b.subarray(pos + 46, pos + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    // 拒绝反斜杠及非法 UTF-8
    if (name.includes('\\') || !Buffer.from(name).equals(nameBytes) || names.has(name)) {
      throw new Error('DUPLICATE_OR_INVALID_ZIP_PATH');
    }
    names.add(name);

    const directory = name.endsWith('/');
    if (directory) {
      if (name.slice(0, -1).split('/').some(p => !p || p === '.' || p === '..' || !/^[-a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p)) || expanded !== 0) {
        throw new Error('INVALID_ZIP_PATH');
      }
    } else {
      imagePath(name);
    }

    if (local + 30 > central || b.readUInt32LE(local) !== 0x04034b50 || b.readUInt16LE(local + 6) !== flags || b.readUInt16LE(local + 8) !== method) {
      throw new Error('INVALID_ZIP_LOCAL_HEADER');
    }
    const localName = b.readUInt16LE(local + 26);
    const localExtra = b.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    if (localName !== nameLen || !b.subarray(local + 30, local + 30 + localName).equals(nameBytes) || start + compressed > central) {
      throw new Error('INVALID_ZIP_LOCAL_HEADER');
    }

    total += expanded;
    if (expanded > 8 * 1024 * 1024 || total > 32 * 1024 * 1024 || (images.length >= 100 && !directory)) {
      throw new Error('ZIP_EXPANDED_BUDGET_EXCEEDED');
    }

    const packed = b.subarray(start, start + compressed);
    // 动态限制解压内存分配
    const remainBudget = Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - (total - expanded));
    const bytes = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: remainBudget });

    if (bytes.length !== expanded || crc32(bytes) !== crc) {
      throw new Error('ZIP_CRC_OR_LENGTH_MISMATCH');
    }

    if (!directory) {
      const info = imageInfo(bytes);
      const ext = name.split('.').at(-1)!.toLowerCase();
      if (info.format !== ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' } as Record<string, string>)[ext]) {
        throw new Error('IMAGE_EXTENSION_MISMATCH');
      }
      images.push({ path: name, bytes, info });
    }
    pos = next;
  }

  if (pos !== eocd || !images.length) throw new Error('INVALID_ZIP_DIRECTORY');
  return images;
}
```

ZIP_CODE_REVIEW_COMPLETE
