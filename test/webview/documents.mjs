import {
  Bookmark,
  Document,
  ExternalHyperlink,
  InternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  SectionType,
  TextRun,
} from 'docx';
import JSZip from 'jszip';

/**
 * Documents built for a single webview test, served in place of a fixture.
 *
 * The committed fixtures are shared by every suite and regenerating them churns
 * every binary, so a scenario only the webview needs — a hostile link, an
 * embedded HTML chunk — is built here, at test time, from the same library.
 */

/** Builds a document once per run, however many tests serve it. */
function once(build) {
  let built;
  return () => {
    built ??= build();
    return built;
  };
}

/** Serves a document the harness will load as `?fixture=<name>`. */
export async function serveDocument(page, name, bytes) {
  await page.route(`**/test/fixtures/${name}`, (route) => route.fulfill({
    body: bytes,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }));
}

function link(text, target) {
  return new Paragraph({
    children: [
      new ExternalHyperlink({
        link: target,
        children: [new TextRun({ text, style: 'Hyperlink' })],
      }),
    ],
  });
}

/**
 * One link of every kind the viewer has to decide about, a bookmark far enough
 * down to need scrolling to, and an embedded HTML chunk.
 */
export const linksDocument = once(async () => {
  const filler = Array.from({ length: 80 }, (_, index) => new Paragraph(`Filler paragraph ${index + 1}.`));
  const document = new Document({
    sections: [{
      children: [
        link('Example site', 'https://example.com/spec'),
        link('Write to us', 'mailto:team@example.com'),
        link('Clone this repository', 'vscode://vscode.git/clone?url=https%3A%2F%2Fexample.com%2Frepo.git'),
        link('Local file', 'file:///C:/Windows/win.ini'),
        new Paragraph({
          children: [
            new InternalHyperlink({
              anchor: 'targetbookmark',
              children: [new TextRun({ text: 'Go to the target', style: 'Hyperlink' })],
            }),
          ],
        }),
        ...filler,
        new Paragraph({
          children: [new Bookmark({ id: 'targetbookmark', children: [new TextRun('The target paragraph')] })],
        }),
      ],
    }],
  });
  return withAltChunk(await Packer.toBuffer(document), '<html><body><p>Embedded HTML chunk</p></body></html>');
});

/**
 * Turkish text, where the dotted capital I lowercases to two code units and
 * the dotless i has no Latin case pair. The second paragraph's match sits in
 * the same text node as six of them.
 */
export const turkishDocument = once(async () => {
  const dotted = String.fromCharCode(0x130);
  const document = new Document({
    sections: [{
      children: [
        new Paragraph(`${dotted}STANBUL ${dotted}ZM${dotted}R ${dotted}LET${dotted}Ş${dotted}M hedef kelime burada.`),
        new Paragraph(`${dotted.repeat(6)} ab`),
        new Paragraph('IRMAK kenarında'),
      ],
    }],
  });
  return Packer.toBuffer(document);
});

/** Stands in for a run; replaced with the marker Word writes where a page began. */
const PAGE_MARK = 'PAGEMARK';

/**
 * Four pages the way Word records them: `w:lastRenderedPageBreak` where each
 * page began when Word last laid the document out.
 *
 * 1. "Page one", item 1 and the first half of item 2
 * 2. the rest of item 2 — the same list item, so not numbered again — and item 3
 * 3. a paragraph the mark starts, then a continuous section on the same page
 * 4. a section that starts on a new page, which says so and has no mark
 */
export const paginatedDocument = once(async () => {
  const item = (...runs) => new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: runs });
  const mark = () => new TextRun(PAGE_MARK);
  const document = new Document({
    numbering: {
      config: [{ reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.' }] }],
    },
    sections: [
      {
        children: [
          new Paragraph('Page one'),
          item(new TextRun('Item one')),
          item(new TextRun('Item two, first half '), mark(), new TextRun('second half')),
          item(new TextRun('Item three')),
          new Paragraph({ children: [mark(), new TextRun('Third page starts here')] }),
        ],
      },
      { properties: { type: SectionType.CONTINUOUS }, children: [new Paragraph('Continuous section text')] },
      { properties: { type: SectionType.NEXT_PAGE }, children: [new Paragraph('Fourth page')] },
    ],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
  const body = await zip.file('word/document.xml').async('text');
  const marked = body.replaceAll(
    new RegExp(`<w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t[^>]*>${PAGE_MARK}</w:t></w:r>`, 'g'),
    '<w:r><w:lastRenderedPageBreak/></w:r>',
  );
  if (marked.includes(PAGE_MARK)) {
    throw new Error('A page mark was not replaced.');
  }
  zip.file('word/document.xml', marked);
  return zip.generateAsync({ type: 'nodebuffer' });
});

/** Adds an `altChunk` — HTML Word embeds as-is — at the end of the body. */
async function withAltChunk(bytes, html) {
  const zip = await JSZip.loadAsync(bytes);
  zip.file('word/chunk.html', html);

  const relsName = 'word/_rels/document.xml.rels';
  const rels = await zip.file(relsName).async('text');
  zip.file(relsName, rels.replace(
    '</Relationships>',
    '<Relationship Id="rIdAltChunk1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>',
  ));

  const types = await zip.file('[Content_Types].xml').async('text');
  zip.file('[Content_Types].xml', types.replace(
    '</Types>',
    '<Default Extension="html" ContentType="text/html"/></Types>',
  ));

  const body = await zip.file('word/document.xml').async('text');
  zip.file('word/document.xml', body.replace('<w:sectPr', '<w:altChunk r:id="rIdAltChunk1"/><w:sectPr'));
  return zip.generateAsync({ type: 'nodebuffer' });
}
