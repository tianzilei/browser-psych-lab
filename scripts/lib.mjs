import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const run = promisify(execFile);
export function loadEnv() {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
export function fail(error) {
  // Do not echo command arguments or database credentials from subprocess errors.
  console.error(error.message?.split('\n')[0] ?? 'Operation failed.');
  process.exitCode = 1;
}
