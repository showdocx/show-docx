import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import JSZip from 'jszip';
import { embeddedFontDocument, serveDocument, themeDocument } from './documents.mjs';
import { routeHostDetails } from './hostDetails.mjs';

// Build the current sources in memory: scoped tests must not replace a parallel
// host build's dist files, and each distributed renderer needs its own coverage.
const bundles = new Map();
test.beforeAll(async () => {
  await Promise.all(['js', 'mjs'].map(async (extension) => {
    const result = await build({
      entryPoints: ['webview-src/main.ts'],
      outfile: 'main.js',
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'chrome114',
      loader: { '.ttf': 'dataurl' },
      alias: { 'docx-preview': resolve(`node_modules/docx-preview/dist/docx-preview.${extension}`) },
      logLevel: 'silent',
    });
    bundles.set(extension, result.outputFiles);
  }));
});

async function useBundle(page, extension = 'mjs') {
  for (const type of ['js', 'css']) {
    const output = bundles.get(extension).find((file) => file.path.endsWith(`.${type}`));
    await page.route(`**/dist/webview/main.${type}`, (route) => route.fulfill({
      body: Buffer.from(output.contents),
      contentType: type === 'js' ? 'application/javascript' : 'text/css',
    }));
  }
}

test.beforeEach(async ({ page }) => {
  await routeHostDetails(page);
  await useBundle(page);
});

async function exportPdf(page) {
  await page.locator('#export-pdf-button').click();
  await expect.poll(() => page.evaluate(() => window.__showDocxTest.messages
    .filter((message) => message.type === 'exportPdf').length)).toBeGreaterThan(0);
  return page.evaluate(() => window.__showDocxTest.messages
    .findLast((message) => message.type === 'exportPdf').html);
}

function xmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '&#10;');
}

