import { strict as assert } from 'node:assert';
import type * as vscode from 'vscode';
import { describe, it } from 'mocha';
import {
  DocxFileTooLargeError,
  DocxParseError,
  InvalidDocxError,
  formatBytes,
  isLikelyDocx,
} from '../../src/errors';

describe('DOCX errors', () => {
  it('formats byte values for user-facing messages', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.50 KB');
    assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
  });

  it('includes the size limit in large-file errors', () => {
    const error = new DocxFileTooLargeError(120 * 1024 * 1024, 100 * 1024 * 1024);
    assert.match(error.message, /120 MB/i);
    assert.match(error.message, /100 MB/i);
  });

  it('creates parse and invalid-file errors', () => {
    const uri = { path: '/sample.docx' } as vscode.Uri;
    assert.match(new DocxParseError('bad archive', uri).message, /bad archive/);
    assert.match(new InvalidDocxError().message, /not a valid DOCX/i);
  });

  it('recognizes common ZIP signatures', () => {
    assert.equal(isLikelyDocx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), true);
    assert.equal(isLikelyDocx(Uint8Array.from([0x00, 0x01, 0x02, 0x03])), false);
  });
});
