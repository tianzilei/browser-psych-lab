import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root, loadEnv } from './lib.mjs';

loadEnv();
const commands = [
  [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', 'src/server/main.ts'],
  [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts'],
];
const groupSignals = process.platform !== 'win32';
const children = commands.map(args => spawn(process.execPath, args, {
  cwd: root, env: process.env, stdio: 'inherit', detached: groupSignals,
}));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (groupSignals && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const child of children) {
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}
