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

test('exports the page layout it renders, not the text view', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#export-pdf-button').click();
  await expect.poll(async () => page.evaluate(() => {
    const message = window.__showDocxTest.messages.findLast(
      (candidate) => candidate.type === 'exportPdf',
    );
    if (!message) {
      return null;
    }
    return {
      hasPages: /<section[^>]*class="[^"]*showdocx-visual/.test(message.html),
      hasGeneratedCss: message.html.includes('.showdocx-visual-wrapper'),
      hasPageRule: message.html.includes('@page { size: auto; margin: 0; }'),
      breaksPages: message.html.includes('page-break-after: always'),
      hasText: message.html.includes('ShowDocx Sample'),
      hasScript: /<script/i.test(message.html),
    };
  })).toEqual({
    hasPages: true,
    hasGeneratedCss: true,
    hasPageRule: true,
    breaksPages: true,
    hasText: true,
    hasScript: false,
  });
});

test('renders the page layout for an export started from Text mode', async ({ page }) => {
  // Visual mode has never been rendered here, so the exporter has to build it.
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#visual-container')).toBeHidden();

  await page.locator('#export-pdf-button').click();
  await expect.poll(async () => page.evaluate(() => {
    const message = window.__showDocxTest.messages.findLast(
      (candidate) => candidate.type === 'exportPdf',
    );
    return message ? /<section[^>]*class="[^"]*showdocx-visual/.test(message.html) : false;
  })).toBe(true);

  // The reader stays in Text mode: the render was for the export only.
  await expect(page.locator('#text-container')).toBeVisible();
  await expect(page.locator('#visual-container')).toBeHidden();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#error-state')).toBeHidden();
});

test('embeds images in the printable document rather than linking them', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-images.docx');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#export-pdf-button').click();
  await expect.poll(async () => page.evaluate(() => {
    const message = window.__showDocxTest.messages.findLast(
      (candidate) => candidate.type === 'exportPdf',
    );
    if (!message) {
      return null;
    }
    const sources = [...message.html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1]);
    return {
      count: sources.length,
      allInline: sources.every((source) => source.startsWith('data:')),
    };
  })).toEqual({ count: 1, allInline: true });
});

test('falls back to the text view when the page layout cannot be rendered', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=empty.docx&mode=text');
  await expect(page.locator('#zoom-frame')).toBeVisible();

  await page.evaluate(() => {
    // Stand in for a document docx-preview chokes on. It appends the rendered
    // wrapper here as its last step, so failing that fails both render attempts.
    document.getElementById('visual-container').appendChild = () => {
      throw new Error('visual render is unavailable');
    };
  });

  await page.locator('#export-pdf-button').click();
  await expect.poll(async () => page.evaluate(() => {
    const message = window.__showDocxTest.messages.findLast(
      (candidate) => candidate.type === 'exportPdf',
    );
    if (!message) {
      return null;
    }
    return {
      isTextExport: !message.html.includes('showdocx-visual'),
      isDocument: message.html.includes('<!DOCTYPE html>'),
    };
  })).toEqual({ isTextExport: true, isDocument: true });

  await expect(page.locator('#error-state')).toBeHidden();
});

test('renders repeatedly from one buffer', async ({ page }) => {
  // Every render and export shares currentBuffer. If docx-preview or mammoth
  // detached it, everything after the first consumer would fail on empty bytes.
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.getByRole('button', { name: 'Text' }).click();
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.getByRole('button', { name: 'HTML' }).click();
  await page.locator('#export-md-button').click();
  await page.locator('#export-pdf-button').click();

  await expect.poll(async () => page.evaluate(() => {
    const types = window.__showDocxTest.messages.map((message) => message.type);
    return ['exportHtml', 'exportMarkdown', 'exportPdf'].every((type) => types.includes(type));
  })).toBe(true);

  // Back to Visual: this re-reads the same buffer a fourth time.
  await page.getByRole('button', { name: 'Visual' }).click();
  await expect(page.locator('#visual-container section')).toBeVisible();
  await expect(page.locator('#error-state')).toBeHidden();
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

for (const mode of ['text', 'visual']) {
  test(`matches a phrase spanning inline formatting in ${mode} mode`, async ({ page }) => {
    const query = mode === 'text' ? '?mode=text' : '';
    await page.goto(`/scripts/webview-harness.html${query}`);
    await expect(page.locator('#zoom-frame')).toBeVisible();

    await page.locator('#search-toggle').click();
    // "includes" and "bold" sit in different runs: the phrase spans a <strong>.
    await page.locator('#search-input').fill('includes bold');

    await expect(page.locator('#search-count')).toHaveText('1/1');
    // One match, but one mark per text node it covers.
    await expect(page.locator('mark.showdocx-search-match')).toHaveCount(2);
    await page.locator('#search-next').click();
    await expect(page.locator('mark.showdocx-search-current')).toHaveCount(2);
  });
}

test('does not match text hidden from the reader', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-comments.docx');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#search-toggle').click();

  // The comment body and author live in a popover that is display:none until hover.
  await page.locator('#search-input').fill('Please clarify');
  await expect(page.locator('#search-count')).toHaveText('0/0');

  await page.locator('#search-input').fill('Alice Reviewer');
  await expect(page.locator('#search-count')).toHaveText('0/0');

  // Text the reader can actually see still matches.
  await page.locator('#search-input').fill('reviewer comment');
  await expect(page.locator('#search-count')).toHaveText('1/1');
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

test('lists one card per annotation with the real author', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-comments.docx');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#comments-toggle').click();
  await expect(page.locator('#comments-sidebar')).toBeVisible();

  // The fixture holds exactly one comment, one insertion and one deletion.
  await expect(page.locator('#comments-list .comment-card')).toHaveCount(3);
  await expect(page.locator('#comment-count')).toHaveText('3');

  const commentCard = page.locator('#comments-list .comment-comment');
  await expect(commentCard).toHaveCount(1);
  await expect(commentCard.locator('.comment-author')).toHaveText('Alice Reviewer');
  await expect(commentCard.locator('.comment-body')).toHaveText('Please clarify this sentence.');

  await expect(page.locator('#comments-list .comment-insertion .comment-body'))
    .toHaveText('an inserted phrase');
  await expect(page.locator('#comments-list .comment-deletion .comment-body'))
    .toHaveText('a deleted phrase');
});

test('leaves Ctrl+P to VS Code Quick Open', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.keyboard.press('Control+p');
  expect(await page.evaluate(() => window.__showDocxTest.printCount)).toBe(0);
});

test('warns that the text view shows tracked changes as accepted', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-comments.docx&mode=text');
  await expect(page.locator('#text-container')).toContainText('Reviewed Document');

  await expect(page.locator('#warnings-button')).toBeVisible();
  await page.locator('#warnings-button').click();
  await expect(page.locator('#warnings-panel')).toContainText('tracked changes');

  // The deleted phrase is genuinely absent from the text view — hence the warning.
  await expect(page.locator('#text-container')).not.toContainText('a deleted phrase');
});

test('shows the error state when a chunked transfer loses chunks', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?transfer=broken');

  await expect(page.locator('#error-state')).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#retry-button')).toBeVisible();
});

test('shows a user-safe error for corrupted documents', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=corrupted.docx');

  await expect(page.locator('#error-state')).toBeVisible();
  const message = page.locator('#error-message');
  await expect(message).not.toContainText(' at ');
  await expect(message).not.toContainText('node_modules');
});
