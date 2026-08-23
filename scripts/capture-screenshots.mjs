import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const artifactsDir = 'C:\\Users\\canca\\.gemini\\antigravity-ide\\brain\\02558cdb-ea22-4740-9edd-5c56d90d0684';
await mkdir(artifactsDir, { recursive: true });

// Start test server
const server = spawn('node', ['./scripts/serve-webview.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '4173' },
});

// Wait for server
await setTimeout(1500);

try {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  });

  // 1. Overview with new toolbar
  const page1 = await context.newPage();
  await page1.goto('http://127.0.0.1:4173/scripts/webview-harness.html?mode=text');
  await page1.waitForSelector('#text-container h1');
  await page1.screenshot({ path: join(artifactsDir, 'preview_toolbar.png') });
  console.log('Saved preview_toolbar.png');

  // 2. In-document Search active
  const page2 = await context.newPage();
  await page2.goto('http://127.0.0.1:4173/scripts/webview-harness.html?mode=text');
  await page2.waitForSelector('#text-container h1');
  await page2.locator('#search-toggle').click();
  await page2.locator('#search-input').fill('Sample');
  await page2.waitForSelector('mark.showdocx-search-match');
  await page2.screenshot({ path: join(artifactsDir, 'preview_search.png') });
  console.log('Saved preview_search.png');

  // 3. Outline / Table of Contents sidebar
  const page3 = await context.newPage();
  await page3.goto('http://127.0.0.1:4173/scripts/webview-harness.html?fixture=with-headings.docx&mode=text');
  await page3.waitForSelector('#text-container h1');
  await page3.locator('#outline-toggle').click();
  await page3.waitForSelector('#outline-list .outline-item');
  await page3.locator('#outline-list .outline-item').nth(2).click();
  await page3.screenshot({ path: join(artifactsDir, 'preview_outline.png') });
  console.log('Saved preview_outline.png');

  // 4. Comments sidebar
  const page4 = await context.newPage();
  await page4.goto('http://127.0.0.1:4173/scripts/webview-harness.html?mode=text');
  await page4.waitForSelector('#text-container h1');
  await page4.locator('#comments-toggle').click();
  await page4.waitForSelector('#comments-sidebar');
  await page4.screenshot({ path: join(artifactsDir, 'preview_comments.png') });
  console.log('Saved preview_comments.png');

  await browser.close();
} finally {
  server.kill();
}
