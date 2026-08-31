import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  countWords,
  readDocumentProperties,
  readMedia,
  describeDocument,
  imageName,
  readTag,
  readingMinutes,
} from '../../src/text/documentFacts';
import { formatDate, toRows } from '../../webview-src/propertyRows';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

describe('What a document says about itself', () => {
  it('reads the properties a package states', async () => {
    const properties = await readDocumentProperties(await fixture('simple.docx'));

    assert.equal(properties.title, 'ShowDocx sample document');
    assert.equal(properties.creator, 'ShowDocx');
    assert.equal(properties.revision, '1');
    assert.ok(properties.created?.startsWith('2026-'));
  });

  it('leaves out what a document does not state', async () => {
    const properties = await readDocumentProperties(await fixture('with-images.docx'));

    // Absent is not the same as empty: a panel of blank fields says nothing.
    assert.equal(properties.title, undefined);
    assert.equal(properties.company, undefined);
    assert.ok(properties.creator);
  });

  it('reads a package with no property parts without failing', async () => {
    assert.deepEqual(await readDocumentProperties(await fixture('empty.docx')), {
      creator: 'Un-named',
      lastModifiedBy: 'Un-named',
      revision: '1',
      created: (await readDocumentProperties(await fixture('empty.docx'))).created,
      modified: (await readDocumentProperties(await fixture('empty.docx'))).modified,
    });
  });
});

describe('Reading a single XML tag', () => {
  it('reads the text of the element', () => {
    assert.equal(readTag('<a><dc:title>Report</dc:title></a>', 'dc:title'), 'Report');
  });

  it('reads an element that carries attributes', () => {
    assert.equal(
      readTag('<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02</dcterms:created>', 'dcterms:created'),
      '2026-01-02',
    );
  });

  it('decodes what the XML escaped', () => {
    assert.equal(readTag('<dc:creator>Ben &amp; Jerry</dc:creator>', 'dc:creator'), 'Ben & Jerry');
  });

  it('reports an absent or empty element as nothing', () => {
    assert.equal(readTag('<a/>', 'dc:title'), undefined);
    assert.equal(readTag('<dc:title>   </dc:title>', 'dc:title'), undefined);
  });

  it('does not confuse a tag with one whose name starts the same', () => {
    assert.equal(readTag('<Pages>4</Pages><PagesPerSheet>2</PagesPerSheet>', 'Pages'), '4');
  });
});

describe('Images stored in a document', () => {
  it('finds the pictures in the package', async () => {
    const media = await readMedia(await fixture('with-images.docx'));

    assert.equal(media.length, 1);
    assert.ok(media[0]?.name.startsWith('word/media/'));
    assert.ok((media[0]?.bytes.byteLength ?? 0) > 0);
  });

  it('finds none in a document that has none', async () => {
    assert.deepEqual(await readMedia(await fixture('simple.docx')), []);
  });

  it('names an extracted file after the document it came from', () => {
    // The name inside the package is Word's own, often a content hash, which
    // says nothing to anyone looking at the folder afterwards.
    assert.equal(imageName('spec', 0, 3, 'word/media/9f8a7b.png'), 'spec-1.png');
    assert.equal(imageName('spec', 9, 12, 'word/media/x.JPEG'), 'spec-10.jpeg');
  });

  it('pads the numbers so the files sort the way they appear', () => {
    assert.equal(imageName('spec', 0, 100, 'a.png'), 'spec-001.png');
    assert.equal(imageName('spec', 0, 9, 'a.png'), 'spec-1.png');
  });

  it('falls back to a neutral extension for a part that has none', () => {
    assert.equal(imageName('spec', 0, 1, 'word/media/image'), 'spec-1.bin');
  });
});

describe('Counting a document', () => {
  it('counts words between whitespace', () => {
    assert.equal(countWords('one two three'), 3);
    assert.equal(countWords('  padded   words \n across lines '), 4);
  });

  it('counts nothing in nothing', () => {
    assert.equal(countWords(''), 0);
    assert.equal(countWords('   \n  '), 0);
  });

  it('turns a word count into whole minutes, never rounding down to zero', () => {
    assert.equal(readingMinutes(0), 0);
    assert.equal(readingMinutes(10), 1);
    assert.equal(readingMinutes(200), 1);
    assert.equal(readingMinutes(6480), 32);
  });
});

describe('Describing a document in the status bar', () => {
  it('reads as a sentence about the document', () => {
    assert.equal(
      describeDocument({ pages: 24, words: 6480 }),
      '24 pages · 6,480 words · ~32 min read',
    );
  });

  it('leaves out pages when nothing knows them', () => {
    assert.equal(describeDocument({ words: 120 }), '120 words · ~1 min read');
  });

  it('gets the singular right', () => {
    assert.equal(describeDocument({ pages: 1, words: 1 }), '1 page · 1 word · ~1 min read');
  });
});

describe('Listing the properties for a reader', () => {
  it('puts identity before machinery', () => {
    const rows = toRows({ application: 'Word', creator: 'A Writer', title: 'Report' });
    assert.deepEqual(rows.map((row) => row.label), ['Title', 'Author', 'Application']);
  });

  it('has nothing to list for a document that states nothing', () => {
    assert.deepEqual(toRows({}), []);
    assert.deepEqual(toRows(undefined), []);
  });

  it('leaves out a value that is only whitespace', () => {
    assert.deepEqual(toRows({ creator: '   ' }), []);
  });

  it('shows a date the way the reader s machine writes it', () => {
    const formatted = formatDate('2026-01-02T03:04:05Z');
    assert.ok(formatted);
    assert.notEqual(formatted, '2026-01-02T03:04:05Z');
    assert.ok(formatted?.includes('2026'));
  });

  it('shows a date it cannot parse as the document stored it', () => {
    // Still what the document says, which beats dropping the field.
    assert.equal(formatDate('sometime last spring'), 'sometime last spring');
    assert.equal(formatDate(undefined), undefined);
  });
});
