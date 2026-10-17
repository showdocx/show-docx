import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { describe, it } from 'mocha';
import { DOMParser } from '@xmldom/xmldom';
import { readHiddenStyleInfo, removeHiddenRuns, xmlAttribute } from '../../src/text/xmlScanner';
import { convertDocxToPlainText, convertDocxToText, makeVisibleDocxBytes } from '../../src/text/docxText';
import { extractSearchText, xmlToLines } from '../../src/text/searchText';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

function run(text: string, properties = ''): string {
  return `<w:r><w:rPr>${properties}</w:rPr><w:t>${text}</w:t></w:r>`;
}

function style(id: string, properties: string, attributes = '', basedOn = ''): string {
  return `<w:style w:styleId="${id}" ${attributes}>`
    + (basedOn ? `<w:basedOn w:val="${basedOn}"/>` : '')
    + `<w:rPr>${properties}</w:rPr></w:style>`;
}

function styles(...entries: string[]): string {
  return `<w:styles xmlns:w="${WORD_NAMESPACE}">${entries.join('')}</w:styles>`;
}

function visible(xml: string, styleXml = ''): string {
  return xmlToLines(xml, readHiddenStyleInfo(styleXml));
}

function paragraph(content: string, styleId?: string): string {
  return '<w:p>' + (styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '') + content + '</w:p>';
}

async function docx(styleXml: string, body: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await readFile(path.join(FIXTURES, 'empty.docx')));
  zip.file('word/styles.xml', styleXml);
  zip.file('word/document.xml', `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('XML attribute character references', () => {
  it('decodes the five predefined entities and decimal/hexadecimal references', () => {
    assert.equal(xmlAttribute(' w:val="&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#x1f600;"', 'w:val'), `&<>"'AB😀`);
    assert.equal(xmlAttribute(" w:val='&#x69;&#105;'", 'w:val'), 'ii');
    assert.equal(xmlAttribute(' w:other="ignored" w:val=""', 'w:val'), '');
    assert.equal(xmlAttribute(' w:other="ignored"', 'w:val'), undefined);
  });

  it('normalizes literal XML attribute whitespace, treating CRLF as one space', () => {
    for (const quote of ['"', "'"]) {
      for (const whitespace of ['\n', '\t', '\r', '\r\n']) {
        assert.equal(xmlAttribute(` w:val=${quote}Hidden${whitespace}Style${quote}`, 'w:val'), 'Hidden Style');
      }
      assert.equal(xmlAttribute(` w:val=${quote}\t x \t${quote}`, 'w:val'), '  x  ');
      assert.equal(xmlAttribute(` w:val=${quote}a\t\tb\n\rc\r\rd${quote}`, 'w:val'), 'a  b  c  d');
      assert.equal(xmlAttribute(` w:val=${quote}a\u00a0b\u0085c\u2028d${quote}`, 'w:val'), 'a\u00a0b\u0085c\u2028d');
    }
  });

  it('normalizes before decoding so numeric whitespace references retain their XML semantics', () => {
    assert.equal(xmlAttribute(' w:val="a\r\nb&#10;c&#xA;d&#9;e&#x9;f&#13;g&#xD;h&#13;&#10;i"', 'w:val'),
      'a b\nc\nd\te\tf\rg\rh\r\ni');
    assert.equal(xmlAttribute(' w:val="left\n&amp;#10;&#10;right"', 'w:val'), 'left &#10;\nright');
    assert.equal(xmlAttribute(' w:val="left&#38;#10;\tright"', 'w:val'), 'left&#10; right');
  });

  it('decodes exactly once, without expanding custom entities or HTML-only entities', () => {
    assert.equal(xmlAttribute(' w:val="&amp;lt; &amp;#105; &#38;lt; &#x26;#x69; &amp;amp;"', 'w:val'),
      '&lt; &#105; &lt; &#x69; &amp;');
    assert.equal(xmlAttribute(' w:val="&custom;&nbsp;&AMP;&#X69;&#xZZ;&#65"', 'w:val'),
      '&custom;&nbsp;&AMP;&#X69;&#xZZ;&#65');
  });

  it('does not throw or emit invalid XML characters for invalid numeric references', () => {
    const invalid = '&#0;&#xD800;&#x110000;&#999999999999999999999999999999999999999999999999999999999999999999;';
    assert.equal(xmlAttribute(` w:val="${invalid}"`, 'w:val'), invalid);
    assert.equal(xmlAttribute(' w:val="&#9;&#10;&#13;&#x10FFFF;"', 'w:val'), `\t\n\r${String.fromCodePoint(0x10ffff)}`);
  });
});

