import { defineConfig } from '@playwright/test';

const port = Number(process.env.SHOWDOCX_WEBVIEW_TEST_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/webview',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // A retry is there to tell a flaky test from a broken one, not to pass it.
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: 'line',
  timeout: 30_000,
  use: {
    baseURL: origin,
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node ./scripts/serve-webview.mjs',
    env: { ...process.env, PORT: String(port) },
    url: `${origin}/scripts/webview-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
