import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    manifest: true,
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: { input: {
      index: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
      diagnostics: fileURLToPath(new URL('./src/web/diagnostics.html', import.meta.url)),
      admin: fileURLToPath(new URL('./src/web/admin.html', import.meta.url)),
      simulate: fileURLToPath(new URL('./src/web/simulate.html', import.meta.url)),
      participate: fileURLToPath(new URL('./src/web/participate.html', import.meta.url)),
      run: fileURLToPath(new URL('./src/web/run.html', import.meta.url)),
      p0: fileURLToPath(new URL('./src/web/p0.html', import.meta.url)),
    } },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
});
