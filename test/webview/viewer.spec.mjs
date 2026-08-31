import { expect, test } from '@playwright/test';

test('renders visual and text modes and updates zoom', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');

  await expect(page.locator('#visual-container section')).toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('simple.docx');

  await page.locator('#mode-text').click();
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
  // The Markdown itself is produced in the host, which holds the bytes; this
  // side only asks for it. Its content is covered by the host's own tests.
  await expect.poll(async () => page.evaluate(() => (
    window.__showDocxTest.messages.some((message) => message.type === 'exportMarkdown')
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

  await page.locator('#mode-text').click();
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await page.getByRole('button', { name: 'HTML' }).click();
  await page.locator('#export-md-button').click();
  await page.locator('#export-pdf-button').click();

  await expect.poll(async () => page.evaluate(() => {
    const types = window.__showDocxTest.messages.map((message) => message.type);
    return ['exportHtml', 'exportMarkdown', 'exportPdf'].every((type) => types.includes(type));
  })).toBe(true);

  // Back to Visual: this re-reads the same buffer a fourth time.
  await page.locator('#mode-visual').click();
  await expect(page.locator('#visual-container section')).toBeVisible();
  await expect(page.locator('#error-state')).toBeHidden();
});

test('asks the host to copy, rather than converting a second time here', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#copy-md-button').click();
  await page.locator('#copy-text-button').click();
  await page.locator('#export-md-button').click();

  // The host holds the bytes and owns the converter, so these carry no payload:
  // one document must not have two different Markdown answers.
  await expect.poll(async () => page.evaluate(() => window.__showDocxTest.messages
    .filter((message) => ['copyMarkdown', 'copyText', 'exportMarkdown'].includes(message.type))
    .map((message) => `${message.type}:${Object.keys(message).length}`)))
    .toEqual(['copyMarkdown:1', 'copyText:1', 'exportMarkdown:1']);
});

test('fits the page to the panel and holds the fit as it is resized', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  const fitted = async () => page.evaluate(() => {
    const element = document.getElementById('viewport');
    const sheet = document.querySelector('section.showdocx-visual').getBoundingClientRect();
    const view = element.getBoundingClientRect();
    const left = Math.round(sheet.left - view.left);
    const right = Math.round(view.right - sheet.right);
    return { left, right, overflows: element.scrollWidth > element.clientWidth };
  });

  await page.locator('#fit-button').click();
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-label', /Fit width/);

  const wide = await fitted();
  expect(wide.overflows).toBe(false);
  expect(Math.abs(wide.left - wide.right)).toBeLessThanOrEqual(2);
  const wideZoom = await page.locator('#zoom-reset').textContent();

  // Narrowing the panel has to refit, not leave the page at the old width.
  await page.setViewportSize({ width: 650, height: 800 });
  await expect
    .poll(async () => page.locator('#zoom-reset').textContent())
    .not.toBe(wideZoom);
  const narrow = await fitted();
  expect(narrow.overflows).toBe(false);
  expect(Math.abs(narrow.left - narrow.right)).toBeLessThanOrEqual(2);
});

test('fits a whole page within the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#fit-button').click();
  await page.locator('#fit-button').click();
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-label', /Fit page/);

  const layout = await page.evaluate(() => {
    const element = document.getElementById('viewport');
    const sheet = document.querySelector('section.showdocx-visual').getBoundingClientRect();
    return { pageHeight: sheet.height, viewportHeight: element.clientHeight };
  });
  expect(layout.pageHeight).toBeLessThanOrEqual(layout.viewportHeight);

  // The third click returns to a plain 100%.
  await page.locator('#fit-button').click();
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
});

test('zooms with Ctrl and the wheel, which ends the fit', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#fit-button').click();
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-label', /Fit width/);

  await page.mouse.move(500, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');

  // A zoom the reader chose replaces the fit, rather than being undone by it.
  await expect(page.locator('#zoom-reset')).not.toHaveText('100%');
  await expect(page.locator('#fit-button')).toHaveAttribute('aria-label', /click for fit width/);
});

test('hides the fit control where it would do nothing', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#fit-button')).toBeHidden();

  await page.locator('#mode-visual').click();
  await expect(page.locator('#fit-button')).toBeVisible();
});

test('fills the editor height whatever the document is', async ({ page }) => {
  // A short document in Text mode is where this showed: the app shell declared
  // three grid rows for children of which only two are ever in flow, so the
  // main area took its content height and left the rest of the editor empty.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/scripts/webview-harness.html?fixture=with-images.docx&mode=text');
  await expect(page.locator('#text-container')).toContainText('Embedded Image');
  await page.locator('#outline-toggle').click();
  await expect(page.locator('#outline-sidebar')).toBeVisible();

  const layout = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const main = document.querySelector('.showdocx-main-area').getBoundingClientRect();
    const sidebar = document.getElementById('outline-sidebar').getBoundingClientRect();
    return {
      unusedBelow: Math.round(app.bottom - main.bottom),
      mainHeight: Math.round(main.height),
      sidebarHeight: Math.round(sidebar.height),
    };
  });

  expect(layout.unusedBelow).toBeLessThanOrEqual(1);
  expect(layout.sidebarHeight).toBe(layout.mainHeight);
});

test('makes room for the warnings panel without losing the height below it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/scripts/webview-harness.html?fixture=with-comments.docx&mode=text');
  await expect(page.locator('#text-container')).toContainText('Reviewed Document');

  await page.locator('#warnings-button').click();
  await expect(page.locator('#warnings-panel')).toBeVisible();

  const layout = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const warnings = document.getElementById('warnings-panel').getBoundingClientRect();
    const main = document.querySelector('.showdocx-main-area').getBoundingClientRect();
    return {
      unusedBelow: Math.round(app.bottom - main.bottom),
      mainStartsBelowWarnings: main.top >= warnings.bottom - 1,
    };
  });

  expect(layout.unusedBelow).toBeLessThanOrEqual(1);
  expect(layout.mainStartsBelowWarnings).toBe(true);
});

