import type * as vscode from 'vscode';

export class DocxParseError extends Error {
  public constructor(
    message: string,
    public readonly uri: vscode.Uri,
  ) {
    super(`Failed to parse DOCX: ${message}`);
    this.name = 'DocxParseError';
  }
}

export class DocxFileTooLargeError extends Error {
  public constructor(
    public readonly size: number,
    public readonly maxSize: number,
  ) {
    super(`File size (${formatBytes(size)}) exceeds maximum (${formatBytes(maxSize)}).`);
    this.name = 'DocxFileTooLargeError';
  }
}

export class InvalidDocxError extends Error {
  public constructor(message = 'This file is empty, corrupted, or is not a valid DOCX document.') {
    super(message);
    this.name = 'InvalidDocxError';
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('Byte count must be a non-negative finite number.');
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, '');
  return `${formatted} ${units[unitIndex]}`;
}

export function isLikelyDocx(data: Uint8Array): boolean {
  return data.byteLength >= 4
    && data[0] === 0x50
    && data[1] === 0x4b
    && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
    && (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08);
}
