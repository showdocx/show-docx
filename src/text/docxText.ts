import * as mammoth from 'mammoth';
import { fingerprintBytes } from './fingerprint';
import { htmlToText } from './htmlToText';
import type { TextOptions } from './htmlToText';

/**
 * Converts a DOCX to readable text in the extension host, for the callers that
 * have no webview to render in: the diff editor, and the language model tool.
 */

/**
 * Keeps a document's own heading and title styles recognizable, so a diff shows
 * where in the document a change landed rather than a wall of paragraphs.
 */
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

export async function convertDocxToText(
  data: Uint8Array,
  options: TextOptions = {},
): Promise<DocxTextResult> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) },
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
export async function convertDocxToPlainText(data: Uint8Array): Promise<DocxTextResult> {
  const result = await mammoth.extractRawText({
    buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
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