// Keep every attack in a separate OOXML field so one rejected path cannot mask another.
async function cssDocument({
  styleId = 'RegressionStyle', font, eastAsia, asciiTheme, colorTheme,
  numId = '7', abstractId = '3', level = '0', start = '1', size = '24',
  bulletStyle, bulletSource = 'rIdBullet', pictureId = '2',
  numRef = numId, abstractRef = abstractId, paragraphLevel = level,
  format = 'decimal', levelText = '%1.',
} = {}) {
  const zip = await JSZip.loadAsync(await themeDocument());
  const namespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const fonts = Object.entries({ ascii: font, eastAsia, asciiTheme })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` w:${name}="${xmlAttribute(value)}"`).join('');
  zip.file('word/document.xml', `<w:document ${namespace}><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="${xmlAttribute(styleId)}"/></w:pPr>`
    + '<w:r><w:t>Styled probe</w:t></w:r></w:p>'
    + `<w:p><w:pPr><w:numPr><w:ilvl w:val="${xmlAttribute(paragraphLevel)}"/>`
    + `<w:numId w:val="${xmlAttribute(numRef)}"/></w:numPr></w:pPr>`
    + '<w:r><w:t>Numbered probe</w:t></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'
    + '</w:body></w:document>');
  zip.file('word/styles.xml', `<w:styles ${namespace}>`
    + `<w:style w:type="paragraph" w:styleId="${xmlAttribute(styleId)}">`
    + `<w:rPr><w:rFonts${fonts}/><w:sz w:val="${xmlAttribute(size)}"/>`
    + (colorTheme === undefined ? '<w:color w:val="123456"/>'
      : `<w:color w:themeColor="${xmlAttribute(colorTheme)}"/>`)
    + '</w:rPr></w:style></w:styles>');
  zip.file('word/numbering.xml', `<w:numbering ${namespace} `
    + 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + (bulletStyle === undefined ? '' : `<w:numPicBullet w:numPicBulletId="${xmlAttribute(pictureId)}">`
      + `<w:pict><v:shape style="${xmlAttribute(bulletStyle)}"><v:imagedata r:id="${xmlAttribute(bulletSource)}"/>`
      + '</v:shape></w:pict></w:numPicBullet>')
    + `<w:abstractNum w:abstractNumId="${xmlAttribute(abstractId)}"><w:lvl w:ilvl="${xmlAttribute(level)}">`
    + `<w:start w:val="${xmlAttribute(start)}"/><w:numFmt w:val="${xmlAttribute(format)}"/>`
        + (levelText === null ? '' : `<w:lvlText w:val="${xmlAttribute(levelText)}"/>`)
    + (bulletStyle === undefined ? '' : `<w:lvlPicBulletId w:val="${xmlAttribute(pictureId)}"/>`)
    + '</w:lvl></w:abstractNum>'
    + `<w:num w:numId="${xmlAttribute(numId)}"><w:abstractNumId w:val="${xmlAttribute(abstractRef)}"/></w:num>`
    + '</w:numbering>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function openCssDocument(page, options) {
  await serveDocument(page, 'css-regression.docx', await cssDocument(options));
  await page.goto('/scripts/webview-harness.html?fixture=css-regression.docx');
  await expect(page.locator('#visual-container section').first()).toBeVisible();
  await expect(page.locator('#loading')).toBeHidden();
  expect(await page.locator('#app').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
}

const require = createRequire(import.meta.url);

function visibilityRun(word, properties = '') {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}`
    + `<w:t xml:space="preserve">${word} </w:t></w:r>`;
}

const visibilityCases = [
  ...['vanish', 'specVanish'].map((property) => ({
    name: `direct ${property}=0 overrides a hidden character style`,
    runs: visibilityRun('DIRECT_OVERRIDE_VISIBLE',
      `<w:rStyle w:val="${property === 'vanish' ? 'BaseHidden' : 'SpecHidden'}"/><w:${property} w:val="0"/>`)
      + visibilityRun('CHARACTER_STYLE_SECRET',
        `<w:rStyle w:val="${property === 'vanish' ? 'BaseHidden' : 'SpecHidden'}"/>`),
    visible: ['DIRECT_OVERRIDE_VISIBLE'],
    hidden: ['CHARACTER_STYLE_SECRET'],
  })),
  {
    name: 'Base true then Child true toggles hidden text back to visible',
    runs: visibilityRun('DOUBLE_TOGGLE_VISIBLE', '<w:rStyle w:val="ChildTrue"/>')
      + visibilityRun('BASE_STYLE_SECRET', '<w:rStyle w:val="BaseHidden"/>'),
    visible: ['DOUBLE_TOGGLE_VISIBLE'],
    hidden: ['BASE_STYLE_SECRET'],
  },
  {
    name: 'Base true then Child false leaves text hidden',
    runs: visibilityRun('FALSE_TOGGLE_SECRET', '<w:rStyle w:val="ChildFalse"/>'),
    visible: [],
    hidden: ['FALSE_TOGGLE_SECRET'],
  },
  {
    name: 'the default paragraph style hides text unless directly overridden',
    defaultParagraph: true,
    runs: visibilityRun('DEFAULT_PARAGRAPH_SECRET')
      + visibilityRun('DEFAULT_OVERRIDE_VISIBLE', '<w:vanish w:val="0"/>')
      + visibilityRun('DEFAULT_ADJACENT_SECRET'),
    visible: ['DEFAULT_OVERRIDE_VISIBLE'],
    hidden: ['DEFAULT_PARAGRAPH_SECRET', 'DEFAULT_ADJACENT_SECRET'],
  },
];

let visibilityHost;
async function visibilityHostHelpers() {
  const modules = ['text/docxText', 'text/xmlScanner', 'docxLoader'];
  const stale = await Promise.all(modules.map(async (name) => {
    const [source, compiled] = await Promise.all([
      stat(new URL(`../../src/${name}.ts`, import.meta.url)),
      stat(new URL(`../../dist-test/src/${name}.js`, import.meta.url)),
    ]);
    return source.mtimeMs > compiled.mtimeMs;
  }));
  if (!stale.some(Boolean)) {
    return {
      ...require('../../dist-test/src/text/docxText.js'),
      ...require('../../dist-test/src/docxLoader.js'),
    };
  }
  // A parallel host build may not be ready: compile the real helper without
  // touching its shared outputs, just as these tests bundle the webview above.
  const result = await build({
    stdin: {
      contents: 'export { makeVisibleDocxBytes } from "./src/text/docxText";'
        + 'export { loadAndValidateZip } from "./src/docxLoader";',
      resolveDir: resolve('.'),
      sourcefile: 'visibility-host.ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

async function preparedVisibilityDocument(scenario) {
  // Use exactly the validated, host-preprocessed bytes sent to the real webview.
  const { makeVisibleDocxBytes, loadAndValidateZip } = await (visibilityHost ??= visibilityHostHelpers());
  const zip = await JSZip.loadAsync(await themeDocument());
  const namespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const paragraph = (runs, style = 'VisibleParagraph') => '<w:p>'
    + (style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '') + runs + '</w:p>';
  const before = visibilityRun('NORMAL_BEFORE');
  const after = visibilityRun('NORMAL_AFTER');
  zip.file('word/document.xml', `<w:document ${namespace}><w:body>`
    + (scenario.defaultParagraph
      ? paragraph(before) + paragraph(scenario.runs, null) + paragraph(after)
      : paragraph(before + scenario.runs + after))
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'
    + '</w:body></w:document>');
  zip.file('word/styles.xml', `<w:styles ${namespace}>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="DefaultHidden">'
    + '<w:name w:val="Default Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="VisibleParagraph"><w:name w:val="Visible Paragraph"/></w:style>'
    + '<w:style w:type="character" w:styleId="BaseHidden"><w:name w:val="Base Hidden"/>'
    + '<w:rPr><w:vanish/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="ChildTrue"><w:name w:val="Child True"/>'
    + '<w:basedOn w:val="BaseHidden"/><w:rPr><w:vanish w:val="1"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="ChildFalse"><w:name w:val="Child False"/>'
    + '<w:basedOn w:val="BaseHidden"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="SpecHidden"><w:name w:val="Spec Hidden"/>'
    + '<w:rPr><w:specVanish/></w:rPr></w:style></w:styles>');
  const original = await zip.generateAsync({ type: 'nodebuffer' });
  const prepared = await makeVisibleDocxBytes(original, await loadAndValidateZip(original));
  const preparedZip = await JSZip.loadAsync(prepared);
  for (const part of ['word/document.xml', 'word/styles.xml']) {
    expect(await preparedZip.file(part).async('text'), `resolved visibility declarations in ${part}`)
      .not.toMatch(/<w:(?:vanish|specVanish)\b/);
  }
  return Buffer.from(prepared);
}

