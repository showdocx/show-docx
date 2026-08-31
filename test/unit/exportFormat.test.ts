import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { createExportDocument, escapeHtml } from '../../webview-src/exportDocument';

describe('Document export formatting', () => {
  it('escapes special HTML characters in document titles', () => {
    assert.equal(
      escapeHtml('Sample <Document> & "Test" \'File\''),
      'Sample &lt;Document&gt; &amp; &quot;Test&quot; &#039;File&#039;',
    );
  });

  it('generates a clean standalone HTML wrapper', () => {
    const html = createExportDocument('report.docx', '<h1>Report</h1><p>Content</p>');
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>report</title>'));
    assert.ok(html.includes('<h1>Report</h1>'));
  });

  it('escapes the file name in the exported title', () => {
    const html = createExportDocument('<script>alert(1)</script>.docx', '');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});
