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
  const title = escapeHtml(fileName.replace(/\.docx$/i, ''));
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