test('centres the page in the editor rather than against its left edge', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  const gaps = await page.evaluate(() => {
    const viewport = document.getElementById('viewport').getBoundingClientRect();
    const sheet = document.querySelector('section.showdocx-visual').getBoundingClientRect();
    return {
      viewportWidth: Math.round(viewport.width),
      left: Math.round(sheet.left - viewport.left),
      right: Math.round(viewport.right - sheet.right),
    };
  });

  // The viewport is a flex item: without flex:1 it sizes to one page and the
  // document sits against the left edge with the rest of the editor empty.
  expect(gaps.viewportWidth).toBeGreaterThan(1200);
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(2);
});

test('keeps the whole page reachable when zoomed past the editor width', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  for (let step = 0; step < 10; step += 1) {
    await page.locator('#zoom-in').click();
  }
  await expect(page.locator('#zoom-reset')).toHaveText('200%');

  const layout = await page.evaluate(() => {
    const element = document.getElementById('viewport');
    const viewport = element.getBoundingClientRect();
    const sheet = document.querySelector('section.showdocx-visual').getBoundingClientRect();
    return {
      startsAt: Math.round(sheet.left - viewport.left),
      overflows: element.scrollWidth > element.clientWidth,
    };
  });

  // Scrolling only reveals content to the right, so anything at a negative
  // offset is content the reader can never get back to.
  expect(layout.startsAt).toBeGreaterThanOrEqual(0);
  expect(layout.overflows).toBe(true);
});

test('cycles the page theme and says which one is next', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  const app = page.locator('#app');
  const button = page.locator('#page-theme-button');

  await expect(app).toHaveAttribute('data-page-theme', 'paper');
  await expect(button).toHaveAttribute('aria-label', /Paper \(switch to Sepia\)/);

  await button.click();
  await expect(app).toHaveAttribute('data-page-theme', 'sepia');

  await button.click();
  await expect(app).toHaveAttribute('data-page-theme', 'dark');
  await expect(button).toHaveAttribute('aria-label', /Dark \(switch to Paper\)/);

  await button.click();
  await expect(app).toHaveAttribute('data-page-theme', 'paper');
});

test('darkens the page without inverting its artwork', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html?fixture=with-images.docx&theme=dark');
  await expect(page.locator('#visual-container section')).toBeVisible();

  const filters = await page.evaluate(() => {
    const section = document.querySelector('#visual-container section');
    const image = document.querySelector('#visual-container img');
    return {
      page: getComputedStyle(section).filter,
      image: image ? getComputedStyle(image).filter : null,
    };
  });

  // The page is inverted; the image is inverted a second time, back to itself.
  expect(filters.page).toContain('invert(1)');
  expect(filters.image).toContain('invert(1)');
});

test('hides the page theme control where it would do nothing', async ({ page }) => {
  // Text mode is drawn in the editor's own colours.
  await page.goto('/scripts/webview-harness.html?mode=text');
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#page-theme-button')).toBeHidden();

  await page.locator('#mode-visual').click();
  await expect(page.locator('#page-theme-button')).toBeVisible();
});

test('opens a document where it was last left', async ({ page }) => {
  const saved = encodeURIComponent(JSON.stringify({
    mode: 'text',
    zoom: 150,
    scrollTop: 0,
    pageTheme: 'dark',
  }));
  await page.goto(`/scripts/webview-harness.html?saved=${saved}`);

  // The saved record wins over the configured defaults, which say visual/100%.
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#zoom-reset')).toHaveText('150%');
  await expect(page.locator('#app')).toHaveAttribute('data-page-theme', 'dark');
});

test('tells the host where the reader is, so it survives the editor closing', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#page-theme-button').click();
  await page.getByRole('button', { name: 'Zoom in' }).click();

  await expect.poll(async () => page.evaluate(() => {
    const message = window.__showDocxTest.messages.findLast(
      (candidate) => candidate.type === 'persistState',
    );
    return message ? { zoom: message.state.zoom, pageTheme: message.state.pageTheme } : null;
  }), { timeout: 5000 }).toEqual({ zoom: 110, pageTheme: 'sepia' });
});

test('comes back to where the reader was after the view is rebuilt', async ({ page }) => {
  // What a hidden tab costs once it is not kept rendered: the webview is built
  // again from scratch. The reading position has to survive that, or the memory
  // saving is paid for by losing the reader's place.
  await page.goto('/scripts/webview-harness.html?keepState=1');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.locator('#page-theme-button').click();
  await page.locator('#zoom-in').click();
  await page.locator('#mode-text').click();
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#zoom-reset')).toHaveText('110%');

  await page.reload();

  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');
  await expect(page.locator('#zoom-reset')).toHaveText('110%');
  await expect(page.locator('#app')).toHaveAttribute('data-page-theme', 'sepia');
  await expect(page.locator('#mode-text')).toHaveAttribute('aria-pressed', 'true');
});

test('leaves the reader where they are when the file changes on disk', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.locator('#page-theme-button').click();
  await page.locator('#mode-text').click();
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  // Word rewrites a document several times while saving it. None of those may
  // put the reader back to the mode, zoom and theme they started at.
  await page.evaluate(() => window.__showDocxTest.reload());
  await expect(page.locator('#text-container')).toContainText('ShowDocx Sample');

  await expect(page.locator('#zoom-reset')).toHaveText('110%');
  await expect(page.locator('#app')).toHaveAttribute('data-page-theme', 'sepia');
  await expect(page.locator('#text-container')).toBeVisible();
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
