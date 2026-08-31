import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { decodeEntities, htmlToDiffText, parseHtml } from '../../src/diff/htmlToText';

describe('Diff text: blocks', () => {
  it('writes one line per paragraph, separated by a blank line', () => {
    assert.equal(
      htmlToDiffText('<p>First</p><p>Second</p>'),
      'First\n\nSecond\n',
    );
  });

  it('keeps a heading level as its own marker', () => {
    assert.equal(
      htmlToDiffText('<h1>Title</h1><h3>Deeper</h3>'),
      '# Title\n\n### Deeper\n',
    );
  });

  it('collapses the whitespace Word moves around', () => {
    assert.equal(
      htmlToDiffText('<p>  spaced   out\n\ttext  </p>'),
      'spaced out text\n',
    );
  });

  it('drops empty paragraphs rather than diffing their count', () => {
    assert.equal(
      htmlToDiffText('<p>One</p><p></p><p>  </p><p>Two</p>'),
      'One\n\nTwo\n',
    );
  });

  it('splits a paragraph where a line break asked for one', () => {
    assert.equal(
      htmlToDiffText('<p>First line<br />Second line</p>'),
      'First line\nSecond line\n',
    );
  });

  it('prefixes every line of a blockquote', () => {
    assert.equal(
      htmlToDiffText('<blockquote><p>Quoted</p><p>Still quoted</p></blockquote>'),
      '> Quoted\n\n> Still quoted\n',
    );
  });

  it('returns an empty string for a document with no readable text', () => {
    assert.equal(htmlToDiffText(''), '');
    assert.equal(htmlToDiffText('<p></p>'), '');
  });
});

describe('Diff text: inline formatting', () => {
  it('marks bold, italic and struck-through runs', () => {
    assert.equal(
      htmlToDiffText('<p><strong>b</strong> <em>i</em> <s>s</s></p>'),
      '**b** *i* ~~s~~\n',
    );
  });

  it('keeps the spacing around a formatted run outside its markers', () => {
    assert.equal(htmlToDiffText('<p>a<strong> bold </strong>b</p>'), 'a **bold** b\n');
  });

  it('does not emit markers around an empty run', () => {
    assert.equal(htmlToDiffText('<p>plain<strong></strong></p>'), 'plain\n');
  });

  it('keeps the target of a link that leaves the document', () => {
    assert.equal(
      htmlToDiffText('<p><a href="https://example.com">Example</a></p>'),
      '[Example](https://example.com)\n',
    );
  });

  it('drops the target of a link back into the document', () => {
    // Footnote and bookmark targets are identifiers mammoth generated, so they
    // would change without the document changing.
    assert.equal(
      htmlToDiffText('<p>Text<sup><a href="#footnote-1">[1]</a></sup></p>'),
      'Text[1]\n',
    );
  });
});

describe('Diff text: images', () => {
  it('reduces an inlined image to a stable digest', () => {
    const base64 = `data:image/png;base64,${'A'.repeat(500)}`;
    const first = htmlToDiffText(`<p><img alt="Chart" src="${base64}" /></p>`);
    const second = htmlToDiffText(`<p><img alt="Chart" src="${base64}" /></p>`);

    assert.equal(first, second);
    assert.match(first, /^!\[Chart]\(image:[0-9a-f]{8}\)\n$/);
    assert.ok(!first.includes('AAAA'), 'the base64 itself must not reach the diff');
  });

  it('changes the digest when the image changes', () => {
    const one = htmlToDiffText(`<p><img src="data:image/png;base64,${'A'.repeat(500)}" /></p>`);
    const two = htmlToDiffText(`<p><img src="data:image/png;base64,${'B'.repeat(500)}" /></p>`);
    assert.notEqual(one, two);
  });

  it('keeps a source short enough to read as it is', () => {
    assert.equal(
      htmlToDiffText('<p><img alt="Logo" src="docx-image:1a2b3c4d" /></p>'),
      '![Logo](docx-image:1a2b3c4d)\n',
    );
  });

  it('names an image with no alternative text', () => {
    assert.equal(htmlToDiffText('<p><img src="docx-image:00" /></p>'), '![image](docx-image:00)\n');
  });
});

