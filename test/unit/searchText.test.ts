import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  extractSearchText,
  findMatches,
  snippet,
  xmlToLines,
} from '../../src/text/searchText';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

/** Wraps runs in the paragraph markup Word actually writes. */
function paragraph(...runs: string[]): string {
  return `<w:p><w:r>${runs.map((run) => `<w:t>${run}</w:t>`).join('')}</w:r></w:p>`;
}

describe('Reading a document as searchable lines', () => {
  it('writes one line per paragraph', () => {
    assert.equal(
      xmlToLines(`<w:body>${paragraph('First')}${paragraph('Second')}</w:body>`),
      'First\nSecond',
    );
  });

  it('joins the runs a paragraph is split into', () => {
    // Word splits a sentence across runs at every formatting change, so a
    // phrase is only findable if the runs are put back together.
    assert.equal(
      xmlToLines(`<w:p><w:r><w:t>This includes </w:t></w:r><w:r><w:t>bold</w:t></w:r></w:p>`),
      'This includes bold',
    );
  });

  it('decodes the entities the XML escapes', () => {
    assert.equal(xmlToLines(paragraph('Ben &amp; Jerry &lt;x&gt;')), 'Ben & Jerry <x>');
  });

  it('turns a tab and a line break into whitespace', () => {
    assert.equal(
      xmlToLines('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>'),
      'a b\nc',
    );
  });

  it('drops field codes, which the reader never sees', () => {
    const xml = `<w:p><w:r><w:instrText> HYPERLINK "https://example.com" </w:instrText></w:r>`
      + `<w:r><w:t>Example</w:t></w:r></w:p>`;
    const lines = xmlToLines(xml);

    assert.equal(lines, 'Example');
    assert.ok(!lines.includes('HYPERLINK'));
  });

  it('drops text a tracked change deleted', () => {
    // The viewer shows it as removed, so a match would send someone to a line
    // that is not there.
    const xml = `<w:p><w:r><w:t>Kept </w:t></w:r><w:r><w:delText>removed</w:delText></w:r></w:p>`;
    assert.equal(xmlToLines(xml), 'Kept');
  });

  it('drops empty paragraphs and collapses whitespace', () => {
    assert.equal(
      xmlToLines(`${paragraph('  spaced   out  ')}<w:p/>${paragraph('next')}`),
      'spaced out\nnext',
    );
  });

  it('reads nothing out of nothing', () => {
    assert.equal(xmlToLines(''), '');
    assert.equal(xmlToLines('<w:body></w:body>'), '');
  });
});

describe('Reading a real document', () => {
  it('finds the words the reader sees', async () => {
    const data = await readFile(path.join(FIXTURES, 'simple.docx'));

    const text = await extractSearchText(new Uint8Array(data));

    assert.ok(text.includes('ShowDocx Sample'));
    assert.ok(text.includes('Zoom and state persistence'));
    assert.ok(!text.includes('<w:'), 'no markup may survive');
    assert.ok(!text.includes('PK'), 'no archive bytes may survive');
  });

  it('finds a phrase that spans a formatting change', async () => {
    const data = await readFile(path.join(FIXTURES, 'simple.docx'));

    const text = await extractSearchText(new Uint8Array(data));

    // "includes bold" straddles a run boundary in the fixture.
    assert.ok(text.includes('includes bold'), text.slice(0, 200));
  });

  it('reads the header, where a document number or title usually lives', async () => {
    const data = await readFile(path.join(FIXTURES, 'with-tables.docx'));

    const text = await extractSearchText(new Uint8Array(data));

    // The fixture's header carries "ShowDocx fixture"; it is in word/header1.xml,
    // not in the body, and it is text the viewer shows.
    assert.ok(text.includes('ShowDocx fixture'), text);
  });

  it('reads the body before anything else, so line numbers are stable', async () => {
    const data = new Uint8Array(await readFile(path.join(FIXTURES, 'with-tables.docx')));

    const first = await extractSearchText(data);
    const second = await extractSearchText(data);

    assert.equal(first, second);
    assert.ok(
      first.indexOf('Table Rendering') < first.indexOf('ShowDocx fixture'),
      'the body should come before the header',
    );
  });

  it('reads a document with no body text without failing', async () => {
    const data = await readFile(path.join(FIXTURES, 'empty.docx'));
    const text = await extractSearchText(new Uint8Array(data));
    // empty.docx still carries the fixture header, so "no body text" is not
    // the same as no text at all.
    assert.ok(!text.includes('<w:'));
  });
});

describe('Finding matches in a document', () => {
  const text = 'First line about apples\nSecond line\nApples again, apples twice';

  it('finds every occurrence, on every line', () => {
    const { matches, truncated } = findMatches(text, 'apples', 100);

    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((match) => match.line), [0, 2, 2]);
    assert.equal(truncated, false);
  });

  it('ignores case', () => {
    assert.equal(findMatches(text, 'APPLES', 100).matches.length, 3);
  });

  it('matches literally, not as a pattern', () => {
    // Someone searching a specification for "s. 4(a)" means those characters.
    assert.equal(findMatches('clause s. 4(a) applies', 's. 4(a)', 10).matches.length, 1);
    assert.equal(findMatches('a b c', '.', 10).matches.length, 0);
  });

  it('reports where on the line the match starts', () => {
    const [match] = findMatches('the word here', 'word', 10).matches;
    assert.equal(match?.column, 4);
    assert.equal(match?.text, 'the word here');
  });

  it('stops at the limit and says it did', () => {
    const { matches, truncated } = findMatches(text, 'apples', 2);

    assert.equal(matches.length, 2);
    assert.equal(truncated, true);
  });

  it('finds nothing in nothing', () => {
    assert.deepEqual(findMatches('', 'x', 10), { matches: [], truncated: false });
    assert.deepEqual(findMatches('text', '', 10), { matches: [], truncated: false });
  });

  it('does not loop on overlapping occurrences', () => {
    assert.equal(findMatches('aaaa', 'aa', 10).matches.length, 2);
  });
});

describe('Showing a match in context', () => {
  it('leaves a short line whole', () => {
    const line = 'a short line';
    assert.equal(snippet({ line: 0, text: line, column: 2 }, 5), line);
  });

  it('windows a long line around the match', () => {
    const text = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;

    const result = snippet({ line: 0, text, column: 300 }, 6, 60);

    assert.ok(result.includes('NEEDLE'));
    assert.ok(result.length < 80);
    assert.ok(result.startsWith('...'));
    assert.ok(result.endsWith('...'));
  });

  it('does not open with an ellipsis when the match is at the start', () => {
    const text = `NEEDLE${'b'.repeat(300)}`;
    const result = snippet({ line: 0, text, column: 0 }, 6, 60);

    assert.ok(result.startsWith('NEEDLE'));
    assert.ok(result.endsWith('...'));
  });
});
