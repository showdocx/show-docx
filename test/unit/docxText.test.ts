import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import { convertDocxToPlainText, convertDocxToText } from '../../src/text/docxText';
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

  it('represents an embedded image by a digest, not its bytes', async () => {
    const text = await convert('with-images.docx');

    assert.match(text, /!\[[^\]]*]\(docx-image:[0-9a-f]{8}\)/);
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

  it('is always eight hex characters', () => {
    for (const value of ['', 'a', 'a much longer value to hash']) {
      assert.match(fingerprintText(value), /^[0-9a-f]{8}$/);
    }
  });
});
