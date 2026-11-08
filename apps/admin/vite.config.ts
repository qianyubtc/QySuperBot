import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const src = fileURLToPath(new URL('./src/', import.meta.url));
// Modules the browser demo replaces, matched by the file they resolve to so that pages in
// subfolders ('../api') are swapped as reliably as root modules ('./api').
const demoModules: Record<string, string> = {
  [resolve(src, 'api')]: 'api.ts',
  [resolve(src, 'BinanceLogin')]: 'BinanceLogin.tsx',
  [resolve(src, 'QQLogin')]: 'QQLogin.tsx',
};

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'browser-only-demo',
      enforce: 'pre',
      resolveId(source, importer) {
        if (mode !== 'demo' || !importer || !source.startsWith('.')) return;
        if (!importer.startsWith(src) || importer.startsWith(resolve(src, 'demo'))) return;
        const target = demoModules[resolve(dirname(importer), source).replace(/\.tsx?$/, '')];
        if (target) return resolve(src, 'demo', target);
      },
      generateBundle() {
        if (mode !== 'demo') return;
        this.emitFile({ type: 'asset', fileName: '_redirects', source: '/* /index.html 200\n' });
        this.emitFile({
          type: 'asset',
          fileName: '_headers',
          source:
            "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n",
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.ADMIN_PORT ?? 5174),
    strictPort: true,
    // The Binance login window streams its screen and accepts input over a WebSocket under /api;
    // without `ws` the dev proxy answers the upgrade itself and the window never connects.
    proxy:
      mode === 'demo'
        ? undefined
        : { '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 3000}`, ws: true } },
  },
  build: { outDir: mode === 'demo' ? '../../dist/demo' : '../../dist/admin', emptyOutDir: true },
}));
