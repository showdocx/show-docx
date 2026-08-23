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
  await expect.poll(async () => page.evaluate(() => (
    window.__showDocxTest.messages.some((message) => message.type === 'exportPdf')
  ))).toBe(true);
});

test('exports Markdown and PDF', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.locator('#export-md-button').click();
  await expect.poll(async () => page.evaluate(() => (
    window.__showDocxTest.messages.some((message) => (
      message.type === 'exportMarkdown'
      && typeof message.markdown === 'string'
      && message.markdown.includes('ShowDocx Sample')
    ))
  ))).toBe(true);

  await page.locator('#export-pdf-button').click();
  await expect.poll(async () => page.evaluate(() => (
    window.__showDocxTest.messages.some((message) => (
      message.type === 'exportPdf'
      && typeof message.html === 'string'
      && message.html.includes('ShowDocx Sample')
    ))
  ))).toBe(true);
});

test('finds and navigates search matches in document', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  // Open search bar using the search toggle button
  await page.locator('#search-toggle').click();
  await expect(page.locator('#search-bar')).toBeVisible();

  // Search for "Sample"
  await page.locator('#search-input').fill('Sample');
  await expect(page.locator('#search-count')).not.toHaveText('0/0');
  await expect(page.locator('mark.showdocx-search-match')).toBeVisible();

  // Navigate matches
  await page.locator('#search-next').click();
  await expect(page.locator('mark.showdocx-search-current')).toBeVisible();

  // Close search with close button
  await page.locator('#search-close').click();
  await expect(page.locator('#search-bar')).toBeHidden();
  await expect(page.locator('mark.showdocx-search-match')).toHaveCount(0);
});

test('extracts outline and navigates headings', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-headings.docx&mode=text');
  await expect(page.locator('#text-container')).toContainText('Main Document Title');

  // Toggle outline panel
  await page.locator('#outline-toggle').click();
  await expect(page.locator('#outline-sidebar')).toBeVisible();

  // Verify outline contains extracted headings
  await expect(page.locator('#outline-list .outline-item')).toHaveCount(5);
  await expect(page.locator('#outline-list')).toContainText('Chapter 1: Getting Started');
  await expect(page.locator('#outline-list')).toContainText('1.1 Installation');

  // Click on a heading
  await page.locator('#outline-list .outline-item', { hasText: '1.1 Installation' }).click();
  await expect(page.locator('#outline-list .outline-item.active')).toContainText('1.1 Installation');

  // Close outline
  await page.locator('#outline-close').click();
  await expect(page.locator('#outline-sidebar')).toBeHidden();
});

test('toggles comments sidebar and views notes', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  // Toggle comments panel
  await page.locator('#comments-toggle').click();
  await expect(page.locator('#comments-sidebar')).toBeVisible();

  // When no comments exist
  await expect(page.locator('#comments-sidebar')).toContainText('No comments or tracked changes');

  // Close comments
  await page.locator('#comments-close').click();
  await expect(page.locator('#comments-sidebar')).toBeHidden();
});

test('shows a user-safe error for corrupted documents', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=corrupted.docx');

  await expect(page.locator('#error-state')).toBeVisible();
  const message = page.locator('#error-message');
  await expect(message).not.toContainText(' at ');
  await expect(message).not.toContainText('node_modules');
});
