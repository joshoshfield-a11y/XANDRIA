import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// Built in two single-file passes (singlefile requires one input per build):
//   vite build --mode player  → dist/player.html  (self-contained game runtime / export template)
//   vite build --mode studio  → dist/index.html   (studio UI; loads player.html in an iframe)
export default defineConfig(({ mode }) => ({
  base: './',
  resolve: {
    alias: {
      '@spec': path.resolve(__dirname, 'src/spec/index.ts'),
      '@engine': path.resolve(__dirname, 'src/engine'),
      '@blueprints': path.resolve(__dirname, 'src/blueprints'),
      '@generator': path.resolve(__dirname, 'src/generator'),
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
    assetsInlineLimit: 100_000_000,
    emptyOutDir: mode === 'player',
    rollupOptions: {
      input: mode === 'studio' ? path.resolve(__dirname, 'index.html') : path.resolve(__dirname, 'player.html'),
    },
  },
  plugins: [viteSingleFile()],
  server: { port: 5180 },
}));
