import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  createExportDocument,
  createPrintDocument,
  escapeHtml,
  escapeStyleText,
} from '../../webview-src/exportDocument';

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

describe('Printable document formatting', () => {
  const styles = 'section.showdocx-visual { width: 595pt; }';
  const body = '<div class="showdocx-visual-wrapper">'
    + '<section class="showdocx-visual"><p>Page one</p></section>'
    + '<section class="showdocx-visual"><p>Page two</p></section>'
    + '</div>';

  it('carries the rendered pages and their generated CSS into the document', () => {
    const html = createPrintDocument('report.docx', styles, body);
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>report</title>'));
    assert.ok(html.includes(styles));
    assert.ok(html.includes('<p>Page one</p>'));
    assert.ok(html.includes('<p>Page two</p>'));
  });

  it('breaks a page after every rendered section but the last', () => {
    const html = createPrintDocument('report.docx', styles, body);
    assert.ok(html.includes('@page { size: auto; margin: 0; }'));
    assert.match(
      html,
      /section.showdocx-visual {[^}]*page-break-after: always;/s,
    );
    assert.match(
      html,
      /section.showdocx-visual:last-child {[^}]*page-break-after: auto;/s,
    );
  });

  it('drops the on-screen page decoration so the print has no margins of its own', () => {
    const html = createPrintDocument('report.docx', styles, body);
    assert.ok(html.includes('box-shadow: none !important;'));
    assert.ok(html.includes('margin: 0 !important;'));
  });

  it('escapes the file name in the printable title', () => {
    const html = createPrintDocument('<script>alert(1)</script>.docx', '', '');
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('keeps a document style name from closing the style element', () => {
    // A Word style name is free text and reaches the stylesheet as a selector.
    const hostile = '.showdocx-visual_</style><img src=x onerror=alert(1)> { color: red; }';
    const html = createPrintDocument('report.docx', hostile, body);
    assert.ok(!html.includes('</style><img'));
    assert.ok(html.includes('<\\/style>'));
  });
});

describe('Style text escaping', () => {
  it('neutralizes a closing style tag in any casing', () => {
    assert.equal(escapeStyleText('a { } </STYLE> b { }'), 'a { } <\\/STYLE> b { }');
    assert.equal(escapeStyleText('a { } </style > b'), 'a { } <\\/style > b');
  });

  it('leaves ordinary CSS untouched', () => {
    const css = '.wrapper > section.page { margin: 0; content: "<a>"; }';
    assert.equal(escapeStyleText(css), css);
  });
});
