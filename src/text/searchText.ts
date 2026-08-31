import JSZip from 'jszip';
import { decodeEntities } from './htmlToText';

/**
 * Plain text pulled straight out of a document's XML, for finding words in it.
 *
 * This is deliberately not the converter the viewer and the exports use. That
 * one produces something to read; this one produces something to search, over
 * every Word file in a workspace at once, where the cost of a full conversion
 * per file would be the difference between a search that feels instant and one
 * that does not. Nothing here is ever shown as the document — only as the line
 * a match was found on.
 */

/**
 * The parts that hold text a reader sees. Headers and footers are numbered and
 * there may be several of each, so they are matched rather than listed — and
 * they are included because a header is where a document number, a title or a
 * classification usually lives, which is exactly what someone searches for.
 */
const TEXT_PART = /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/;

export async function extractSearchText(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  // The body first, then the rest by name, so the same document always reads
  // the same way and a match keeps the same line number between searches.
  const names = Object.keys(zip.files)
    .filter((name) => TEXT_PART.test(name))
    .sort(comparePartNames);

  const parts: string[] = [];
  for (const name of names) {
    const file = zip.file(name);
    if (file) {
      parts.push(xmlToLines(await file.async('text')));
    }
  }
  return parts.filter((part) => part !== '').join('\n');
}

function comparePartNames(left: string, right: string): number {
  const body = 'word/document.xml';
  if (left === body || right === body) {
    return left === body ? (right === body ? 0 : -1) : 1;
  }
  return left.localeCompare(right);
}

/**
 * Turns WordprocessingML into one line per paragraph.
 *
 * Two kinds of content are dropped rather than searched:
 *
 * - `w:instrText` holds field codes — the machinery behind a hyperlink or a
 *   table of contents — which the reader never sees.
 * - `w:delText` holds text a tracked change deleted, which the viewer shows as
 *   removed. Matching it would send someone to a line that is not there.
 */
export function xmlToLines(xml: string): string {
  const text = xml
    .replaceAll(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replaceAll(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replaceAll(/<w:tab\b[^>]*\/?>/g, '\t')
    .replaceAll(/<w:br\b[^>]*\/?>/g, '\n')
    .replaceAll(/<\/w:p>/g, '\n')
    .replaceAll(/<[^>]*>/g, '');

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export interface TextMatch {
  /** Zero-based index of the line the match is on. */
  readonly line: number;
  /** The whole line, for showing the match in context. */
  readonly text: string;
  /** Where the match starts within `text`. */
  readonly column: number;
}

/**
 * Every occurrence of `query`, matched literally and without regard to case.
 * Literally: someone searching a specification for "s. 4(a)" means those
 * characters, not a pattern.
 */
export function findMatches(
  text: string,
  query: string,
  limit: number,
): { matches: TextMatch[]; truncated: boolean } {
  const matches: TextMatch[] = [];
  if (query === '' || text === '') {
    return { matches, truncated: false };
  }

  const needle = query.toLowerCase();
  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line] ?? '';
    const haystack = value.toLowerCase();
    let column = haystack.indexOf(needle);
    while (column !== -1) {
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      matches.push({ line, text: value, column });
      column = haystack.indexOf(needle, column + needle.length);
    }
  }
  return { matches, truncated: false };
}

/**
 * A window of the line around the match, so a hit in a long paragraph is
 * readable in a list rather than being cut off before it.
 */
export function snippet(match: TextMatch, queryLength: number, width = 120): string {
  const { text, column } = match;
  if (text.length <= width) {
    return text;
  }

  const half = Math.max(0, Math.floor((width - queryLength) / 2));
  const start = Math.max(0, column - half);
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}
