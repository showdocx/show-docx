import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { decodeEntities } from './htmlToText';
import { fingerprintBytes } from './fingerprint';
import { loadAndValidateZip } from '../docxLoader';
import type { ZipValidationOptions } from '../docxLoader';
import { scanXmlTags } from './xmlScanner';

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

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.tiff',
  '.tif',
  '.emf',
  '.wmf',
]);
const MAX_SVG_BYTES = 5 * 1024 * 1024;

/** Recognizes an image format; callers must still sanitize SVG before exporting it. */
export function isValidImageBytes(bytes: Uint8Array): boolean {
  return rasterImageExtension(bytes) !== undefined || sanitizeSvg(bytes) !== undefined;
}

function rasterImageExtension(bytes: Uint8Array): string | undefined {
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {return '.png';}
  if (startsWith(0xff, 0xd8, 0xff)) {return '.jpg';}
  if (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)
    || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) {return '.gif';}
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {return '.webp';}
  if (startsWith(0x42, 0x4d) && bytes.length >= 14) {return '.bmp';}
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)
    || startsWith(0x49, 0x49, 0x2b, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2b)) {return '.tif';}
  if (bytes.length >= 44 && startsWith(0x01, 0x00, 0x00, 0x00)
    && bytes[40] === 0x20 && bytes[41] === 0x45 && bytes[42] === 0x4d && bytes[43] === 0x46) {return '.emf';}
  if (startsWith(0xd7, 0xcd, 0xc6, 0x9a)
    || (bytes.length >= 6 && (startsWith(0x01, 0x00) || startsWith(0x02, 0x00)) && bytes[2] === 0x09 && bytes[3] === 0x00)) {return '.wmf';}
  return undefined;
}

export async function readDocumentProperties(data: Uint8Array | JSZip): Promise<DocumentProperties> {
  const zip = data instanceof JSZip ? data : await loadAndValidateZip(data);
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

function areBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Every image in the package, each one once. Word stores a picture used twice
 * as two identical parts, and re-saves a document by writing them all again.
 */
export async function readMedia(
  data: Uint8Array,
  zipOptions?: ZipValidationOptions,
): Promise<MediaEntry[]> {
  const zip = await loadAndValidateZip(data, zipOptions);
  const names = Object.keys(zip.files)
    .filter((name) => /^word\/media\/[^/]+$/.test(name))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));

  const seen = new Map<string, Uint8Array[]>();
  const entries: MediaEntry[] = [];
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    const extension = dot !== -1 ? name.slice(dot).toLowerCase() : '';
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    const file = zip.file(name);
    if (!file || file.dir) {
      continue;
    }
    const bytes = await file.async('uint8array');
    if (bytes.byteLength === 0) {
      continue;
    }

    const expectedExtension = extension === '.jpeg' ? '.jpg' : extension === '.tiff' ? '.tif' : extension;
    if (extension !== '.svg' && rasterImageExtension(bytes) !== expectedExtension) {continue;}
    const safeBytes = extension === '.svg' ? sanitizeSvg(bytes) : bytes;
    if (!safeBytes) {continue;}

    const digest = fingerprintBytes(safeBytes);
    const bucket = seen.get(digest);
    if (bucket && bucket.some((prev) => areBytesEqual(prev, safeBytes))) {
      continue;
    }
    if (bucket) {
      bucket.push(safeBytes);
    } else {
      seen.set(digest, [safeBytes]);
    }
    entries.push({ name, bytes: safeBytes, digest });
  }
  return entries;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use', 'image', 'a',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'clipPath', 'mask', 'marker', 'pattern',
  'linearGradient', 'radialGradient', 'stop', 'filter', 'feBlend',
  'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow',
  'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur',
  'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);
const SVG_PRESENTATION_ATTRIBUTES = new Set([
  'color', 'display', 'visibility', 'opacity', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-path',
  'clip-rule', 'mask', 'filter', 'stop-color', 'stop-opacity', 'flood-color',
  'flood-opacity', 'lighting-color', 'font-family', 'font-size', 'font-style',
  'font-weight', 'font-variant', 'font-stretch', 'text-anchor', 'text-decoration',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing',
  'word-spacing', 'direction', 'unicode-bidi', 'writing-mode', 'vector-effect',
  'paint-order', 'shape-rendering', 'text-rendering', 'image-rendering',
  'color-interpolation', 'color-interpolation-filters', 'marker-start', 'marker-mid', 'marker-end',
]);
const SVG_ATTRIBUTES = new Set([
  ...SVG_PRESENTATION_ATTRIBUTES,
  'id', 'class', 'version', 'viewBox', 'preserveAspectRatio', 'width', 'height',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'transform', 'pathLength', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust',
  'startOffset', 'method', 'spacing', 'offset', 'gradientUnits', 'gradientTransform',
  'spreadMethod', 'fx', 'fy', 'fr', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerUnits',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'filterUnits',
  'primitiveUnits', 'in', 'in2', 'result', 'mode', 'type', 'values', 'operator',
  'k1', 'k2', 'k3', 'k4', 'stdDeviation', 'edgeMode', 'kernelMatrix', 'kernelUnitLength',
  'order', 'targetX', 'targetY', 'divisor', 'bias', 'preserveAlpha', 'scale',
  'xChannelSelector', 'yChannelSelector', 'surfaceScale', 'diffuseConstant',
  'specularConstant', 'specularExponent', 'azimuth', 'elevation', 'pointsAtX',
  'pointsAtY', 'pointsAtZ', 'limitingConeAngle', 'z', 'radius', 'baseFrequency',
  'numOctaves', 'seed', 'stitchTiles', 'tableValues', 'slope', 'intercept',
  'amplitude', 'exponent',
]);