describe('Diff text: lists', () => {
  it('writes one line per bullet', () => {
    assert.equal(
      htmlToDiffText('<ul><li>One</li><li>Two</li></ul>'),
      '- One\n- Two\n',
    );
  });

  it('numbers every ordered item 1., so inserting one does not renumber the rest', () => {
    const before = htmlToDiffText('<ol><li>Alpha</li><li>Beta</li><li>Gamma</li></ol>');
    const after = htmlToDiffText('<ol><li>Alpha</li><li>New</li><li>Beta</li><li>Gamma</li></ol>');

    assert.equal(before, '1. Alpha\n1. Beta\n1. Gamma\n');
    const changed = differingLines(before, after);
    assert.equal(changed, 1, `expected one added line, got ${changed}`);
  });

  it('indents a nested list under its item', () => {
    assert.equal(
      htmlToDiffText('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>'),
      '- Outer\n  - Inner\n',
    );
  });

  it('reads an item whose text mammoth wrapped in a paragraph', () => {
    assert.equal(htmlToDiffText('<ul><li><p>Wrapped</p></li></ul>'), '- Wrapped\n');
  });
});

describe('Diff text: tables', () => {
  it('writes one line per row, with a separator that never changes', () => {
    assert.equal(
      htmlToDiffText(
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      ),
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    );
  });

  it('changes one line when one cell changes', () => {
    const before = htmlToDiffText(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
    );
    const after = htmlToDiffText(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>CHANGED</td></tr></table>',
    );
    assert.equal(differingLines(before, after), 1);
  });

  it('holds a merged cell open so the rows below stay aligned', () => {
    assert.equal(
      htmlToDiffText(
        '<table><tr><td colspan="2">Wide</td></tr><tr><td>a</td><td>b</td></tr></table>',
      ),
      '| Wide |  |\n| --- | --- |\n| a | b |\n',
    );
  });

  it('pads a short row to the width of the widest one', () => {
    assert.equal(
      htmlToDiffText('<table><tr><td>a</td></tr><tr><td>b</td><td>c</td></tr></table>'),
      '| a |  |\n| --- | --- |\n| b | c |\n',
    );
  });

  it('escapes a pipe inside a cell so it does not open a column', () => {
    assert.equal(
      htmlToDiffText('<table><tr><td>a|b</td></tr></table>'),
      String.raw`| a\|b |` + '\n| --- |\n',
    );
  });

  it('flattens a multi-line cell onto its row', () => {
    assert.equal(
      htmlToDiffText('<table><tr><td><p>one</p><p>two</p></td></tr></table>'),
      '| one two |\n| --- |\n',
    );
  });

  it('ignores a thead or tbody wrapper around the rows', () => {
    assert.equal(
      htmlToDiffText('<table><thead><tr><td>h</td></tr></thead><tbody><tr><td>b</td></tr></tbody></table>'),
      '| h |\n| --- |\n| b |\n',
    );
  });
});

describe('Diff text: parsing', () => {
  it('decodes the entities mammoth escapes', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), `a & b <c> "d" 'e'`);
    assert.equal(decodeEntities('&#x41;&#66;'), 'AB');
    assert.equal(decodeEntities('no entities here'), 'no entities here');
  });

  it('leaves an entity it does not know alone', () => {
    assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;');
  });

  it('treats a non-breaking space as a space', () => {
    assert.equal(htmlToDiffText('<p>a&nbsp;&nbsp;b</p>'), 'a b\n');
  });

  it('reads attribute values in either quoting style, or none', () => {
    const [element] = parseHtml('<img src="a" alt=\'b\' width=30 hidden>');
    assert.ok(element && element.type === 'element');
    assert.deepEqual(element.attributes, { src: 'a', alt: 'b', width: '30', hidden: '' });
  });

  it('survives an unclosed element', () => {
    assert.equal(htmlToDiffText('<p>One<p>Two'), 'One\n\nTwo\n');
  });

  it('ignores a closing tag that was never opened', () => {
    assert.equal(htmlToDiffText('</span><p>Text</p></div>'), 'Text\n');
  });

  it('skips comments and doctypes', () => {
    assert.equal(htmlToDiffText('<!DOCTYPE html><!-- note --><p>Text</p>'), 'Text\n');
  });

  it('keeps a bare angle bracket as text', () => {
    assert.equal(htmlToDiffText('<p>2 < 3</p>'), '2 < 3\n');
  });

  it('recurses into an element it does not know rather than dropping it', () => {
    assert.equal(htmlToDiffText('<article><p>Text</p></article>'), 'Text\n');
  });
});

/** How many lines differ between two revisions, counting each side once. */
function differingLines(before: string, after: string): number {
  const left = before.split('\n');
  const right = after.split('\n');
  const shared = new Set(left);
  return right.filter((line) => line !== '' && !shared.has(line)).length;
}
