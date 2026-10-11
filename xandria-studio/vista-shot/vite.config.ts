import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@spec': path.resolve(__dirname, '../src/spec/index.ts'),
      '@engine': path.resolve(__dirname, '../src/engine'),
      '@blueprints': path.resolve(__dirname, '../src/blueprints'),
      '@generator': path.resolve(__dirname, '../src/generator'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
