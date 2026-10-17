import type * as vscode from 'vscode';
import JSZip from 'jszip';
import * as yauzl from 'yauzl';
import {
  DocxFileTooLargeError,
  InvalidDocxError,
  isLikelyDocx,
} from './errors';

export const DEFAULT_MAX_UNCOMPRESSED_SIZE = 100 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 10000;
export const DEFAULT_MAX_ENTRY_SIZE = 50 * 1024 * 1024;

export interface ZipValidationOptions {
  readonly maxUncompressedSize?: number;
  readonly maxEntries?: number;
  readonly maxEntrySize?: number;
}

/**
 * Limits for a DOCX that already passed the viewer's compressed-size setting.
 * The expansion budget accommodates normal compressed XML and media while the
 * per-entry limit keeps one member from monopolizing memory.
 */
export function zipValidationOptionsFor(maxFileSize: number): Required<ZipValidationOptions> {
  const sourceLimit = Number.isFinite(maxFileSize) && maxFileSize > 0
    ? maxFileSize
    : DEFAULT_MAX_UNCOMPRESSED_SIZE;
  return {
    maxUncompressedSize: Math.max(DEFAULT_MAX_UNCOMPRESSED_SIZE, sourceLimit * 2),
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxEntrySize: Math.max(DEFAULT_MAX_ENTRY_SIZE, sourceLimit),
  };
}

export interface DocxFileHost {
  stat(uri: vscode.Uri): PromiseLike<{ size: number }>;
  readFile(uri: vscode.Uri): PromiseLike<Uint8Array>;
}

export async function loadValidatedDocx(
  uri: vscode.Uri,
  maxSize: number,
  host: DocxFileHost,
): Promise<Uint8Array> {
  const stat = await host.stat(uri);
  assertWithinSizeLimit(stat.size, maxSize);

  const data = await host.readFile(uri);
  return validateDocxBytes(data, maxSize);
}

/** The checks that do not need a file on disk, for bytes from any source. */
export function validateDocxBytes(data: Uint8Array, maxSize: number): Uint8Array {
  assertWithinSizeLimit(data.byteLength, maxSize);
  if (!isLikelyDocx(data)) {
    throw new InvalidDocxError();
  }
  return data;
}

function assertWithinSizeLimit(size: number, maxSize: number): void {
  if (size > maxSize) {
    throw new DocxFileTooLargeError(size, maxSize);
  }
}

export async function loadAndValidateZip(
  data: Uint8Array,
  options: ZipValidationOptions = {},
): Promise<JSZip> {
  const effectiveMaxUncompressed = options.maxUncompressedSize
    ?? Math.max(DEFAULT_MAX_UNCOMPRESSED_SIZE, data.byteLength * 4);
  const effectiveMaxEntry = options.maxEntrySize
    ?? Math.max(DEFAULT_MAX_ENTRY_SIZE, data.byteLength);
  await validateZipExpansion(
    data,
    effectiveMaxUncompressed,
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    effectiveMaxEntry,
  );
  const zip = await JSZip.loadAsync(data);
  if (!zip.file('word/document.xml')) {
    throw new Error('The ZIP archive is not a Word document: word/document.xml is missing.');
  }
  return zip;
}

/**
 * Checks declared sizes before opening each entry, then counts decompressed
 * bytes while yauzl streams them. JSZip's async extraction materializes an
 * entire entry before a caller can enforce a limit, which defeats a ZIP-bomb
 * guard. Entry sizes are verified by yauzl as the stream reaches its end.
 */
function validateZipExpansion(
  data: Uint8Array,
  maxUncompressedSize: number,
  maxEntries: number,
  maxEntrySize: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let archive: yauzl.ZipFile | undefined;
    let settled = false;
    let totalUncompressedSize = 0;

    const fail = (error: Error): void => {
      if (settled) {return;}
      settled = true;
      archive?.close();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) {return;}
      settled = true;
      resolve();
    };

    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    void yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }).then((zip) => {
      archive = zip;
      if (zip.entryCount > maxEntries) {
        fail(new Error(`DOCX archive contains too many entries (${zip.entryCount}, max allowed: ${maxEntries}).`));
        return;
      }

      zip.on('error', fail);
      zip.on('end', succeed);
      zip.on('entry', (entry) => {
        if (settled) {return;}
        if (entry.uncompressedSize > maxEntrySize) {
          fail(new Error(`DOCX entry "${entry.fileName}" exceeds maximum allowed uncompressed size (${entry.uncompressedSize} bytes).`));
          return;
        }
        totalUncompressedSize += entry.uncompressedSize;
        if (totalUncompressedSize > maxUncompressedSize) {
          fail(new Error(`DOCX total uncompressed size exceeds maximum allowed limit (${totalUncompressedSize} bytes).`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }

        void zip.openReadStreamPromise(entry).then(async (stream) => {
          let entryBytes = 0;
          for await (const chunk of stream) {
            entryBytes += (chunk as Buffer).byteLength;
            if (entryBytes > maxEntrySize || totalUncompressedSize - entry.uncompressedSize + entryBytes > maxUncompressedSize) {
              stream.destroy();
              throw new Error(`DOCX entry "${entry.fileName}" exceeded its allowed uncompressed size while reading.`);
            }
          }
          if (!settled) {zip.readEntry();}
        }).catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      });
      zip.readEntry();
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
