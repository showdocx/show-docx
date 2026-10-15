/**
 * Case-insensitive matching that keeps track of where every character came
 * from. Shared by the in-document search and the workspace search, so a phrase
 * matches the same way in both.
 *
 * `toLowerCase()` alone is not enough, for two reasons:
 *
 * - It does not preserve length. `İ` (U+0130) lowercases to `i` followed by a
 *   combining dot, two code units for one, so every `İ` before a match moved
 *   the match one character to the right of where it really was.
 * - It keeps Turkish dotted and dotless I apart from the Latin pair. Someone
 *   typing `istanbul` means `İSTANBUL`, and `ırmak` means `IRMAK`.
 *
 * So `I`, `ı`, `İ` and `i` all fold to `i`, and an offset in the folded text
 * can always be mapped back to the original.
 */

const CAPITAL_I_WITH_DOT = 0x130;
const DOTLESS_I = 0x131;
const COMBINING_DOT_ABOVE = 0x307;

export interface FoldedText {
  readonly text: string;
  /**
   * For each code unit of `text`, the offset of the original character it came
   * from, plus one final entry for the end. Undefined when the two are the same
   * length and line up one to one, which is nearly always.
   */
  readonly origin?: readonly number[];
}

export function foldForSearch(value: string): FoldedText {
  const lowered = value.toLowerCase();
  // The fast path: nothing changed length, so only the dotless i needs folding.
  if (
    lowered.length === value.length
    && !value.includes(String.fromCharCode(COMBINING_DOT_ABOVE))
  ) {
    return { text: lowered.replaceAll(String.fromCharCode(DOTLESS_I), 'i') };
  }

  const pieces: string[] = [];
  const origin: number[] = [];
  let previousWasI = false;
  let index = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === COMBINING_DOT_ABOVE && previousWasI) {
      // "I" written as I plus a combining dot is still the letter i.
      index += character.length;
      continue;
    }
    const folded = code === CAPITAL_I_WITH_DOT || code === DOTLESS_I
      ? 'i'
      : character.toLowerCase();
    pieces.push(folded);
    for (let unit = 0; unit < folded.length; unit += 1) {
      origin.push(index);
    }
    previousWasI = folded === 'i';
    index += character.length;
  }
  origin.push(value.length);
  return { text: pieces.join(''), origin };
}

/** The offset in the original text that a folded offset stands for. */
export function originalOffset(folded: FoldedText, offset: number): number {
  return folded.origin ? folded.origin[offset] ?? offset : offset;
}

export interface FoldedMatch {
  /** Where the match starts in the original text. */
  readonly start: number;
  /** Where it ends in the original text, exclusive. */
  readonly end: number;
}

/**
 * Every non-overlapping occurrence of `query` in `text`, ignoring case, in
 * original offsets. Stops after `limit`, and says whether it had to.
 */
export function findFolded(
  text: string,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): { matches: FoldedMatch[]; truncated: boolean } {
  const matches: FoldedMatch[] = [];
  const needle = foldForSearch(query).text;
  if (needle === '' || text === '') {
    return { matches, truncated: false };
  }
  const haystack = foldForSearch(text);
  for (
    let at = haystack.text.indexOf(needle);
    at !== -1;
    at = haystack.text.indexOf(needle, at + needle.length)
  ) {
    if (matches.length >= limit) {
      return { matches, truncated: true };
    }
    matches.push({
      start: originalOffset(haystack, at),
      end: originalOffset(haystack, at + needle.length),
    });
  }
  return { matches, truncated: false };
}
