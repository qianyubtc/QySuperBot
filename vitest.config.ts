import { defineConfig } from 'vitest/config';

// Component tests run in a real DOM (jsdom) through Vite, so JSX, CSS imports and asset handling
// behave the same way as the console that ships. Server tests stay on node:test.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['apps/admin/test/**/*.test.tsx'],
    setupFiles: ['apps/admin/test/setup.ts'],
  },
});
