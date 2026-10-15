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

  it('places a comment on a point, which has a reference and no range', () => {
    const body = '<w:commentRangeStart w:id="1"/><w:r><w:commentReference w:id="4"/></w:r>'
      + '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>';
    assert.deepEqual(readCommentOrder(body), ['1', '4']);
  });

  it('decodes the entities an author name is stored with', () => {
    const [only] = readComments(
      '<w:comment w:id="2" w:author="Smith &amp; Jones &#x2014; Legal"><w:p><w:r><w:t>x</w:t></w:r></w:p></w:comment>',
      '',
    );
    assert.equal(only?.author, 'Smith & Jones — Legal');
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

  it('records the id the rendered page carries', () => {
    const [insertion] = readRevisions('<w:ins w:id="12" w:author="A"><w:r><w:t>x</w:t></w:r></w:ins>');
    assert.equal(insertion?.id, '12');
  });

  it('reads nothing into a paragraph mark marked as deleted', () => {
    // Joining two paragraphs with tracking on deletes the mark between them.
    // Word writes that as a self-closing w:del, which holds no text; read as an
    // opening tag, it swallowed the untouched paragraph after it and the next
    // real deletion, under the wrong author.
    const body = '<w:p><w:pPr><w:rPr><w:del w:id="3" w:author="Ayse" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>'
      + '<w:r><w:t>Never deleted.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Plain paragraph.</w:t></w:r>'
      + '<w:del w:id="4" w:author="Mehmet"><w:r><w:delText>really deleted</w:delText></w:r></w:del></w:p>';

    assert.deepEqual(readRevisions(body), [{
      type: 'deletion',
      id: '4',
      author: 'Mehmet',
      date: undefined,
      text: 'really deleted',
    }]);
  });

  it('reads nothing into a paragraph mark or a table row marked as inserted', () => {
    const body = '<w:tr><w:trPr><w:ins w:id="1" w:author="A"/></w:trPr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:p><w:pPr><w:rPr><w:ins w:id="2" w:author="A"/></w:rPr></w:pPr><w:r><w:t>Split here.</w:t></w:r></w:p>'
      + '<w:p><w:ins w:id="5" w:author="B"><w:r><w:t>added</w:t></w:r></w:ins></w:p>';

    assert.deepEqual(readRevisions(body).map((revision) => [revision.id, revision.author, revision.text]), [
      ['5', 'B', 'added'],
    ]);
  });

  it('lists text one reviewer inserted and another deleted as both', () => {
    const body = '<w:ins w:id="7" w:author="A"><w:r><w:t>kept </w:t></w:r>'
      + '<w:del w:id="8" w:author="B"><w:r><w:delText>struck</w:delText></w:r></w:del></w:ins>';

    assert.deepEqual(readRevisions(body).map((revision) => [revision.type, revision.author, revision.text]), [
      ['insertion', 'A', 'kept'],
      ['deletion', 'B', 'struck'],
    ]);
  });

  it('reads both kinds out of a real document', async () => {
    const data = new Uint8Array(await readFile(path.join(FIXTURES, 'with-comments.docx')));

    const { comments, revisions } = await readDocumentStructure(data);

    assert.equal(comments[0]?.author, 'Alice Reviewer');
    assert.deepEqual(revisions.map((revision) => revision.type), ['insertion', 'deletion']);
    assert.equal(revisions[1]?.text, 'a deleted phrase');
  });
});
