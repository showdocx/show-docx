import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { findFolded, foldForSearch } from '../../shared/searchFold';

const DOTTED_CAPITAL_I = String.fromCharCode(0x130);
const DOTLESS_I = String.fromCharCode(0x131);
const COMBINING_DOT = String.fromCharCode(0x307);

/** The original text each match covers, which is what the reader sees. */
function found(text: string, query: string): string[] {
  return findFolded(text, query).matches.map(({ start, end }) => text.slice(start, end));
}

describe('Folding text for a case-insensitive search', () => {
  it('leaves text that lowercases cleanly on the fast path, with no offset table', () => {
    const folded = foldForSearch('Hello World');
    assert.equal(folded.text, 'hello world');
    assert.equal(folded.origin, undefined);
  });

  it('folds all four Turkish and Latin I letters to i, one for one', () => {
    const folded = foldForSearch(`${DOTTED_CAPITAL_I}I${DOTLESS_I}i`);
    assert.equal(folded.text, 'iiii');
  });

  it('maps a match after a dotted capital I back to where it really is', () => {
    // Lowercasing turns each of these into two code units; the match must not
    // drift one character to the right per letter, as it used to.
    const text = `${DOTTED_CAPITAL_I}STANBUL ${DOTTED_CAPITAL_I}ZM${DOTTED_CAPITAL_I}R hedef kelime`;
    assert.deepEqual(found(text, 'hedef'), ['hedef']);
    assert.deepEqual(found(`${DOTTED_CAPITAL_I.repeat(6)} ab`, 'ab'), ['ab']);
  });

  it('matches Turkish words whichever way they are cased', () => {
    assert.deepEqual(found(`${DOTTED_CAPITAL_I}STANBUL`, 'istanbul'), [`${DOTTED_CAPITAL_I}STANBUL`]);
    assert.deepEqual(found('IRMAK', `${DOTLESS_I}rmak`), ['IRMAK']);
    assert.deepEqual(found(`${DOTLESS_I}rmak`, 'IRMAK'), [`${DOTLESS_I}rmak`]);
  });

  it('treats I followed by a combining dot as the letter i', () => {
    const text = `I${COMBINING_DOT}stanbul`;
    assert.deepEqual(found(text, 'istanbul'), [text]);
  });

  it('keeps a combining dot that follows any other letter', () => {
    assert.equal(foldForSearch(`a${COMBINING_DOT}`).text, `a${COMBINING_DOT}`);
  });

  it('stops at the limit and says it did', () => {
    const result = findFolded('aaaa', 'a', 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, true);
  });

  it('finds nothing for an empty query', () => {
    assert.deepEqual(findFolded('text', ''), { matches: [], truncated: false });
  });
});