describe('Current hidden-run properties', () => {
  it('uses default paragraph styles without requiring an explicit pStyle', () => {
    const definitions = styles(style('Normal', '<w:vanish/>', 'w:type="paragraph" w:default="1"'));
    assert.equal(visible(`<w:p>${run('secret')}${run('shown', '<w:vanish w:val="0"/>')}</w:p>`, definitions), 'shown');
  });

  it('combines default paragraph/character style toggles rather than replacing paragraph values', () => {
    const definitions = styles(
      style('Normal', '<w:vanish/>', 'w:type="paragraph" w:default="true"'),
      style('DefaultCharacter', '<w:vanish w:val="false"/>', 'w:type="character" w:default="on"'),
      style('Unchanged', '<w:vanish w:val="off"/>', 'w:type="character"'),
      style('Toggle', '<w:vanish/>', 'w:type="character"'),
    );
    assert.equal(visible(paragraph(run('default secret') + run('still secret', '<w:rStyle w:val="Unchanged"/>')
      + run('toggle visible', '<w:rStyle w:val="Toggle"/>')
      + run(' direct visible', '<w:vanish w:val="0"/>')), definitions), 'toggle visible direct visible');
    const hiddenCharacter = styles(style('DefaultCharacter', '<w:vanish/>', 'w:type="character" w:default="1"'));
    assert.equal(visible(paragraph(run('secret')), hiddenCharacter), '');
  });

  it('does not treat a style with default=0 as a default', () => {
    const definitions = styles(style('NotDefault', '<w:vanish/>', 'w:type="paragraph" w:default="0"'));
    assert.equal(visible(`<w:p>${run('shown')}</w:p>`, definitions), 'shown');
  });

  it('uses docDefaults as the base for style toggles and absolute direct overrides', () => {
    const definitions = styles(
      '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>',
      style('Base', '<w:vanish w:val="false"/>', 'w:type="character"'),
      style('Child', '', 'w:type="character"', 'Base'),
      style('Visible', '<w:vanish/>', 'w:type="character"', 'Child'),
    );
    assert.equal(visible(paragraph(run('secret default') + run('secret inherited', '<w:rStyle w:val="Child"/>')
      + run('shown', '<w:rStyle w:val="Visible"/>')
      + run(' direct visible', '<w:vanish w:val="0"/>')
      + run('direct hidden', '<w:rStyle w:val="Visible"/><w:vanish/>')), definitions), 'shown direct visible');
  });

  it('toggles vanish through each basedOn ancestor and preserves inherited true when a child says false', () => {
    for (const type of ['paragraph', 'character']) {
      const definitions = styles(
        style('Base', '<w:vanish/>', `w:type="${type}"`),
        style('ChildFalse', '<w:vanish w:val="false"/>', `w:type="${type}"`, 'Base'),
        style('ChildTrue', '<w:vanish/>', `w:type="${type}"`, 'Base'),
        style('Grandchild', '<w:vanish/>', `w:type="${type}"`, 'ChildTrue'),
        style('Inherited', '', `w:type="${type}"`, 'ChildFalse'),
      );
      const styled = (id: string, direct = ''): string => paragraph(
        run(id, (type === 'character' ? `<w:rStyle w:val="${id}"/>` : '') + direct),
        type === 'paragraph' ? id : undefined,
      );
      assert.equal(visible(styled('ChildFalse'), definitions), '', type);
      assert.equal(visible(styled('ChildTrue'), definitions), 'ChildTrue', type);
      assert.equal(visible(styled('Grandchild'), definitions), '', type);
      assert.equal(visible(styled('Inherited'), definitions), '', type);
      assert.equal(visible(styled('ChildFalse', '<w:vanish w:val="false"/>'), definitions), 'ChildFalse', type);
      assert.equal(visible(styled('ChildTrue', '<w:vanish/>'), definitions), '', type);
      assert.equal(readHiddenStyleInfo(definitions).byId.get('ChildFalse'), true);
      assert.equal(readHiddenStyleInfo(definitions).byId.get('ChildTrue'), false);
    }
  });

  it('combines resolved paragraph and character chains with correct toggle parity', () => {
    for (const paragraphToggle of [false, true]) {
      for (const characterToggle of [false, true]) {
        const definitions = styles(
          style('ParagraphBase', '<w:vanish/>', 'w:type="paragraph"'),
          style('Paragraph', `<w:vanish w:val="${paragraphToggle ? 0 : 1}"/>`, 'w:type="paragraph"', 'ParagraphBase'),
          style('CharacterBase', '<w:vanish/>', 'w:type="character"'),
          style('Character', `<w:vanish w:val="${characterToggle ? 0 : 1}"/>`, 'w:type="character"', 'CharacterBase'),
        );
        const xml = paragraph(run('text', '<w:rStyle w:val="Character"/>'), 'Paragraph');
        assert.equal(visible(xml, definitions), paragraphToggle !== characterToggle ? '' : 'text');
      }
    }
  });

  it('inherits specVanish as an absolute property, not as a vanish-style toggle', () => {
    const definitions = styles(
      style('Base', '<w:specVanish/>', 'w:type="character"'),
      style('StillHidden', '<w:specVanish/>', 'w:type="character"', 'Base'),
      style('Visible', '<w:specVanish w:val="0"/>', 'w:type="character"', 'Base'),
      style('Paragraph', '<w:specVanish/>', 'w:type="paragraph"'),
    );
    assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="StillHidden"/>')), definitions), '');
    assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="Visible"/>'), 'Paragraph'), definitions), 'shown');
    assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="StillHidden"/><w:specVanish w:val="0"/>')), definitions), 'shown');
    assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="Visible"/><w:specVanish/>')), definitions), '');
    assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="StillHidden"/><w:vanish w:val="0"/>')), definitions), '');
  });

  it('resolves encoded style definitions, paragraph/character references and basedOn IDs', () => {
    for (const type of ['paragraph', 'character']) {
      for (const [definitionId, referenceId] of [
        ['Hidden', 'H&#105;dden'],
        ['H&#x69;dden', 'Hidden'],
        ['H&#105;dden', 'H&#x69;dden'],
        ['A&amp;B&lt;C&gt;&quot;&apos;', 'A&#38;B&#60;C&#62;&#34;&#39;'],
      ] as const) {
        const definitions = styles(
          style(definitionId, '<w:vanish/>', `w:type="${type}"`),
          style('Child', '<w:vanish w:val="0"/>', `w:type="${type}"`, referenceId),
        );
        const styled = (id: string): string => paragraph(
          run('secret', type === 'character' ? `<w:rStyle w:val="${id}"/>` : ''),
          type === 'paragraph' ? id : undefined,
        );
        assert.equal(visible(styled(referenceId), definitions), '', `${type}: ${definitionId} -> ${referenceId}`);
        assert.equal(visible(styled('Ch&#105;ld'), definitions), '', `${type}: basedOn ${referenceId}`);
      }
    }
  });

  it('matches normalized literal whitespace in style definitions, references and basedOn IDs', () => {
    for (const type of ['paragraph', 'character']) {
      const styled = (id: string): string => paragraph(
        run('SECRET', type === 'character' ? `<w:rStyle w:val="${id}"/>` : ''),
        type === 'paragraph' ? id : undefined,
      );
      for (const whitespace of ['\n', '\t', '\r', '\r\n']) {
        const literalId = `Hidden${whitespace}Style`;
        for (const [definitionId, referenceId] of [
          [literalId, 'Hidden Style'],
          ['Hidden Style', literalId],
          [literalId, 'Hidden\tStyle'],
        ] as const) {
          const definitions = styles(
            style(definitionId, '<w:vanish/>', `w:type="${type}"`),
            style('Child', '<w:vanish w:val="0"/>', `w:type="${type}"`, referenceId),
          );
          assert.equal(visible(styled(referenceId), definitions), '');
          assert.equal(visible(styled('Child'), definitions), '');
        }
      }
    }
  });

  it('keeps character-reference whitespace distinct in style definitions, references and basedOn IDs', () => {
    for (const type of ['paragraph', 'character']) {
      const styled = (id: string): string => paragraph(
        run('text', type === 'character' ? `<w:rStyle w:val="${id}"/>` : ''),
        type === 'paragraph' ? id : undefined,
      );
      for (const entity of ['&#10;', '&#xA;', '&#9;', '&#x9;', '&#13;', '&#xD;', '&#13;&#10;']) {
        const numericId = `Hidden${entity}Style`;
        const numericDefinition = styles(
          style(numericId, '<w:vanish/>', `w:type="${type}"`),
          style('MatchedChild', '', `w:type="${type}"`, numericId),
          style('SpaceChild', '', `w:type="${type}"`, 'Hidden Style'),
        );
        assert.equal(visible(styled(numericId), numericDefinition), '');
        assert.equal(visible(styled('MatchedChild'), numericDefinition), '');
        assert.equal(visible(styled('Hidden Style'), numericDefinition), 'text');
        assert.equal(visible(styled('Hidden\nStyle'), numericDefinition), 'text');
        assert.equal(visible(styled('SpaceChild'), numericDefinition), 'text');
        const literalDefinition = styles(
          style('Hidden Style', '<w:vanish/>', `w:type="${type}"`),
          style('NumericChild', '', `w:type="${type}"`, numericId),
        );
        assert.equal(visible(styled(numericId), literalDefinition), 'text');
        assert.equal(visible(styled('NumericChild'), literalDefinition), 'text');
      }
    }
  });

  it('filters literal-whitespace style IDs in DOCX conversions without conflating numeric whitespace', async () => {
    const bytes = await docx(styles(
      style('Hidden\nParagraph', '<w:vanish/>', 'w:type="paragraph"'),
      style('Hidden\tCharacter', '<w:vanish/>', 'w:type="character"'),
      style('Child', '<w:vanish w:val="0"/>', 'w:type="character"', 'Hidden Character'),
      style('Hidden LiteralReference', '<w:vanish/>', 'w:type="character"'),
      style('Hidden BasedOn', '<w:vanish/>', 'w:type="character"'),
      style('Inherited', '', 'w:type="character"', 'Hidden\rBasedOn'),
      style('Numeric&#10;Style', '<w:vanish/>', 'w:type="character"'),
    ), paragraph(run('SECRET_paragraph'), 'Hidden Paragraph')
      + paragraph(run('SECRET_character', '<w:rStyle w:val="Child"/>'))
      + paragraph(run('SECRET_reference', '<w:rStyle w:val="Hidden\r\nLiteralReference"/>'))
      + paragraph(run('SECRET_basedOn', '<w:rStyle w:val="Inherited"/>'))
      + paragraph(run('shown', '<w:rStyle w:val="Numeric Style"/>')));
    assert.equal(await extractSearchText(bytes, { headersAndFooters: false }), 'shown');
    assert.equal((await convertDocxToText(bytes)).text, 'shown\n');
    assert.equal((await convertDocxToPlainText(bytes)).text, 'shown\n');
  });

  it('decodes on/off and default-style attribute encodings before applying their semantics', () => {
    const hiddenDefault = styles(style('Normal', '<w:vanish/>', 'w:type="paragr&#97;ph" w:default="&#x31;"'));
    assert.equal(visible(paragraph(run('secret')), hiddenDefault), '');
    const specialDefault = styles('<w:docDefaults><w:rPrDefault><w:rPr><w:specVanish/></w:rPr></w:rPrDefault></w:docDefaults>');
    const encodedCharacterDefault = styles(style('DefaultCharacter', '<w:vanish/>', 'w:type="charact&#x65;r" w:default="&#49;"'));
    assert.equal(visible(paragraph(run('secret')), encodedCharacterDefault), '');
    for (const value of ['&#48;', '&#x30;', 'f&#97;lse', 'o&#x66;f']) {
      assert.equal(visible(paragraph(run('shown', `<w:vanish w:val="${value}"/>`)), hiddenDefault), 'shown');
      const nonDefault = styles(style('NotDefault', '<w:vanish/>', `w:type="paragraph" w:default="${value}"`));
      assert.equal(visible(paragraph(run('shown')), nonDefault), 'shown');
      const falseChild = styles(
        style('Base', '<w:vanish/>', 'w:type="character"'),
        style('Child', `<w:vanish w:val="${value}"/>`, 'w:type="character"', 'Base'),
      );
      assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="Child"/>')), falseChild), '');
      assert.equal(visible(paragraph(run('shown', `<w:specVanish w:val="${value}"/>`)), specialDefault), 'shown');
    }
    for (const value of ['&#49;', '&#x31;', 'tr&#117;e', '&#x6f;n']) {
      assert.equal(visible(paragraph(run('secret', `<w:vanish w:val="${value}"/>`))), '');
      assert.equal(visible(paragraph(run('secret', `<w:specVanish w:val="${value}"/>`))), '');
      const trueChild = styles(
        style('Base', '<w:vanish/>', 'w:type="character"'),
        style('Child', `<w:vanish w:val="${value}"/>`, 'w:type="character"', 'Base'),
      );
      assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="Child"/>')), trueChild), 'shown');
    }
  });

  it('does not double-decode style IDs or turn an escaped literal reference into Hidden', () => {
    const definitions = styles(
      style('Hidden', '<w:vanish/>', 'w:type="character"'),
      style('H&amp;#105;dden', '', 'w:type="character"'),
      style('LiteralChild', '', 'w:type="character"', 'H&amp;#105;dden'),
    );
    assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="H&amp;#105;dden"/>')), definitions), 'shown');
    assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="LiteralChild"/>')), definitions), 'shown');
    assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="H&#105;dden"/>')), definitions), '');
    const literalHidden = styles(
      style('H&amp;#105;dden', '<w:vanish/>', 'w:type="character"'),
      style('LiteralChild', '', 'w:type="character"', 'H&amp;#105;dden'),
    );
    assert.equal(visible(paragraph(run('secret', '<w:rStyle w:val="LiteralChild"/>')), literalHidden), '');
    assert.equal(visible(paragraph(run('shown', '<w:rStyle w:val="Hidden"/>')), literalHidden), 'shown');
    assert.equal(visible(paragraph(run('secret', '<w:vanish w:val="&amp;#48;"/>'))), '');
  });

  it('keeps vanish and specVanish independent of tag order and override layer', () => {
    for (const properties of [
      '<w:vanish/><w:specVanish w:val="0"/>',
      '<w:specVanish w:val="0"/><w:vanish/>',
      '<w:specVanish/><w:vanish w:val="0"/>',
    ]) {
      assert.equal(visible(`<w:p>${run('secret', properties)}</w:p>`), '');
    }
    const definitions = styles(
      style('Normal', '<w:specVanish/><w:vanish/>', 'w:type="paragraph" w:default="1"'),
      style('VisibleVanish', '<w:vanish w:val="0"/>', 'w:type="character"'),
    );
    assert.equal(visible(`<w:p>${run('still secret', '<w:rStyle w:val="VisibleVanish"/>')}`
      + `${run('shown', '<w:vanish w:val="0"/><w:specVanish w:val="0"/>')}</w:p>`, definitions), 'shown');
  });

  it('ignores historical rPrChange values, including historical visible overrides', () => {
    const historicalVisible = '<w:rPrChange><w:rPr><w:vanish w:val="0"/></w:rPr></w:rPrChange>';
    const historicalHidden = '<w:rPrChange><w:rPr><w:vanish/></w:rPr></w:rPrChange>';
    assert.equal(visible(`<w:p>${run('secret', `<w:vanish/>${historicalVisible}`)}`
      + `${run('shown', historicalHidden)}</w:p>`), 'shown');
    const definitions = styles(style('Normal', `<w:vanish/>${historicalVisible}`, 'w:type="paragraph" w:default="1"'));
    assert.equal(visible(`<w:p>${run('secret')}</w:p>`, definitions), '');
    const oldDefault = styles('<w:docDefaults><w:rPrDefault><w:rPr>'
      + `<w:vanish w:val="0"/>${historicalHidden}</w:rPr></w:rPrDefault></w:docDefaults>`);
    assert.equal(visible(`<w:p>${run('shown')}</w:p>`, oldDefault), 'shown');
  });

  it('ignores old paragraph styles and paragraph-mark run properties', () => {
    const definitions = styles(
      style('Hidden', '<w:vanish/>', 'w:type="paragraph"'),
      style('Visible', '<w:vanish w:val="0"/>', 'w:type="paragraph"'),
    );
    const xml = '<w:p><w:pPr><w:pStyle w:val="Hidden"/><w:pPrChange><w:pPr>'
      + '<w:pStyle w:val="Visible"/></w:pPr></w:pPrChange></w:pPr>' + run('secret') + '</w:p>'
      + '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>' + run('shown') + '</w:p>';
    assert.equal(visible(xml, definitions), 'shown');
    const oldStyle = styles(style('Normal', '<w:vanish/>', 'w:type="paragraph" w:default="1"')
      .replace('<w:rPr>', '<w:pPr><w:pPrChange><w:pPr><w:rPr><w:vanish w:val="0"/></w:rPr></w:pPr></w:pPrChange></w:pPr><w:rPr>'));
    assert.equal(visible(`<w:p>${run('secret')}</w:p>`, oldStyle), '');
  });

  it('removes the union of nested hidden run ranges without dropping adjacent visible runs', () => {
    const inner = run('inner secret', '<w:vanish/>');
    const outer = `<w:r><w:rPr><w:vanish/></w:rPr><w:t>outer secret</w:t>`
      + `<w:drawing><w:txbxContent><w:p>${inner}${run('inner visible', '<w:vanish w:val="0"/>')}</w:p></w:txbxContent></w:drawing>`
      + '<w:t>outer tail</w:t></w:r>';
    const xml = `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p>${run('before')}${outer}${run('after')}</w:p></w:body></w:document>`;
    const filtered = removeHiddenRuns(xml);
    assert.equal(xmlToLines(filtered), 'beforeafter');
    assert.equal(filtered, xml.replace(outer, ''));
    let malformed = false;
    new DOMParser({ onError: () => {malformed = true;} })
      .parseFromString(filtered, 'application/xml');
    assert.equal(malformed, false);
  });

  it('removes only the inner range when its outer run is visible', () => {
    const inner = run('secret', '<w:vanish/>');
    const xml = `<w:p><w:r><w:t>before</w:t><w:drawing>${inner}</w:drawing><w:t>after</w:t></w:r></w:p>`;
    assert.equal(removeHiddenRuns(xml), xml.replace(inner, ''));
  });

  it('handles deeply nested overlapping ranges and long style chains iteratively', () => {
    const depth = 10000;
    const xml = '<w:p>' + '<w:r><w:rPr><w:vanish/></w:rPr>'.repeat(depth)
      + '<w:t>secret</w:t>' + '</w:r>'.repeat(depth) + run('shown') + '</w:p>';
    assert.equal(removeHiddenRuns(xml), `<w:p>${run('shown')}</w:p>`);
    const definitions = styles(...Array.from({ length: depth }, (_, index) =>
      style(`s${index}`, index === depth - 1 ? '<w:vanish/>' : '', 'w:type="character"', index < depth - 1 ? `s${index + 1}` : '')));
    assert.equal(visible(`<w:p>${run('secret', '<w:rStyle w:val="s0"/>')}</w:p>`, definitions), '');
    assert.equal(readHiddenStyleInfo(styles(style('a', '', '', 'b'), style('b', '', '', 'a'))).byId.size, 0);
  });

  it('resolves long toggle chains iteratively and handles invalid cycles consistently', () => {
    const depth = 10000;
    const definitions = styles(...Array.from({ length: depth }, (_, index) =>
      style(`s${index}`, '<w:vanish/>', 'w:type="character"', index < depth - 1 ? `s${index + 1}` : '')));
    const resolved = readHiddenStyleInfo(definitions);
    assert.equal(resolved.byId.get('s0'), false);
    assert.equal(resolved.byId.get('s1'), true);
    assert.equal(xmlToLines(paragraph(run('shown', '<w:rStyle w:val="s0"/>')
      + run('secret', '<w:rStyle w:val="s1"/>')), resolved), 'shown');
    const cycle = [style('a', '<w:vanish/>', 'w:type="character"', 'b'), style('b', '', 'w:type="character"', 'a')];
    for (const entries of [cycle, [...cycle].reverse()]) {
      assert.equal(visible(paragraph(run('secret a', '<w:rStyle w:val="a"/>')
        + run('secret b', '<w:rStyle w:val="b"/>')), styles(...entries)), '');
    }
  });

  it('filters hidden defaults before search, Markdown, raw text and media-renderer preprocessing', async () => {
    const bytes = await docx(
      styles(style('Normal', '<w:vanish/>', 'w:type="paragraph" w:default="1"')),
      paragraph(run('secret') + run('shown', '<w:vanish w:val="0"/>')),
    );
    assert.equal(await extractSearchText(bytes, { headersAndFooters: false }), 'shown');
    assert.equal((await convertDocxToText(bytes)).text, 'shown\n');
    assert.equal((await convertDocxToPlainText(bytes)).text, 'shown\n');
    const filtered = await JSZip.loadAsync(await makeVisibleDocxBytes(bytes, await JSZip.loadAsync(bytes)));
    assert.ok(!(await filtered.file('word/document.xml')?.async('text'))?.includes('secret'));
  });

  it('filters encoded references and false child toggles in a real DOCX without losing visible toggles', async () => {
    const definitions = styles(
      style('H&#105;dden', '<w:vanish w:val="tr&#117;e"/>', 'w:type="paragraph"'),
      style('StillHidden', '<w:vanish w:val="f&#97;lse"/>', 'w:type="paragraph"', 'H&#x69;dden'),
      style('Visible', '<w:vanish/>', 'w:type="paragraph"', 'H&#105;dden'),
      style('C&#104;arHidden', '<w:vanish/>', 'w:type="character"'),
      style('CharStillHidden', '<w:vanish w:val="&#48;"/>', 'w:type="character"', 'CharH&#105;dden'),
      style('CharVisible', '<w:vanish/>', 'w:type="character"', 'CharHidden'),
    );
    const body = paragraph(run('SECRET_encoded_paragraph'), 'H&#105;dden')
      + paragraph(run('SECRET_false_paragraph'), 'St&#105;llHidden')
      + paragraph(run('paragraph toggle visible'), 'Visible')
      + paragraph(run('SECRET_encoded_character', '<w:rStyle w:val="CharH&#105;dden"/>'))
      + paragraph(run('SECRET_false_character', '<w:rStyle w:val="CharStillHidden"/>'))
      + paragraph(run('character toggle visible', '<w:rStyle w:val="CharVisible"/>'))
      + paragraph(run('combined toggles visible', '<w:rStyle w:val="CharH&#x69;dden"/>'), 'H&#105;dden')
      + paragraph(run('direct visible', '<w:vanish w:val="&#x30;"/>'), 'StillHidden')
      + paragraph(run('SECRET_direct_override', '<w:vanish w:val="&#x31;"/>'), 'Visible')
      + paragraph(run('literal reference visible', '<w:rStyle w:val="C&amp;#104;arHidden"/>'));
    const bytes = await docx(definitions, body);
    const expected = [
      'paragraph toggle visible', 'character toggle visible', 'combined toggles visible',
      'direct visible', 'literal reference visible',
    ];
    for (const text of [
      await extractSearchText(bytes, { headersAndFooters: false }),
      (await convertDocxToText(bytes)).text,
      (await convertDocxToPlainText(bytes)).text,
    ]) {
      assert.ok(!text.includes('SECRET'), text);
      assert.deepEqual(text.trim().split(/\n+/), expected);
    }
    const filtered = await JSZip.loadAsync(await makeVisibleDocxBytes(bytes, await JSZip.loadAsync(bytes)));
    const filteredXml = await filtered.file('word/document.xml')?.async('text');
    assert.ok(!filteredXml?.includes('SECRET'));
    for (const text of expected) {assert.ok(filteredXml?.includes(text), text);}
  });
});
