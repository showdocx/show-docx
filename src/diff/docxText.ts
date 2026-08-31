import * as mammoth from 'mammoth';
import { fingerprintBytes } from './fingerprint';
import { htmlToDiffText } from './htmlToText';

/**
 * Converts a DOCX to the readable text the diff editor compares. mammoth runs in
 * the extension host here rather than the webview: the diff has no webview.
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

export async function convertDocxToDiffText(data: Uint8Array): Promise<DocxTextResult> {
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
    text: htmlToDiffText(result.value),
    messages: result.messages.map((message) => message.message),
  };
}
