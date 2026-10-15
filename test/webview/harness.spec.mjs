import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { linksDocument, serveDocument } from './documents.mjs';
import { routeHostDetails } from './hostDetails.mjs';

test.beforeEach(async ({ page }) => {
  await routeHostDetails(page);
});

/**
 * The harness stands in for the webview VS Code builds, so it is only as good
 * as its likeness. These hold it to the real thing: the same policy, the same
 * markup, and a render that the policy does not have to stop.
 */

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function policyOf(html) {
  const match = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error('No Content-Security-Policy meta element.');
  }
  return match[1].split(';').map((directive) => directive.trim()).filter(Boolean);
}

function appMarkupOf(html) {
  const start = html.indexOf('<div id="app"');
  const end = html.indexOf('<div id="context-menu"');
  if (start === -1 || end === -1) {
    throw new Error('No viewer markup found.');
  }
  return html.slice(start, end).replaceAll(/\s+/g, ' ').trim();
}

test('runs under the policy the real webview runs under', async () => {
  const provider = await read('src/docxEditorProvider.ts');
  const harness = await read('scripts/webview-harness.html');

  const real = policyOf(provider).map((directive) => directive
    .replaceAll('${webview.cspSource}', "'self'")
    .replaceAll('${nonce}', 'harness'));
  // connect-src is the harness's own: it fetches what the host would send.
  const likeness = policyOf(harness).filter((directive) => !directive.startsWith('connect-src'));

  expect(likeness).toEqual(real);
});

test('holds the same viewer markup as the real webview', async () => {
  const provider = await read('src/docxEditorProvider.ts');
  const harness = await read('scripts/webview-harness.html');

  expect(appMarkupOf(harness)).toEqual(appMarkupOf(provider));
});

for (const fixture of ['simple.docx', 'with-images.docx', 'with-comments.docx', 'links.docx']) {
  test(`renders ${fixture} without the policy stopping anything`, async ({ page }) => {
    await serveDocument(page, 'links.docx', await linksDocument());
    const violations = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`Content Security Policy: ${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    });

    await page.goto(`/scripts/webview-harness.html?fixture=${fixture}`);
    await expect(page.locator('#visual-container section').first()).toBeVisible();
    await page.locator('#mode-text').click();
    await expect(page.locator('#text-container')).not.toBeEmpty();

    expect(violations).toEqual([]);
  });
}
