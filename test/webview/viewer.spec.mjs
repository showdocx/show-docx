import { expect, test } from '@playwright/test';

test('renders visual and text modes and updates zoom', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');

  await expect(page.locator('#visual-container section')).toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('simple.docx');

  await page.getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('#zoom-reset')).toHaveText('110%');
});

test('reassembles chunked transfers', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?transfer=chunks&mode=text');

  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#loading')).toBeHidden();
});

test('exports sanitized HTML and invokes print', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.getByRole('button', { name: 'HTML' }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__showDocxTest.messages.some((message) => (
      message.type === 'exportHtml'
      && message.html.includes('<!DOCTYPE html>')
      && message.html.includes('ShowDocx Sample')
      && !message.html.includes('<script')
    ))
  ))).toBe(true);

  await page.getByRole('button', { name: 'Print' }).click();
  await expect.poll(async () => page.evaluate(() => window.__showDocxTest.printCount)).toBe(1);
});

test('shows a user-safe error for corrupted documents', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=corrupted.docx');

  await expect(page.locator('#error-state')).toBeVisible();
  const message = page.locator('#error-message');
  await expect(message).not.toContainText(' at ');
  await expect(message).not.toContainText('node_modules');
});
