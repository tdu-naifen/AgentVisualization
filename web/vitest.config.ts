import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirror tsconfig's `@/* -> ./src/*` path mapping so test files can import the
// code under test exactly the way the app does (e.g. `@/lib/trace`). Without this
// alias vitest cannot resolve `@/…` specifiers and every import fails at load.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
});
