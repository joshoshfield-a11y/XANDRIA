import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@spec': path.resolve(__dirname, 'src/spec/index.ts'),
      '@engine': path.resolve(__dirname, 'src/engine'),
      '@blueprints': path.resolve(__dirname, 'src/blueprints'),
      '@generator': path.resolve(__dirname, 'src/generator'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
});
