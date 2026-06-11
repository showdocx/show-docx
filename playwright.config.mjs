import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/webview',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node ./scripts/serve-webview.mjs',
    url: 'http://127.0.0.1:4173/scripts/webview-harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
