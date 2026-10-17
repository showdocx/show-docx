import JSZip from 'jszip';
import { findFolded } from '../../shared/searchFold';
import { decodeEntities } from './htmlToText';
import { loadAndValidateZip } from '../docxLoader';
import type { ZipValidationOptions } from '../docxLoader';
import { readHiddenStyleInfo, removeHiddenRuns, removeXmlElements, xmlTextContent } from './xmlScanner';
import type { HiddenStyleInfo } from './xmlScanner';

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
const HEADER_OR_FOOTER = /^word\/(header|footer)\d+\.xml$/;

export interface SearchTextOptions {
  /**
   * Whether headers and footers are read. They are for searching; a word count
   * leaves them out, as Word's does, because they repeat on every page rather
   * than being part of what the document says.
   */
  readonly headersAndFooters?: boolean;
}

export async function extractSearchText(
  data: Uint8Array | JSZip,
  options: SearchTextOptions = {},
  zipOptions?: ZipValidationOptions,
): Promise<string> {
  const zip = data instanceof JSZip ? data : await loadAndValidateZip(data, zipOptions);
  const headersAndFooters = options.headersAndFooters ?? true;
  const stylesXml = await zip.file('word/styles.xml')?.async('text') ?? '';
  const hiddenStyles = readHiddenStyleInfo(stylesXml);
  // The body first, then the rest by name, so the same document always reads
  // the same way and a match keeps the same line number between searches.
  const names = Object.keys(zip.files)
    .filter((name) => TEXT_PART.test(name))
    .filter((name) => headersAndFooters || !HEADER_OR_FOOTER.test(name))
    .sort(comparePartNames);

  const parts: string[] = [];
  for (const name of names) {
    const file = zip.file(name);
    if (file) {
      parts.push(xmlToLines(await file.async('text'), hiddenStyles));
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
 * Three kinds of content are dropped rather than searched:
 *
 * - `w:instrText` holds field codes — the machinery behind a hyperlink or a
 *   table of contents — which the reader never sees.
 * - `w:delText` holds text a tracked change deleted, which the viewer shows as
 *   removed. Matching it would send someone to a line that is not there.
 * - `mc:Fallback` is the second copy of a text box or shape: Word writes it
 *   once as DrawingML in `mc:Choice` and again as VML for older readers.
 *   Reading both counted every word in a text box twice.
 */
export function xmlToLines(xml: string, hiddenStyles?: HiddenStyleInfo): string {
  const withoutHidden = removeHiddenRuns(xml, hiddenStyles);
  const withoutFallback = removeElements(withoutHidden, 'mc:Fallback');
  const withoutFields = removeXmlElements(withoutFallback, new Set(['w:instrText']));
  const withoutDeleted = removeXmlElements(withoutFields, new Set(['w:delText']));
  const text = xmlTextContent(withoutDeleted);

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Removes every element with this name, contents and all. Nesting is counted,
 * because a text box can hold a shape with a fallback of its own, and stopping
 * at the first closing tag would leave half the outer one behind.
 */
function removeElements(xml: string, name: string): string {
  return removeXmlElements(xml, new Set([name]));
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

  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line] ?? '';
    // One more than the room left, so running out is reported as truncation.
    const found = findFolded(value, query, limit - matches.length + 1);
    for (const match of found.matches) {
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      matches.push({ line, text: value, column: match.start });
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
