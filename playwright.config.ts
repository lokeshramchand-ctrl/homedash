import { defineConfig } from '@playwright/test';

// Smoke tests drive the real built UI against a running backend (see e2e/README.md).
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_URL ?? 'http://127.0.0.1:3911',
    channel: process.env.E2E_CHANNEL || undefined,
    screenshot: 'only-on-failure',
  },
});
