import { strict as assert } from 'node:assert';
import type * as vscode from 'vscode';
import { describe, it } from 'mocha';
import { loadValidatedDocx, type DocxFileHost } from '../../src/docxLoader';
import { DocxFileTooLargeError, InvalidDocxError } from '../../src/errors';

const uri = { toString: () => 'file:///sample.docx' } as vscode.Uri;
const validDocx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);

describe('loadValidatedDocx', () => {
  it('loads a valid DOCX within the configured limit', async () => {
    const host = createHost(validDocx, validDocx.byteLength);

    const data = await loadValidatedDocx(uri, 100, host);

    assert.deepEqual([...data], [...validDocx]);
  });

  it('rejects a file whose stat size exceeds the limit without reading it', async () => {
    let read = false;
    const host: DocxFileHost = {
      stat: async () => ({ size: 101 }),
      readFile: async () => {
        read = true;
        return validDocx;
      },
    };

    await assert.rejects(
      loadValidatedDocx(uri, 100, host),
      DocxFileTooLargeError,
    );
    assert.equal(read, false);
  });

  it('rejects a file that grows beyond the limit between stat and read', async () => {
    const host = createHost(new Uint8Array(101).fill(0x50), 50);

    await assert.rejects(
      loadValidatedDocx(uri, 100, host),
      DocxFileTooLargeError,
    );
  });

  it('rejects empty and invalid files', async () => {
    for (const data of [new Uint8Array(), Uint8Array.from([1, 2, 3, 4])]) {
      await assert.rejects(
        loadValidatedDocx(uri, 100, createHost(data, data.byteLength)),
        InvalidDocxError,
      );
    }
  });
});

function createHost(data: Uint8Array, statSize: number): DocxFileHost {
  return {
    stat: async () => ({ size: statSize }),
    readFile: async () => data,
  };
}