async function expectPreparedVisibility(container, scenario) {
  for (const word of ['NORMAL_BEFORE', ...scenario.visible, 'NORMAL_AFTER']) {
    const element = container.getByText(word);
    await expect(element).toHaveCount(1);
    expect(await element.evaluate((node) => node.checkVisibility({
      checkOpacity: true, checkVisibilityCSS: true,
    })), `${word} must paint, not just exist in the DOM`).toBe(true);
  }
  for (const word of scenario.hidden) {
    await expect(container.getByText(word)).toHaveCount(0);
    // Check textContent too: display:none is not sufficient for hidden content.
    await expect(container).not.toContainText(word);
  }
}

const OPACITY_ATTACK = '{}#app{opacity:0}/*';
const COLOR_ATTACK = '000000;}#app{outline:17px solid rgb(1,2,3)!important} .tail{color:red';
const FONT_ATTACK = 'Bad"\\\';}#app{outline:19px solid rgb(4,5,6)!important}/*</style><form action="https://font.invalid">';

for (const extension of ['js', 'mjs']) {
  for (const scenario of visibilityCases) {
    test(`host-preprocessed hidden visibility: ${scenario.name} in dist ${extension}`, async ({ page, context }) => {
      await useBundle(page, extension);
      await serveDocument(page, 'prepared-visibility.docx', await preparedVisibilityDocument(scenario));
      await page.goto('/scripts/webview-harness.html?fixture=prepared-visibility.docx');
      await expect(page.locator('#visual-container section').first()).toBeVisible();
      await expect(page.locator('#loading')).toBeHidden();
      await expectPreparedVisibility(page.locator('#visual-container'), scenario);
      const printHtml = await exportPdf(page);

      await page.locator('#mode-text').click();
      await expect(page.locator('#text-container')).toBeVisible();
      await expectPreparedVisibility(page.locator('#text-container'), scenario);
      await page.locator('#export-button').click();
      await expect.poll(() => page.evaluate(() => window.__showDocxTest.messages
        .some((message) => message.type === 'exportHtml'))).toBe(true);
      const textHtml = await page.evaluate(() => window.__showDocxTest.messages
        .findLast((message) => message.type === 'exportHtml').html);

      const exported = await context.newPage();
      try {
        for (const html of [printHtml, textHtml]) {
          for (const word of scenario.hidden) {
            expect(html).not.toContain(word);
          }
          await exported.setContent(html);
          await expectPreparedVisibility(exported.locator('body'), scenario);
        }
      } finally {
        await exported.close();
      }
    });
  }

  for (const field of ['font', 'eastAsia']) {
    test(`contains ${field} font CSS injection in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      const font = 'evil;}#app{opacity:0}/*';
      await openCssDocument(page, { [field]: font });
      const family = await page.locator('#visual-container p').first().locator('span')
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(family).toContain(font);
    });
  }

  for (const styleId of ['x' + OPACITY_ATTACK, 'Normal', 'Heading 1', 'O\'Brien:"Quoted"\\日本語', 'Tab\nStyle']) {
    test(`escapes style selector ${JSON.stringify(styleId)} in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      await openCssDocument(page, { styleId });
      expect(await page.locator('#visual-container p').first().locator('span')
        .evaluate((element) => getComputedStyle(element).color)).toBe('rgb(18, 52, 86)');
    });
  }

  for (const field of ['numId', 'abstractId', 'level', 'pictureId', 'start']) {
    test(`rejects malformed numbering ${field} in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      await openCssDocument(page, {
        [field]: '7' + OPACITY_ATTACK,
        ...(field === 'pictureId' ? { bulletStyle: 'width:12pt;height:12pt' } : {}),
      });
      const css = await page.locator('#showdocx-docx-styles').textContent();
      expect(css).not.toContain('#app');
      expect(css).not.toMatch(/NaN|Infinity/);
      if (['numId', 'abstractId', 'level'].includes(field)) {
        expect(css).not.toContain('counter-increment');
      }
    });
  }

  for (const field of ['numRef', 'paragraphLevel', 'abstractRef']) {
    test(`rejects malformed numbering reference ${field} in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      await openCssDocument(page, { [field]: '7' + OPACITY_ATTACK });
      expect(await page.locator('#showdocx-docx-styles').textContent()).not.toContain('#app');
      if (field === 'abstractRef') {
        expect(await page.locator('#showdocx-docx-styles').textContent()).not.toContain('counter-increment');
      } else {
        expect(await page.locator('#visual-container p').nth(1).getAttribute('class') ?? '').not.toContain('-num-');
      }
    });
  }

  test(`preserves picture bullet declarations and bounded levels in dist ${extension}`, async ({ page }) => {
    await useBundle(page, extension);
    await openCssDocument(page, { bulletStyle: 'width:12pt;height:6pt', level: '8' });
    const pseudo = await page.locator('#visual-container p').nth(1).evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return { width: style.width, height: style.height, display: style.display };
    });
    expect(pseudo).toEqual({ width: '16px', height: '8px', display: 'inline-block' });
    for (const level of ['-1', '9', '1junk']) {
      await page.unroute('**/test/fixtures/css-regression.docx');
      await openCssDocument(page, { level });
      expect(await page.locator('#showdocx-docx-styles').textContent()).not.toContain('counter-increment');
      expect(await page.locator('#visual-container p').nth(1).getAttribute('class') ?? '').not.toContain('-num-');
    }
  });

  test(`preserves quoted font names and theme references in dist ${extension}`, async ({ page }) => {
    await useBundle(page, extension);
    const font = 'O\'Brien "Quoted", \\日本語';
    await openCssDocument(page, { font, asciiTheme: 'majorHAnsi', colorTheme: 'accent1' });
    const rendered = await page.locator('#visual-container p').first().locator('span')
      .evaluate((element, name) => {
        const probe = document.createElement('span');
        probe.style.fontFamily = '"' + name.replace(/["\\]/g, '\\$&') + '", "Safe Major"';
        return { family: getComputedStyle(element).fontFamily, expected: probe.style.fontFamily,
          color: getComputedStyle(element).color };
      }, font);
    expect(rendered.family).toBe(rendered.expected);
    expect(rendered.color).toBe('rgb(18, 52, 171)');
    expect(await page.locator('#visual-container p').nth(1)
      .evaluate((element) => getComputedStyle(element).display)).toBe('list-item');
    expect(await page.locator('#showdocx-docx-styles').textContent()).toContain('showdocx-visual-num-7-0');
  });

  test(`canonicalizes numeric IDs without accepting partial numbers in dist ${extension}`, async ({ page }) => {
    await useBundle(page, extension);
    await openCssDocument(page, { numId: '0007', abstractId: '0003', level: '00', start: '4' });
    await expect(page.locator('#visual-container p').nth(1)).toHaveClass(/showdocx-visual-num-7-0/);
    const css = await page.locator('#showdocx-docx-styles').textContent();
    expect(css).toMatch(/counter-reset:\s*showdocx-visual-num-7-0 3/);
    for (const numId of ['-1', '7.1', '7junk', '2147483648', '9999999999999999999999999999']) {
      await page.unroute('**/test/fixtures/css-regression.docx');
      await openCssDocument(page, { numId });
      expect(await page.locator('#showdocx-docx-styles').textContent()).not.toContain('counter-increment');
      expect(await page.locator('#visual-container p').nth(1).getAttribute('class') ?? '').not.toContain('-num-');
    }
  });

  for (const [name, options] of [
    ['length', { size: '24pt;}#app{opacity:0}/*pt' }],
    ['numbering format', { format: 'decimal;}#app{opacity:0}/*', levelText: null }],
    ['numbering text', { levelText: '";}#app{opacity:0}/*</style><form action="https://css.invalid">%999' }],
    ['font theme reference', { asciiTheme: 'majorHAnsi); }#app{opacity:0}/*' }],
    ['color theme reference', { colorTheme: 'accent1); }#app{opacity:0}/*' }],
    ['picture bullet declarations', { bulletStyle: 'width:12pt;}#app{opacity:0}/*' }],
    ['picture bullet relationship', { bulletStyle: 'width:12pt;height:12pt', bulletSource: 'rId); }#app{opacity:0}/*' }],
  ]) {
    test(`contains raw ${name} CSS in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      await openCssDocument(page, options);
      const css = await page.locator('#showdocx-docx-styles').textContent();
      if (name === 'numbering text') {
        expect(css).not.toContain('</style>');
        expect(css).not.toContain('counter(null');
        await expect(page.locator('form')).toHaveCount(0);
        expect(await exportPdf(page)).not.toContain('<form');
      } else {
        expect(css).not.toContain('#app');
      }
    });
  }

  for (const name of ['evil;}#app{opacity:0}/*', 'O\'Brien "Quoted" Font']) {
    test(`quotes embedded font-table name ${JSON.stringify(name)} in dist ${extension}`, async ({ page }) => {
      await useBundle(page, extension);
      const zip = await JSZip.loadAsync(await embeddedFontDocument());
      zip.file('word/fontTable.xml', (await zip.file('word/fontTable.xml').async('text'))
        .replaceAll('Embedded Test', xmlAttribute(name)));
      await serveDocument(page, 'embedded-hostile.docx', await zip.generateAsync({ type: 'nodebuffer' }));
      await page.goto('/scripts/webview-harness.html?fixture=embedded-hostile.docx');
      await expect(page.locator('#visual-container section').first()).toBeVisible();
      await expect(page.locator('#loading')).toBeHidden();
      expect(await page.locator('#app').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
      expect(await page.evaluate(() => [...document.fonts].map((font) => font.family)))
        .toContain(name);
    });
  }

  test(`rejects raw theme color CSS injection in dist ${extension}`, async ({ page }) => {
    await useBundle(page, extension);
    await serveDocument(page, 'hostile-theme.docx', await themeDocument({
      srgb: COLOR_ATTACK, system: COLOR_ATTACK,
    }));
    await page.goto('/scripts/webview-harness.html?fixture=hostile-theme.docx');
    await expect(page.locator('#visual-container section').first()).toBeVisible();
    const rendered = await page.evaluate(() => ({
      css: document.getElementById('showdocx-docx-styles').textContent,
      outline: getComputedStyle(document.getElementById('app')).outlineWidth,
      accent: getComputedStyle(document.querySelector('section.showdocx-visual'))
        .getPropertyValue('--docx-accent1-color'),
      system: getComputedStyle(document.querySelector('section.showdocx-visual'))
        .getPropertyValue('--docx-dk1-color'),
    }));
    expect(rendered.css).not.toContain(COLOR_ATTACK);
    expect(rendered.css).not.toContain('#app');
    expect(rendered.outline).not.toBe('17px');
    expect(rendered.accent).toBe('');
    expect(rendered.system).toBe('');
    expect(await exportPdf(page)).not.toContain('outline:17px');
  });

  test(`quotes theme fonts as inert CSS strings in dist ${extension}`, async ({ page }) => {
    await useBundle(page, extension);
    await serveDocument(page, 'font-theme.docx', await themeDocument({
      major: FONT_ATTACK, minor: 'Noto Sans 日本語',
    }));
    await page.goto('/scripts/webview-harness.html?fixture=font-theme.docx');
    await expect(page.locator('#visual-container section').first()).toBeVisible();
    const rendered = await page.evaluate(() => {
      const section = document.querySelector('section.showdocx-visual');
      const probe = document.createElement('span');
      probe.style.fontFamily = 'var(--docx-majorHAnsi-font)';
      section.appendChild(probe);
      return {
        family: getComputedStyle(probe).fontFamily,
        minor: getComputedStyle(section).getPropertyValue('--docx-minorHAnsi-font'),
        accent: getComputedStyle(section).getPropertyValue('--docx-accent1-color'),
        system: getComputedStyle(section).getPropertyValue('--docx-dk1-color'),
        outline: getComputedStyle(document.getElementById('app')).outlineWidth,
      };
    });
    expect(rendered.family).toContain('outline:19px');
    expect(rendered.minor.trim()).toBe('"Noto Sans 日本語"');
    expect(rendered.accent.trim()).toBe('#1234aB');
    expect(rendered.system.trim()).toBe('#4567cD');
    expect(rendered.outline).not.toBe('19px');
    await expect(page.locator('form')).toHaveCount(0);
    const html = await exportPdf(page);
    expect(html).not.toContain('</style><form');
    expect(html).not.toContain('<form');
  });

  test(`exports an actual embedded font from dist ${extension}`, async ({ page, context }) => {
    await useBundle(page, extension);
    await serveDocument(page, 'embedded-font.docx', await embeddedFontDocument());
    await page.goto('/scripts/webview-harness.html?fixture=embedded-font.docx');
    await expect(page.locator('#visual-container section').first()).toBeVisible();
    const html = await exportPdf(page);
    expect(html).toMatch(/@font-face\s*\{[^}]*src:\s*url\("?data:font\/ttf;base64,[a-z0-9+/]+=*"?\)/i);
    expect(html).not.toContain('data:application/octet-stream');
    const exported = await context.newPage();
    try {
      await exported.setContent(html);
      expect(await exported.evaluate(async () => {
        const fonts = await document.fonts.load('12px "Embedded Test"');
        return fonts.map((font) => font.status);
      })).toEqual(['loaded']);
    } finally {
      await exported.close();
    }
  });
}

test('only permits six-digit DrawingML theme colors', async ({ page }) => {
  for (const invalid of ['abc', '12345678', '#123456', 'red', '12345g']) {
    await serveDocument(page, 'invalid-theme.docx', await themeDocument({ srgb: invalid, system: invalid }));
    await page.goto('/scripts/webview-harness.html?fixture=invalid-theme.docx');
    await expect(page.locator('#visual-container section').first()).toBeVisible();
    expect(await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('section.showdocx-visual'));
      return [style.getPropertyValue('--docx-accent1-color'), style.getPropertyValue('--docx-dk1-color')];
    })).toEqual(['', '']);
    await page.unroute('**/test/fixtures/invalid-theme.docx');
  }
});

test('print export keeps narrow font data URLs but no external resources or forms', async ({ page }) => {
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#visual-container section')).toBeVisible();
  await page.evaluate(() => {
    const style = document.createElement('style');
    const safeFonts = ['ttf', 'otf', 'woff', 'woff2'].map((type) =>
      `@font-face { font-family: "Safe-${type}"; src: url("data:font/${type};base64,AA=="); }`).join('\n');
    const rejected = [
      'https://remote.invalid/font.woff2', 'http://remote.invalid/font.woff',
      '//remote.invalid/font.ttf', 'blob:https://remote.invalid/font',
      'file:///C:/font.ttf', 'relative.ttf',
      'data:application/octet-stream;base64,AA==', 'data:text/html;base64,AA==',
      'data:font/ttf,unencoded', 'data:font/ttf;base64,AA==;extra',
    ].map((url, index) => `@font-face { font-family: "Rejected-${index}"; src: url("${url}"); }`).join('\n');
    style.textContent = '@import "https://remote.invalid/style.css";\n' + safeFonts + '\n' + rejected;
    document.getElementById('showdocx-docx-styles').appendChild(style);
    const section = document.querySelector('#visual-container section');
    const form = document.createElement('form');
    form.action = 'https://remote.invalid/submit';
    form.innerHTML = '<input name="secret"><button formaction="https://remote.invalid/submit">Send</button>';
    section.appendChild(form);
    const image = document.createElement('img');
    image.src = 'https://remote.invalid/image.png';
    image.srcset = 'https://remote.invalid/2x.png 2x';
    image.style.backgroundImage = 'url(https://remote.invalid/background.png)';
    section.appendChild(image);
    const script = document.createElement('script');
    script.type = 'text/plain';
    script.textContent = 'export-script-sentinel';
    section.appendChild(script);
    const link = document.createElement('a');
    link.href = 'javascript:alert(1)';
    link.textContent = 'Unsafe link';
    section.appendChild(link);
  });
  const html = await exportPdf(page);
  for (const type of ['ttf', 'otf', 'woff', 'woff2']) {
    expect(html).toContain(`data:font/${type};base64,AA==`);
  }
  expect(html).not.toMatch(/remote\.invalid|blob:|file:|relative\.ttf|data:application|data:text|unencoded|;extra|@import/i);
  expect(html).not.toMatch(/<(?:form|input|button|script)\b|formaction=|javascript:/i);
  expect(html).not.toContain('export-script-sentinel');
  expect(html).toContain("form-action 'none'");
  expect(html).toContain("font-src data:");
});

test('fallback interactions and document reinitialization keep the Visual preference', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.Node.prototype.appendChild;
    window.Node.prototype.appendChild = function (child) {
      if (this instanceof window.Element && this.id === 'visual-container') {
        throw new Error('forced visual failure for state regression');
      }
      return original.call(this, child);
    };
    window.__restoreVisualAppend = () => { window.Node.prototype.appendChild = original; };
  });
  await page.goto('/scripts/webview-harness.html');
  await expect(page.locator('#text-container')).toBeVisible();
  await expect(page.locator('#mode-text')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#zoom-in').click();
  await page.evaluate(() => {
    const text = document.getElementById('text-container');
    for (let index = 0; index < 100; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Scroll fallback text';
      text.appendChild(paragraph);
    }
    document.getElementById('viewport').scrollTop = 300;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cyclePageTheme' } }));
  });
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('showdocx.harness.state');
    const state = JSON.parse(raw);
    return { mode: state.mode, zoom: state.zoom, scrolled: state.scrollTop > 0, theme: state.pageTheme };
  })).toEqual({ mode: 'visual', zoom: 110, scrolled: true, theme: 'sepia' });
  await expect.poll(() => page.evaluate(() => window.__showDocxTest.messages
    .findLast((message) => message.type === 'persistState')?.state.mode)).toBe('visual');
  await page.evaluate(() => {
    window.__restoreVisualAppend();
    window.__showDocxTest.reload();
  });
  await expect(page.locator('#visual-container section')).toBeVisible();
  await expect(page.locator('#mode-visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#zoom-reset')).toHaveText('110%');
});

for (const mode of ['visual', 'text']) {
  test(`search separates br and block boundaries but joins inline spans in ${mode} mode`, async ({ page }) => {
    await page.goto(`/scripts/webview-harness.html?mode=${mode}`);
    const container = mode === 'visual' ? '#visual-container' : '#text-container';
    await expect(page.locator(container)).toBeVisible();
    await expect(page.locator('#loading')).toBeHidden();
    await page.locator(container).evaluate((element) => {
      element.innerHTML = '<p id="linebreak">foo<br><span>bar</span></p>'
        + '<p id="inline"><span>foo</span><span>bar</span></p>'
        + '<p>foo</p><p>bar</p>'
        + '<span id="root-inline">foo</span><em>bar</em>';
    });
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('foobar');
    await expect(page.locator('#search-count')).toHaveText('1/2');
    await expect(page.locator('mark.showdocx-search-match')).toHaveCount(4);
    await expect(page.locator('#linebreak mark')).toHaveCount(0);
    await expect(page.locator('#inline span')).toHaveCount(2);
    await page.locator('#search-input').fill('foo bar');
    await expect(page.locator('#search-count')).toHaveText('0/0');
    await page.locator('#search-input').fill('bar');
    await expect(page.locator('#search-count')).toHaveText('1/4');
    expect(await page.locator('mark.showdocx-search-match').allTextContents())
      .toEqual(['bar', 'bar', 'bar', 'bar']);
    await page.locator('#search-close').click();
    await expect(page.locator('#linebreak br')).toHaveCount(1);
    await expect(page.locator('#inline span')).toHaveCount(2);
    await expect(page.locator('mark.showdocx-search-match')).toHaveCount(0);
  });
}
