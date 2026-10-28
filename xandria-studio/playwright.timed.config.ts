import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Timed-quests wave e2e config: serves THIS worktree's player build on
// port 4183 so it never collides with (or reuses) another session's
// preview server (quests config uses 4181, radiant uses 4182).
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:4183' },
  webServer: {
    command: 'npx vite preview --port 4183 --strictPort',
    url: 'http://localhost:4183/player.html',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
