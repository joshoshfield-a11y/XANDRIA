import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Quest-wave e2e config: serves THIS worktree's player build on port 4181
// so it never collides with (or reuses) another session's preview server
// on 4180.
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:4181' },
  webServer: {
    command: 'npx vite preview --port 4181 --strictPort',
    url: 'http://localhost:4181/player.html',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
