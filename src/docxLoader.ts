import type * as vscode from 'vscode';
import {
  DocxFileTooLargeError,
  InvalidDocxError,
  isLikelyDocx,
} from './errors';

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
