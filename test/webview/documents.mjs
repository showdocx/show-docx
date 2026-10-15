import {
  Bookmark,
  Document,
  ExternalHyperlink,
  InternalHyperlink,
  Packer,
  Paragraph,
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
export async function linksDocument() {
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
}

/**
 * Turkish text, where the dotted capital I lowercases to two code units and
 * the dotless i has no Latin case pair. The second paragraph's match sits in
 * the same text node as six of them.
 */
export async function turkishDocument() {
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
}

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
