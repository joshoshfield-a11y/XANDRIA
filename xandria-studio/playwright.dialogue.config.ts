import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Dialogue-branching e2e config: serves THIS worktree's player build on
// port 4182 so it never collides with (or reuses) another session's
// preview server on 4180/4181.
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:4182' },
  webServer: {
    command: 'npx vite preview --port 4182 --strictPort',
    url: 'http://localhost:4182/player.html',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
