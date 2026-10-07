import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// Built in two single-file passes (singlefile requires one input per build):
//   vite build --mode player  → dist/player.html  (self-contained game runtime / export template)
//   vite build --mode studio  → dist/index.html   (studio UI; loads player.html in an iframe)
// Both passes share dist/. emptyOutDir is deliberately false: export.ts
// auto-builds the player bundle when dist/player.html is missing, and wiping
// dist/ there silently deleted the studio build (QA X1). Run `npm run clean`
// for an explicit wipe.
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
    emptyOutDir: false, // see note above: never wipe the sibling bundle (QA X1)
    rollupOptions: {
      input: mode === 'studio' ? path.resolve(__dirname, 'index.html') : path.resolve(__dirname, 'player.html'),
    },
  },
  plugins: [viteSingleFile()],
  server: { port: 5180 },
}));
