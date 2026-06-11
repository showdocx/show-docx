import { strict as assert } from 'node:assert';
import type * as vscode from 'vscode';
import { describe, it } from 'mocha';
import { DocxDocument, type DocxDocumentHost } from '../../src/docxDocument';

describe('DocxDocument', () => {
  it('reloads changed data and emits a change event', async () => {
    let triggerChange: () => void = () => undefined;
    let disposed = false;
    const host: DocxDocumentHost = {
      readFile: async () => Uint8Array.from([4, 5, 6]),
      watch: (_uri, onChange) => {
        triggerChange = onChange;
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
    };
    const uri = { toString: () => 'file:///sample.docx' } as vscode.Uri;
    const document = new DocxDocument(uri, Uint8Array.from([1, 2, 3]), host);
    const changed = new Promise<Uint8Array>((resolve) => document.onDidChange(resolve));

    document.startWatching();
    triggerChange();

    assert.deepEqual([...(await changed)], [4, 5, 6]);
    assert.deepEqual([...document.data], [4, 5, 6]);
    document.dispose();
    assert.equal(disposed, true);
  });

  it('emits reload errors without replacing existing data', async () => {
    const expected = new Error('read failed');
    const host: DocxDocumentHost = {
      readFile: async () => {
        throw expected;
      },
      watch: () => ({ dispose: () => undefined }),
    };
    const uri = { toString: () => 'file:///sample.docx' } as vscode.Uri;
    const document = new DocxDocument(uri, Uint8Array.from([9]), host);
    const failed = new Promise<unknown>((resolve) => document.onDidError(resolve));

    await document.reload();

    assert.equal(await failed, expected);
    assert.deepEqual([...document.data], [9]);
    document.dispose();
  });

  it('retries a pending reload after an in-flight reload fails', async () => {
    let triggerChange: () => void = () => undefined;
    let rejectFirstRead: (error: Error) => void = () => undefined;
    let reads = 0;
    const host: DocxDocumentHost = {
      readFile: async () => {
        reads += 1;
        if (reads === 1) {
          return new Promise<Uint8Array>((_resolve, reject) => {
            rejectFirstRead = reject;
          });
        }
        return Uint8Array.from([7, 8, 9]);
      },
      watch: (_uri, onChange) => {
        triggerChange = onChange;
        return { dispose: () => undefined };
      },
    };
    const uri = { toString: () => 'file:///sample.docx' } as vscode.Uri;
    const document = new DocxDocument(uri, Uint8Array.from([1]), host);
    const failed = new Promise<unknown>((resolve) => document.onDidError(resolve));
    const changed = new Promise<Uint8Array>((resolve) => document.onDidChange(resolve));

    document.startWatching();
    triggerChange();
    triggerChange();
    rejectFirstRead(new Error('temporary read failure'));

    assert.match(String(await failed), /temporary read failure/);
    assert.deepEqual([...(await changed)], [7, 8, 9]);
    assert.equal(reads, 2);
    document.dispose();
  });
});
