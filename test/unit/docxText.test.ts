import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import JSZip from 'jszip';
import { convertDocxToPlainText, convertDocxToText, makeVisibleDocxBytes } from '../../src/text/docxText';
import { loadAndValidateZip, zipValidationOptionsFor } from '../../src/docxLoader';
import { fingerprintBytes, fingerprintText } from '../../src/text/fingerprint';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

async function convert(fixture: string): Promise<string> {
  const data = await readFile(path.join(FIXTURES, fixture));
  const result = await convertDocxToText(new Uint8Array(data));
  return result.text;
}

describe('DOCX to diff text', () => {
  it('keeps the document structure a reader needs to locate a change', async () => {
    const text = await convert('with-headings.docx');

    assert.ok(text.includes('# Chapter 1: Getting Started'));
    assert.ok(text.includes('## 1.1 Installation'));
    assert.ok(text.includes('This is the introduction section.'));
  });

  it('does not escape ordinary punctuation the way a Markdown writer would', async () => {
    const text = await convert('simple.docx');

    assert.ok(text.includes('High-fidelity'), 'a hyphen must stay a hyphen');
    assert.ok(!text.includes(String.raw`\-`));
    assert.ok(!text.includes(String.raw`\.`));
  });

  it('keeps a table as rows rather than loose paragraphs', async () => {
    const text = await convert('with-tables.docx');

    assert.ok(text.includes('| **Feature** | **Visual mode** | **Text mode** |'));
    assert.ok(text.includes('| Page layout | Preserved | Simplified |'));
  });

  it('bounds Markdown expansion from a tiny compressed DOCX with a wide, sparse table', async () => {
    const zip = await JSZip.loadAsync(await readFile(path.join(FIXTURES, 'empty.docx')));
    const cell = (text: string, span = 1): string => '<w:tc><w:tcPr>'
      + `<w:gridSpan w:val="${span}"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>'
      + `<w:tr>${cell('wide', 1000)}</w:tr>`
      + `<w:tr>${cell('narrow')}</w:tr>`.repeat(12000)
      + '</w:tbl></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    assert.ok(bytes.length < 20000, `expected a small PoC package, got ${bytes.length} bytes`);
    const { text } = await convertDocxToText(bytes);
    const cells = text.split('\n').filter((line) => line.startsWith('|'))
      .reduce((total, line) => total + (line.match(/\|/g)?.length ?? 1) - 1, 0);
    assert.ok(cells <= 100000, `expanded to ${cells} Markdown cells`);
    assert.ok(text.length < 400000);
    assert.ok(text.includes('[table truncated: safety limit reached]'));
  });

  it('resolves visibility once instead of letting renderers re-hide visible overrides', async () => {
    const zip = await JSZip.loadAsync(await readFile(path.join(FIXTURES, 'empty.docx')));
    const namespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    zip.file('word/styles.xml', `<w:styles ${namespace}>`
      + '<w:style w:type="character" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>'
      + '<w:style w:type="character" w:styleId="Visible"><w:basedOn w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>'
      + '</w:styles>');
    zip.file('word/document.xml', `<w:document ${namespace}><w:body><w:p>`
      + '<w:r><w:rPr><w:rStyle w:val="Hidden"/></w:rPr><w:t>SECRET_HIDDEN</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="Hidden"/><w:vanish w:val="0"/></w:rPr><w:t>VISIBLE_OVERRIDE</w:t></w:r>'
      + '<w:r><w:rPr><w:rStyle w:val="Visible"/></w:rPr><w:t>VISIBLE_TOGGLE</w:t></w:r>'
      + '</w:p></w:body></w:document>');
    const data = await zip.generateAsync({ type: 'uint8array' });
    const prepared = await makeVisibleDocxBytes(data, await loadAndValidateZip(data));
    const visible = await loadAndValidateZip(prepared);
    const xml = await visible.file('word/document.xml')!.async('text');
    const styles = await visible.file('word/styles.xml')!.async('text');
    assert.ok(!xml.includes('SECRET_HIDDEN'));
    assert.ok(xml.includes('VISIBLE_OVERRIDE'));
    assert.ok(xml.includes('VISIBLE_TOGGLE'));
    assert.ok(!/<w:(?:vanish|specVanish)\b/.test(xml + styles));
    assert.equal(await makeVisibleDocxBytes(prepared, visible), prepared, 'already prepared bytes need no rewrite');
    const { text } = await convertDocxToPlainText(prepared);
    assert.ok(text.includes('VISIBLE_OVERRIDE') && text.includes('VISIBLE_TOGGLE'));
    assert.ok(!text.includes('SECRET_HIDDEN'));
  });

  it('represents an embedded image by a digest, not its bytes', async () => {
    const text = await convert('with-images.docx');

    assert.match(text, /!\[[^\]]*]\(docx-image:[0-9a-f]{64}\)/);
    assert.ok(text.length < 2000, 'the image bytes must not reach the text');
  });

  it('produces the same text every time, so an unchanged file has an empty diff', async () => {
    assert.equal(await convert('simple.docx'), await convert('simple.docx'));
  });

  it('ends with exactly one newline', async () => {
    const text = await convert('simple.docx');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
  });

  it('reads a document with no body text without failing', async () => {
    assert.equal(await convert('empty.docx'), '');
  });
});
describe('DOCX to plain text', () => {
  async function plain(fixture: string): Promise<string> {
    const data = await readFile(path.join(FIXTURES, fixture));
    const result = await convertDocxToPlainText(new Uint8Array(data));
    return result.text;
  }

  it('carries the words with none of the markup', async () => {
    const text = await plain('simple.docx');

    assert.ok(text.includes('ShowDocx Sample'));
    assert.ok(text.includes('High-fidelity'));
    assert.ok(!text.includes('#'), 'a heading marker would be read as text');
    assert.ok(!text.includes('**'), 'an emphasis marker would be read as text');
  });

  it('reads a table as its cell contents', async () => {
    const text = await plain('with-tables.docx');

    assert.ok(text.includes('Page layout'));
    assert.ok(!text.includes('|'), 'a pipe table would be read as text');
  });

  it('leaves no run of blank lines behind', async () => {
    const text = await plain('with-headings.docx');
    assert.ok(!text.includes('\n\n\n'));
    assert.ok(text.endsWith('\n'));
  });

  it('returns nothing for a document with no text', async () => {
    assert.equal(await plain('empty.docx'), '');
  });
});

describe('Fingerprints', () => {
  it('gives identical content an identical digest', () => {
    assert.equal(fingerprintText('same'), fingerprintText('same'));
    assert.equal(
      fingerprintBytes(new Uint8Array([1, 2, 3])),
      fingerprintBytes(new Uint8Array([1, 2, 3])),
    );
  });

  it('gives changed content a different digest', () => {
    assert.notEqual(fingerprintText('one'), fingerprintText('two'));
    assert.notEqual(
      fingerprintBytes(new Uint8Array([1, 2, 3])),
      fingerprintBytes(new Uint8Array([1, 2, 4])),
    );
  });

  it('is always 64 hex characters', () => {
    for (const value of ['', 'a', 'a much longer value to hash']) {
      assert.match(fingerprintText(value), /^[0-9a-f]{64}$/);
    }
  });
});

describe('loadAndValidateZip scaling and protection', () => {
  it('scales ZIP expansion limits with the configured DOCX size limit', () => {
    const megabyte = 1024 * 1024;
    assert.deepEqual(zipValidationOptionsFor(100 * megabyte), {
      maxUncompressedSize: 200 * megabyte,
      maxEntries: 10000,
      maxEntrySize: 100 * megabyte,
    });
    assert.deepEqual(zipValidationOptionsFor(500 * megabyte), {
      maxUncompressedSize: 1000 * megabyte,
      maxEntries: 10000,
      maxEntrySize: 500 * megabyte,
    });
  });

  it('allows a legitimate package with media without hitting rigid uncompressed limits', async () => {
    const zip = await JSZip.loadAsync(await readFile(path.join(FIXTURES, 'empty.docx')));
    const media = Buffer.alloc(25 * 1024 * 1024, 0x42);
    zip.file('word/media/image1.png', media);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    const loaded = await loadAndValidateZip(data);
    assert.ok(loaded.file('word/document.xml'));
  });

  it('rejects a zip bomb with small compressed size and huge uncompressed entry', async function () {
    this.timeout(15_000);
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(105 * 1024 * 1024));
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    await assert.rejects(
      async () => loadAndValidateZip(data, { maxUncompressedSize: 100 * 1024 * 1024 }),
      /exceeds maximum allowed/,
    );
  });
});
