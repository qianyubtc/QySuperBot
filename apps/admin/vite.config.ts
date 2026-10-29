import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'browser-only-demo',
      enforce: 'pre',
      resolveId(source, importer) {
        if (mode !== 'demo' || !importer?.includes('/apps/admin/src/')) return;
        const modules: Record<string, string> = {
          './api': 'api.ts',
          './BinanceLogin': 'BinanceLogin.tsx',
          './QQLogin': 'QQLogin.tsx',
        };
        if (modules[source])
          return fileURLToPath(new URL('./src/demo/' + modules[source], import.meta.url));
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
    proxy: mode === 'demo' ? undefined : { '/api': `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
  build: { outDir: mode === 'demo' ? '../../dist/demo' : '../../dist/admin', emptyOutDir: true },
}));
