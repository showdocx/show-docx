import * as mammoth from 'mammoth';
import type JSZip from 'jszip';
import { fingerprintBytes } from './fingerprint';
import { htmlToText } from './htmlToText';
import type { TextOptions } from './htmlToText';
import { loadAndValidateZip } from '../docxLoader';
import type { ZipValidationOptions } from '../docxLoader';
import { readHiddenStyleInfo, removeHiddenRuns, removeXmlElements } from './xmlScanner';

/**
 * Converts a DOCX to readable text in the extension host, for the callers that
 * have no webview to render in: the diff editor, and the language model tool.
 */

/**
 * Keeps a document's own heading and title styles recognizable, so a diff shows
 * where in the document a change landed rather than a wall of paragraphs.
 */
const HIDDEN_PROPERTIES = new Set(['w:vanish', 'w:specVanish']);

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
];

export interface DocxTextResult {
  readonly text: string;
  /** Conversion warnings, for the log channel. Never part of the text itself. */
  readonly messages: string[];
}

async function preprocessDocxData(data: Uint8Array, zipOptions?: ZipValidationOptions): Promise<Buffer> {
  const zip = await loadAndValidateZip(data, zipOptions);
  return Buffer.from(await makeVisibleDocxBytes(data, zip));
}

/** Removes hidden runs from text-bearing parts before any webview renderer sees them. */
export async function makeVisibleDocxBytes(data: Uint8Array, zip: JSZip): Promise<Uint8Array> {
  const stylesXml = await zip.file('word/styles.xml')?.async('text') ?? '';
  const styles = readHiddenStyleInfo(stylesXml);
  let changed = false;
  const textParts = Object.keys(zip.files).filter((name) =>
    /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+|comments)\.xml$/.test(name),
  );
  for (const name of textParts) {
    const file = zip.file(name);
    if (!file || file.dir) {continue;}
    const originalXml = await file.async('text');
    const visibleXml = removeXmlElements(removeHiddenRuns(originalXml, styles), HIDDEN_PROPERTIES);
    if (visibleXml !== originalXml) {
      zip.file(name, visibleXml);
      changed = true;
    }
  }
  // Visibility has been resolved above, including style toggles and direct
  // overrides. Renderers must not reinterpret the remaining visible runs using
  // their own incomplete implementations of Word's hidden-text inheritance.
  const visibleStyles = removeXmlElements(stylesXml, HIDDEN_PROPERTIES);
  if (visibleStyles !== stylesXml) {
    zip.file('word/styles.xml', visibleStyles);
    changed = true;
  }
  if (!changed) {return data;}
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

export async function convertDocxToText(
  data: Uint8Array,
  options: TextOptions = {},
  zipOptions?: ZipValidationOptions,
): Promise<DocxTextResult> {
  const buffer = await preprocessDocxData(data, zipOptions);
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: STYLE_MAP,
      // An image reaches the HTML as a digest of its own bytes. Inlining the
      // base64 instead would put megabytes through the converter and into a
      // document nobody can read, for content a diff can only report as
      // changed or unchanged anyway.
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `docx-image:${fingerprintBytes(new Uint8Array(await image.readAsArrayBuffer()))}`,
      })),
    },
  );

  return {
    text: htmlToText(result.value, options),
    messages: result.messages.map((message) => message.message),
  };
}

/**
 * The document as unformatted text: one paragraph per line, no markers at all.
 * For pasting somewhere that would show Markdown syntax rather than render it.
 */
export async function convertDocxToPlainText(
  data: Uint8Array,
  zipOptions?: ZipValidationOptions,
): Promise<DocxTextResult> {
  const buffer = await preprocessDocxData(data, zipOptions);
  const result = await mammoth.extractRawText({
    buffer,
  });
  const text = result.value
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: text === '' ? '' : `${text}\n`,
    messages: result.messages.map((message) => message.message),
  };
}
