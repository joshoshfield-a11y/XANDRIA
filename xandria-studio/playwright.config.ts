import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4180',
    headless: true,
    launchOptions: {
      // No executablePath: use Playwright's bundled Chromium (CI installs it).
      // Override locally with CHROMIUM_PATH only if you know what you're doing.
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
    command: 'npx vite preview --port 4180 --strictPort',
    url: 'http://localhost:4180/player.html',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
