import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import {
  countWords,
  readDocumentProperties,
  readMedia,
  describeDocument,
  freeName,
  imageName,
  isValidImageBytes,
  pageCount,
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

describe('Keeping both when a name is taken', () => {
  it('keeps a name nothing is using', () => {
    assert.equal(freeName('spec-1.png', () => false), 'spec-1.png');
  });

  it('numbers the copy before its extension, past every number already used', () => {
    const taken = new Set(['spec-1.png', 'spec-1 (2).png']);
    assert.equal(freeName('spec-1.png', (name) => taken.has(name)), 'spec-1 (3).png');
  });

  it('numbers a name without an extension at its end', () => {
    assert.equal(freeName('notes', (name) => name === 'notes'), 'notes (2)');
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

  async function mediaPackage(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await fixture('empty.docx'));
    for (const [name, bytes] of Object.entries(files)) {zip.file(`word/media/${name}`, bytes);}
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const xlinkNamespace = 'http://www.w3.org/1999/xlink';
  const svg = (content: string): string => `<svg xmlns="${svgNamespace}" xmlns:l="${xlinkNamespace}">${content}</svg>`;

  async function exportedSvg(content: string) {
    const media = await readMedia(await mediaPackage({ 'image.svg': svg(content) }));
    assert.equal(media.length, 1);
    return new DOMParser().parseFromString(new TextDecoder().decode(media[0]?.bytes), 'image/svg+xml');
  }

  it('checks reference namespace/local names rather than trusting the xlink prefix', async () => {
    const document = await exportedSvg(
      '<a l:href="javascript:alert(1)"><text>click</text></a>'
      + '<image l:href="https://attacker.invalid/image.png"/>'
      + '<use l:href="//attacker.invalid/external.svg#x"/>'
      + '<use l:href="&#x6a;avascript:alert(2)"/>'
      + '<image href="file:///private/image.png"/>'
      + '<a href="data:text/html;base64,PHNjcmlwdD4="/>',
    );
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      assert.equal(element.hasAttribute('href'), false);
      assert.equal(element.hasAttributeNS(xlinkNamespace, 'href'), false);
    }
  });

  it('removes foreign namespaces, scripts, events, base URLs and encoded CSS', async () => {
    const document = await exportedSvg(
      '<script>alert(1)</script><foreignObject><p xmlns="http://www.w3.org/1999/xhtml">bad</p></foreignObject>'
      + '<g xmlns="http://www.w3.org/1999/xhtml"><script>foreign</script><a href="javascript:alert(2)">bad</a></g>'
      + '<g xmlns="urn:foreign"><rect width="5"/></g>'
      + '<g xmlns=""><text>not SVG</text></g>'
      + '<animate attributeName="href" to="javascript:alert(3)"/>'
      + '<style>@import url(https://attacker.invalid/a.css)</style>'
      + '<rect onload="alert(4)" xmlns:b="http://www.w3.org/XML/1998/namespace" b:base="https://attacker.invalid/"/>'
      + '<rect style="fill:u&#x72;l(https://attacker.invalid/a)"/>'
      + String.raw`<rect style="fill:\75rl(https://attacker.invalid/b)"/>`
      + '<rect fill="url(https://attacker.invalid/c)"/>'
      + '<rect style="fill:u/**/rl(https://attacker.invalid/d)"/>'
      + '<rect xmlns:f="urn:foreign" f:href="javascript:alert(5)" f:onload="alert(6)"/>',
    );
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      assert.equal(element.namespaceURI, svgNamespace);
      assert.ok(!['script', 'foreignObject', 'animate', 'style'].includes(element.localName));
      for (const attribute of Array.from(element.attributes)) {
        assert.ok(!/onload|base|style|href/.test(attribute.localName));
        assert.ok(!/attacker|javascript|url\(/i.test(attribute.value));
      }
    }
  });

  it('preserves static SVG geometry, local references and real embedded raster images', async () => {
    const images = await readMedia(await fixture('with-images.docx'));
    const png = Buffer.from(images[0]?.bytes ?? []).toString('base64');
    const document = await exportedSvg(
      '<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient>'
      + '<path id="shape" d="M0 0 L5 5"/></defs>'
      + '<use l:href="#shape" fill="url(#paint)"/>'
      + '<rect width="5" height="7" style="fill:url(#paint);stroke:blue;stroke-width:2"/>'
      + `<image l:href="data:image/png;base64,${png}"/>`,
    );
    assert.equal(document.getElementsByTagName('use').item(0)?.getAttributeNS(xlinkNamespace, 'href'), '#shape');
    assert.equal(document.getElementsByTagName('use').item(0)?.getAttribute('fill'), 'url(#paint)');
    assert.equal(document.getElementsByTagName('rect').item(0)?.getAttribute('width'), '5');
    assert.match(document.getElementsByTagName('rect').item(0)?.getAttribute('style') ?? '', /stroke:blue/);
    assert.equal(document.getElementsByTagName('image').item(0)?.getAttributeNS(xlinkNamespace, 'href'), `data:image/png;base64,${png}`);
  });

  it('does not accept an SVG payload disguised as a raster data URL', async () => {
    const payload = Buffer.from(svg('<script>alert(1)</script>')).toString('base64');
    const document = await exportedSvg(`<image l:href="data:image/png;base64,${payload}"/>`);
    assert.equal(document.getElementsByTagName('image').item(0)?.hasAttributeNS(xlinkNamespace, 'href'), false);
  });

  it('skips each malformed SVG independently and continues exporting good media', async () => {
    const images = await readMedia(await fixture('with-images.docx'));
    const goodPng = images[0]?.bytes;
    assert.ok(goodPng);
    const media = await readMedia(await mediaPackage({
      'a-comment.svg': '<!-- <svg -->',
      'b-unclosed.svg': `<svg xmlns="${svgNamespace}"><path></svg>`,
      'c-foreign.svg': '<svg xmlns="http://www.w3.org/1999/xhtml"><script>bad</script></svg>',
      'd-doctype.svg': `<!DOCTYPE svg [<!ENTITY x "bad">]>${svg('<text>&x;</text>')}`,
      'e-stylesheet.svg': `<?xml-stylesheet href="https://attacker.invalid/x.css"?>${svg('<rect/>')}`,
      'f-encoding.svg': new Uint8Array([0xff, 0xfe, 0xff]),
      'z-valid.png': goodPng,
    }));
    assert.deepEqual(media.map((entry) => entry.name), ['word/media/z-valid.png']);
  });

  it('matches media extensions to content signatures, including SVG-in-PNG bypasses', async () => {
    const images = await readMedia(await fixture('with-images.docx'));
    const png = images[0]?.bytes;
    assert.ok(png);
    const media = await readMedia(await mediaPackage({
      'a-svg.png': svg('<script>alert(1)</script>'),
      'b-svg.jpg': svg('<rect/>'),
      'c-png.svg': png,
      'd-png.gif': png,
      'e-short.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'z-valid.PNG': png,
    }));
    assert.deepEqual(media.map((entry) => entry.name), ['word/media/z-valid.PNG']);
    assert.equal(isValidImageBytes(png), true);
    assert.equal(isValidImageBytes(new TextEncoder().encode('<!-- <svg -->')), false);
  });

  it('accepts JPEG/TIFF aliases and the other supported raster signatures', async () => {
    const files = {
      'a.jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      'b.tiff': new Uint8Array([0x49, 0x49, 0x2a, 0x00]),
      'c.gif': new TextEncoder().encode('GIF89a'),
      'd.webp': new TextEncoder().encode('RIFF0000WEBP'),
      'e.bmp': new Uint8Array([0x42, 0x4d, ...new Array<number>(12).fill(0)]),
    };
    const media = await readMedia(await mediaPackage(files));
    assert.equal(media.length, Object.keys(files).length);
  });

  it('keeps valid EMF and WMF media available for extraction', async () => {
    const emf = Buffer.alloc(50);
    emf.writeUInt32LE(1, 0);
    emf.write(' EMF', 40, 'latin1');
    const wmf = Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0x00, 0x00]);
    const media = await readMedia(await mediaPackage({ 'diagram.emf': emf, 'drawing.wmf': wmf }));
    assert.deepEqual(media.map((entry) => entry.name), [
      'word/media/diagram.emf',
      'word/media/drawing.wmf',
    ]);
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

describe('Choosing the page count to show', () => {
  it('does not call a long document one page because it was rendered as one', () => {
    // A document saved by a tool that records no page breaks renders as a
    // single long page; Word's own count is the better answer.
    assert.equal(pageCount(1, 15), 15);
  });

  it('never shows fewer pages than are on screen', () => {
    assert.equal(pageCount(12, 9), 12);
  });

  it('uses whichever count there is', () => {
    assert.equal(pageCount(4, undefined), 4);
    assert.equal(pageCount(undefined, 7), 7);
    assert.equal(pageCount(undefined, undefined), undefined);
    assert.equal(pageCount(0, undefined), undefined);
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

describe('Image extraction safety and formats', () => {
  it('recognizes EMF and WMF image bytes', () => {
    const emf = Buffer.alloc(50);
    emf.writeUInt32LE(1, 0); // iType = 1
    emf.write(' EMF', 40, 'latin1'); // dSignature = " EMF"
    assert.equal(isValidImageBytes(emf), true);

    const wmfApm = Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0x00, 0x00]);
    assert.equal(isValidImageBytes(wmfApm), true);

    const wmfStandard = Buffer.from([0x01, 0x00, 0x09, 0x00, 0x00, 0x03]);
    assert.equal(isValidImageBytes(wmfStandard), true);
  });

  it('preserves Unicode and spaces in base document name while sanitizing illegal characters', () => {
    assert.equal(
      imageName('Rapor Şubat 2026', 0, 1, 'word/media/image1.png'),
      'Rapor Şubat 2026-1.png',
    );
    assert.equal(
      imageName('Invalid/File:Name*?<>|', 0, 1, 'word/media/image1.png'),
      'Invalid_File_Name_____-1.png',
    );
  });
});
