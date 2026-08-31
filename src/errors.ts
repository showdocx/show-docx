import { formatBytes } from '../shared/format';

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

export function isLikelyDocx(data: Uint8Array): boolean {
  return data.byteLength >= 4
    && data[0] === 0x50
    && data[1] === 0x4b
    && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
    && (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08);
}
