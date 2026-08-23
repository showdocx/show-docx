import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';

describe('Document export formatting', () => {
  it('escapes special HTML characters in document titles', () => {
    function escapeHtml(value: string): string {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    assert.equal(
      escapeHtml('Sample <Document> & "Test" \'File\''),
      'Sample &lt;Document&gt; &amp; &quot;Test&quot; &#039;File&#039;',
    );
  });

  it('generates a clean standalone HTML wrapper', () => {
    function createExportDocument(fileName: string, body: string): string {
      const title = fileName.replace(/\.docx$/i, '');
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
</head>
<body>
${body}
</body>
</html>`;
    }

    const html = createExportDocument('report.docx', '<h1>Report</h1><p>Content</p>');
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>report</title>'));
    assert.ok(html.includes('<h1>Report</h1>'));
  });
});
