import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  levelFromName,
  readCommentOrder,
  readComments,
  readDocumentStructure,
  readHeadingStyles,
  readRevisions,
} from '../../src/text/documentStructure';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

function style(styleId: string, body: string): string {
  return `<w:style w:type="paragraph" w:styleId="${styleId}">${body}</w:style>`;
}

describe('Which paragraph styles are headings', () => {
  it('believes the outline level the document declares', () => {
    const xml = style('Kop1', '<w:name w:val="Overskrift 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>')
      + style('Kop2', '<w:name w:val="Overskrift 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>');

    const headings = readHeadingStyles(xml);

    // Neither style is named in English, and neither id is Word's own. The
    // document says what they are, which is the whole point.
    assert.deepEqual(headings.map((heading) => [heading.styleId, heading.level]), [
      ['Kop1', 1],
      ['Kop2', 2],
    ]);
  });

  it('falls back to the canonical style name when no level is declared', () => {
    // Word stores the English name and localizes only what it shows, and
    // documents written by other tools often omit the outline level entirely.
    const xml = style('Heading1', '<w:name w:val="heading 1"/>')
      + style('Title', '<w:name w:val="Title"/>');

    assert.deepEqual(readHeadingStyles(xml).map((heading) => heading.level), [1, 1]);
  });

  it('inherits a level from the style a heading is based on', () => {
    const xml = style('Heading2', '<w:name w:val="heading 2"/>')
      + style('SpecClause', '<w:name w:val="Spec Clause"/><w:basedOn w:val="Heading2"/>');

    const clause = readHeadingStyles(xml).find((heading) => heading.styleId === 'SpecClause');
    assert.equal(clause?.level, 2);
  });

  it('does not treat an ordinary style as a heading', () => {
    // The old outline matched class names against the words "heading" and
    // "title", so a caption or a table-of-contents style became an entry.
    const xml = style('Normal', '<w:name w:val="Normal"/>')
      + style('Caption', '<w:name w:val="caption"/>')
      + style('TOCHeading', '<w:name w:val="TOC Heading"/>');

    assert.deepEqual(readHeadingStyles(xml), []);
  });

  it('survives a style based on itself', () => {
    const xml = style('Loop', '<w:name w:val="Loop"/><w:basedOn w:val="Loop"/>');
    assert.deepEqual(readHeadingStyles(xml), []);
  });

  it('ignores character styles, which are not paragraphs', () => {
    assert.deepEqual(
      readHeadingStyles('<w:style w:type="character" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'),
      [],
    );
  });

  it('reads levels out of a real document', async () => {
    const data = new Uint8Array(await readFile(path.join(FIXTURES, 'with-headings.docx')));

    const { headingStyles } = await readDocumentStructure(data);
    const byId = new Map(headingStyles.map((heading) => [heading.styleId, heading.level]));

    assert.equal(byId.get('Heading1'), 1);
    assert.equal(byId.get('Heading2'), 2);
    assert.equal(byId.get('Heading3'), 3);
    assert.equal(byId.get('Title'), 1);
  });
});

describe('Naming a heading level', () => {
  it('reads the built-in names', () => {
    assert.equal(levelFromName('heading 1'), 1);
    assert.equal(levelFromName('Heading 6'), 6);
    assert.equal(levelFromName('heading9'), 9);
    assert.equal(levelFromName('Title'), 1);
    assert.equal(levelFromName('Subtitle'), 2);
  });

  it('does not read a name that merely contains one', () => {
    assert.equal(levelFromName('TOC Heading'), undefined);
    assert.equal(levelFromName('Heading Note'), undefined);
    assert.equal(levelFromName('Untitled'), undefined);
  });
});

describe('Comments a document records', () => {
  const comments = '<w:comments>'
    + '<w:comment w:id="1" w:author="Alice" w:initials="AR" w:date="2026-01-01T00:00:00Z">'
    + '<w:p w14:paraId="AAAA"><w:r><w:t>Please clarify</w:t></w:r></w:p></w:comment>'
    + '<w:comment w:id="2" w:author="Bo" w:date="2026-01-02T00:00:00Z">'
    + '<w:p w14:paraId="BBBB"><w:r><w:t>Agreed</w:t></w:r></w:p></w:comment>'
    + '</w:comments>';

  it('reads the author, date and text of each one', () => {
    const [first] = readComments(comments, '');

    assert.equal(first?.id, '1');
    assert.equal(first?.author, 'Alice');
    assert.equal(first?.initials, 'AR');
    assert.equal(first?.text, 'Please clarify');
  });

  it('marks a comment the document records as done', () => {
    const extended = '<w15:commentEx w15:paraId="AAAA" w15:done="1"/>';

    const [first, second] = readComments(comments, extended);

    assert.equal(first?.resolved, true);
    assert.equal(second?.resolved, undefined);
  });

  it('records which comment a reply answers', () => {
    const extended = '<w15:commentEx w15:paraId="AAAA"/>'
      + '<w15:commentEx w15:paraId="BBBB" w15:paraIdParent="AAAA"/>';

    const [, second] = readComments(comments, extended);

    assert.equal(second?.replyTo, '1');
  });

  it('reads a document that records no comments', () => {
    assert.deepEqual(readComments('', ''), []);
  });

  it('names an author the document leaves out', () => {
    const [only] = readComments('<w:comment w:id="9"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment>', '');
    assert.equal(only?.author, 'Unknown');
  });

  it('lists the anchors in reading order, not the order they are stored', () => {
    const body = '<w:commentRangeStart w:id="7"/><w:commentRangeStart w:id="3"/>'
      + '<w:commentRangeStart w:id="7"/>';
    assert.deepEqual(readCommentOrder(body), ['7', '3']);
  });
});

describe('Tracked changes a document records', () => {
  it('reads an insertion with who made it', () => {
    const body = '<w:ins w:author="Alice" w:date="2026-01-01T00:00:00Z">'
      + '<w:r><w:t>an inserted phrase</w:t></w:r></w:ins>';

    assert.deepEqual(readRevisions(body), [{
      type: 'insertion',
      author: 'Alice',
      date: '2026-01-01T00:00:00Z',
      text: 'an inserted phrase',
    }]);
  });

  it('recovers the text a deletion removed', () => {
    // Deleted text is stored in w:delText, which the search index drops on
    // purpose. The panel is the one place it has to be readable.
    const body = '<w:del w:author="Bo"><w:r><w:delText>a deleted phrase</w:delText></w:r></w:del>';

    const [deletion] = readRevisions(body);

    assert.equal(deletion?.type, 'deletion');
    assert.equal(deletion?.text, 'a deleted phrase');
  });

  it('skips a change that removed nothing readable', () => {
    assert.deepEqual(readRevisions('<w:ins w:author="A"><w:r/></w:ins>'), []);
  });

  it('reads both kinds out of a real document', async () => {
    const data = new Uint8Array(await readFile(path.join(FIXTURES, 'with-comments.docx')));

    const { comments, revisions } = await readDocumentStructure(data);

    assert.equal(comments[0]?.author, 'Alice Reviewer');
    assert.deepEqual(revisions.map((revision) => revision.type), ['insertion', 'deletion']);
    assert.equal(revisions[1]?.text, 'a deleted phrase');
  });
});
