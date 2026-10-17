/**
 * Graphics wave 2, workstream A — local e2e config on a dedicated port.
 * The shared :4180 belongs to another workstream's preview server; this
 * config serves THIS worktree's dist on :4181 to avoid cross-talk.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4181',
    headless: true,
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'npx vite preview --port 4181 --strictPort',
    url: 'http://localhost:4181/player.html',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
