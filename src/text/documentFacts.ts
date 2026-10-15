import JSZip from 'jszip';
import { decodeEntities } from './htmlToText';
import { fingerprintBytes } from './fingerprint';

/**
 * The facts a Word package states about itself: who wrote it, when, which
 * revision, and what is inside it.
 *
 * Three features read these — the properties panel, the status bar counts and
 * the image export — so the package is opened and understood in one place.
 */

export interface DocumentProperties {
  readonly title?: string;
  readonly subject?: string;
  readonly creator?: string;
  readonly lastModifiedBy?: string;
  readonly created?: string;
  readonly modified?: string;
  readonly revision?: string;
  readonly keywords?: string;
  readonly description?: string;
  readonly category?: string;
  readonly application?: string;
  readonly template?: string;
  readonly company?: string;
  /**
   * The page count Word recorded when it last saved. Absent from documents
   * written by anything else, and stale the moment another tool edits them —
   * which is why it is weighed against the pages the viewer rendered.
   */
  readonly pages?: number;
}

/** One image stored in the package. */
export interface MediaEntry {
  /** The path inside the package, e.g. `word/media/image1.png`. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Identifies the content, so the same image stored twice is written once. */
  readonly digest: string;
}

const CORE_FIELDS: Record<string, keyof DocumentProperties> = {
  'dc:title': 'title',
  'dc:subject': 'subject',
  'dc:creator': 'creator',
  'dc:description': 'description',
  'cp:lastModifiedBy': 'lastModifiedBy',
  'cp:revision': 'revision',
  'cp:keywords': 'keywords',
  'cp:category': 'category',
  'dcterms:created': 'created',
  'dcterms:modified': 'modified',
};

const APP_FIELDS: Record<string, keyof DocumentProperties> = {
  Application: 'application',
  Template: 'template',
  Company: 'company',
};

export async function readDocumentProperties(data: Uint8Array | JSZip): Promise<DocumentProperties> {
  const zip = data instanceof JSZip ? data : await JSZip.loadAsync(data);
  const core = await readPart(zip, 'docProps/core.xml');
  const app = await readPart(zip, 'docProps/app.xml');

  const properties: Record<string, string | number> = {};
  for (const [tag, key] of Object.entries(CORE_FIELDS)) {
    const value = readTag(core, tag);
    if (value !== undefined) {
      properties[key] = value;
    }
  }
  for (const [tag, key] of Object.entries(APP_FIELDS)) {
    const value = readTag(app, tag);
    if (value !== undefined) {
      properties[key] = value;
    }
  }

  const pages = Number.parseInt(readTag(app, 'Pages') ?? '', 10);
  if (Number.isFinite(pages) && pages > 0) {
    properties.pages = pages;
  }
  return properties as DocumentProperties;
}

/**
 * Every image in the package, each one once. Word stores a picture used twice
 * as two identical parts, and re-saves a document by writing them all again.
 */
export async function readMedia(data: Uint8Array): Promise<MediaEntry[]> {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files)
    .filter((name) => /^word\/media\/[^/]+$/.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

  const seen = new Set<string>();
  const entries: MediaEntry[] = [];
  for (const name of names) {
    const file = zip.file(name);
    if (!file || file.dir) {
      continue;
    }
    const bytes = await file.async('uint8array');
    if (bytes.byteLength === 0) {
      continue;
    }
    const digest = fingerprintBytes(bytes);
    if (seen.has(digest)) {
      continue;
    }
    seen.add(digest);
    entries.push({ name, bytes, digest });
  }
  return entries;
}

/**
 * Names an extracted file after the document it came from. The name inside the
 * package is Word's own — often a content hash — which says nothing to anyone
 * looking at the folder afterwards. Numbers are padded so the files sort the
 * way they appear in the document.
 */
export function imageName(
  base: string,
  index: number,
  total: number,
  packagedName: string,
): string {
  const dot = packagedName.lastIndexOf('.');
  const slash = Math.max(packagedName.lastIndexOf('/'), packagedName.lastIndexOf('\\'));
  const extension = dot > slash ? packagedName.slice(dot).toLowerCase() : '.bin';
  const width = String(total).length;
  return `${base}-${String(index + 1).padStart(width, '0')}${extension}`;
}

/**
 * A file name nothing is using yet: the name itself, or the same name with
 * " (2)", " (3)" and so on before its extension — the way a file manager keeps
 * both when a copy lands on a name that is taken.
 */
export function freeName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let copy = 2; ; copy += 1) {
    const candidate = `${stem} (${copy})${extension}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
}

/**
 * Words in a stretch of text.
 *
 * Whitespace-separated, which is what a word count means for the languages this
 * is asked about. It undercounts scripts written without spaces; a count that
 * is roughly right and always the same beats one that is sometimes clever.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export interface DocumentStats {
  readonly words: number;
  /**
   * Pages, when they are known. Visual mode renders them, so that count is
   * real; in Text mode the only source is what Word recorded when it last
   * saved, and a document written by anything else has no source at all.
   */
  readonly pages?: number;
}

/**
 * The page count worth showing, from the two there are.
 *
 * The rendered count is a floor: every page the viewer drew is a page, but a
 * document saved by a tool that records no page breaks renders as one long
 * page whatever its length. Word's own count is usually the real one, but can
 * be stale. The larger of the two is never fewer pages than are on screen, and
 * never hides Word's figure behind a render that could not paginate.
 */
export function pageCount(rendered: number | undefined, recorded: number | undefined): number | undefined {
  const counts = [rendered, recorded].filter((value): value is number => value !== undefined && value > 0);
  return counts.length === 0 ? undefined : Math.max(...counts);
}

/** How much document this is, in one line: "24 pages · 6,480 words · ~32 min read". */
export function describeDocument(stats: DocumentStats): string {
  const parts: string[] = [];
  if (stats.pages !== undefined && stats.pages > 0) {
    parts.push(plural(stats.pages, 'page'));
  }
  parts.push(plural(stats.words, 'word'));
  const minutes = readingMinutes(stats.words);
  if (minutes > 0) {
    parts.push(`~${minutes} min read`);
  }
  return parts.join(' · ');
}

function plural(value: number, noun: string): string {
  return `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;
}

/** Reading time in whole minutes, at 200 words per minute, never below one. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 200));
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  return file ? file.async('text') : '';
}

/** The text of the first `<tag>` element, or undefined when it is absent or empty. */
export function readTag(xml: string, tag: string): string | undefined {
  const escaped = tag.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(xml);
  if (!match) {
    return undefined;
  }
  const value = decodeEntities(match[1] ?? '').trim();
  return value === '' ? undefined : value;
}
