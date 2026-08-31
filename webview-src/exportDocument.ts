import { stripDocumentExtension } from '../shared/documentExtensions';

/**
 * Standalone HTML export. Kept free of DOM and bundler dependencies so the unit
 * tests can exercise the real functions rather than copies of them.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function createExportDocument(fileName: string, body: string): string {
  const title = escapeHtml(stripDocumentExtension(fileName));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 850px; margin: 0 auto; padding: 48px 28px; font: 16px/1.7 system-ui, sans-serif; }
    img { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #8888; padding: 0.5rem; text-align: left; }
    pre { overflow: auto; padding: 1rem; background: #8882; }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 4px solid #8888; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * The class docx-preview is configured with in `renderVisual`. Its wrapper and
 * page elements derive from it, so the print rules below have to agree with it.
 */
const VISUAL_CLASS = 'showdocx-visual';

/**
 * Keeps generated CSS from closing the `<style>` element it is written into. A
 * document style name is free text and reaches the stylesheet as a selector, so
 * `</style>` in one would otherwise end the element and let the rest of the name
 * be parsed as markup. The backslash is inert to the HTML tokenizer and only
 * invalidates a selector that was already meaningless.
 */
export function escapeStyleText(css: string): string {
  return css.replaceAll(/<\/(style)/gi, '<\\/$1');
}

/**
 * Standalone HTML built from the rendered page layout rather than the semantic
 * text view: `styles` is the CSS docx-preview generated for the document and
 * `body` its page markup. Images are already inline data URIs, so the result
 * needs no external assets.
 */
export function createPrintDocument(
  fileName: string,
  styles: string,
  body: string,
): string {
  const title = escapeHtml(stripDocumentExtension(fileName));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
${escapeStyleText(styles)}
  </style>
  <style>
    /* Last, so these win over the wrapper styling docx-preview generated. */
    html, body { margin: 0; padding: 0; background: #fff; }
    .${VISUAL_CLASS}-wrapper { padding: 24px 0 0; background: #fff; }
    @page { size: auto; margin: 0; }
    @media print {
      .${VISUAL_CLASS}-wrapper { padding: 0 !important; background: #fff !important; }
      .${VISUAL_CLASS}-wrapper > section.${VISUAL_CLASS} {
        margin: 0 !important;
        box-shadow: none !important;
        break-after: page;
        page-break-after: always;
      }
      .${VISUAL_CLASS}-wrapper > section.${VISUAL_CLASS}:last-child {
        break-after: auto;
        page-break-after: auto;
      }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