function safeSvgValue(value: string): boolean {
  // Reject escapes/comments rather than trying to normalize every CSS encoding.
  if (/[\\<>@]|\/\*|\*\//.test(value)) {return false;}
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {return false;}
  }
  const withoutLocalReferences = value.replaceAll(/url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi, '');
  return !/url\s*\(|expression\s*\(/i.test(withoutLocalReferences);
}

function safeSvgReference(value: string): boolean {
  if (/^#[\w.:-]+$/.test(value)) {return true;}
  const data = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (!data) {return false;}
  const extension = rasterImageExtension(Buffer.from(data[2] ?? '', 'base64'));
  return extension === (data[1]?.toLowerCase() === 'jpeg' ? '.jpg' : `.${data[1]?.toLowerCase()}`);
}

/** Strips active content and external references before an SVG is written out. */
function sanitizeSvg(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength > MAX_SVG_BYTES) {return undefined;}
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet\b/i.test(source)) {return undefined;}
    let malformed = false;
    const markMalformed = (): void => {malformed = true;};
    const parser = new DOMParser({
      errorHandler: { warning: markMalformed, error: markMalformed, fatalError: markMalformed },
    });
    const document = parser.parseFromString(source, 'image/svg+xml');
    const root = document.documentElement;
    if (malformed || !root || root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {return undefined;}

    for (const element of Array.from(document.getElementsByTagName('*'))) {
      if (element.namespaceURI !== SVG_NAMESPACE || !SVG_ELEMENTS.has(element.localName)) {
        element.parentNode?.removeChild(element);
        continue;
      }
      for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
        const attribute = element.attributes.item(index);
        if (!attribute) {continue;}
        const namespace = attribute.namespaceURI;
        const name = attribute.localName;
        const value = attribute.value.trim();
        let allowed = false;
        if (namespace === XMLNS_NAMESPACE) {
          allowed = value === SVG_NAMESPACE || value === XLINK_NAMESPACE;
        } else if (namespace === XML_NAMESPACE) {
          allowed = name === 'space' || name === 'lang';
        } else if ((!namespace || namespace === XLINK_NAMESPACE) && name === 'href') {
          allowed = safeSvgReference(value);
        } else if (!namespace && name === 'style') {
          allowed = safeSvgValue(value) && value.split(';').every((declaration) => {
            if (declaration.trim() === '') {return true;}
            const colon = declaration.indexOf(':');
            return colon > 0 && SVG_PRESENTATION_ATTRIBUTES.has(declaration.slice(0, colon).trim().toLowerCase());
          });
        } else if (!namespace && SVG_ATTRIBUTES.has(name)) {
          allowed = safeSvgValue(value);
        }
        if (!allowed) {element.removeAttributeNode(attribute);}
      }
    }
    return new TextEncoder().encode(new XMLSerializer().serializeToString(document));
  } catch {
    // A malformed media part must not prevent the remaining pictures being exported.
    return undefined;
  }
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
  const rawExtension = dot > slash ? packagedName.slice(dot).toLowerCase() : '.bin';
  const extension = ALLOWED_IMAGE_EXTENSIONS.has(rawExtension) ? rawExtension : '.bin';

  const sanitizedBase = base
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(char) ? '_' : char))
    .join('')
    .replace(/[. ]+$/, '') || 'image';
  const width = String(total).length;
  return `${sanitizedBase}-${String(index + 1).padStart(width, '0')}${extension}`;
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
  let depth = 0;
  let contentStart = -1;
  for (const token of scanXmlTags(xml)) {
    if (token.name !== tag) {continue;}
    if (token.closing) {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          const value = decodeEntities(xml.slice(contentStart, token.start)).trim();
          return value === '' ? undefined : value;
        }
      }
    } else if (depth > 0) {
      if (!token.selfClosing) {depth += 1;}
    } else if (!token.selfClosing) {
      contentStart = token.end;
      depth = 1;
    }
  }
  return undefined;
}
