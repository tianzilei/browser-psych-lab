import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { root } from './lib.mjs';

const gz = promisify(gzip);
const br = promisify(brotliCompress);
const directory = resolve(root, 'dist/web/assets');
let count = 0;
// Build-time compression of public bundles only. Research storage is excluded.
for (const name of await readdir(directory)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const path = resolve(directory, name);
  const bytes = await readFile(path);
  await writeFile(`${path}.gz`, await gz(bytes, { level: 9 }));
  await writeFile(`${path}.br`, await br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
  count++;
}
console.log(`Precompressed ${count} public JS/CSS bundles (gzip + brotli).`);
