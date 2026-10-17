import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'mocha';
import { DEFAULT_CHUNK_SIZE, splitIntoChunks } from '../../src/utils/chunks';

interface Entry {
  disposed: boolean;
  transferId: number;
  document: { data: Uint8Array; uri: { path: string; toString(): string } };
  panel: { webview: { postMessage(message: { type: string; data?: Uint8Array }): Promise<boolean> } };
  validatedData?: Uint8Array;
  validatedZip?: object;
  preparedData?: Uint8Array;
}

interface Sender {
  transferSequence: number;
  sendDocument(entry: Entry, reload: boolean): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Exercise the compiled provider itself with just its I/O seams replaced. This
// makes the preparation race deterministic without loading VS Code or timers.
function sender(
  validate: (data: Uint8Array) => Promise<object>,
  prepare: (data: Uint8Array, zip: object) => Promise<Uint8Array>,
): Sender {
  const exports = { DocxEditorProvider: { prototype: {} } };
  const dependencies: Record<string, unknown> = {
    'node:path': path,
    './docxLoader': {
      loadAndValidateZip: validate,
      zipValidationOptionsFor: () => ({}),
    },
    './text/docxText': { makeVisibleDocxBytes: prepare },
    './utils/chunks': { DEFAULT_CHUNK_SIZE, splitIntoChunks },
  };
  runInNewContext(readFileSync(path.resolve('dist-test/src/docxEditorProvider.js'), 'utf8'), {
    exports,
    require: (name: string) => dependencies[name] ?? {},
    Uint8Array,
  });
  return Object.assign(Object.create(exports.DocxEditorProvider.prototype) as Sender, {
    transferSequence: 0,
    readFacts: async () => undefined,
    getSettings: () => ({}),
    documentState: { get: () => undefined },
  });
}

function entry() {
  const sent: Uint8Array[] = [];
  const value: Entry = {
    disposed: false,
    transferId: 0,
    document: { data: new Uint8Array([1]), uri: { path: '/document.docx', toString: () => 'document' } },
    panel: { webview: {
      postMessage: async (message) => {
        if (message.type === 'document' && message.data) {sent.push(message.data);}
        return true;
      },
    } },
  };
  return { value, sent };
}

for (const stage of ['validation', 'preparation'] as const) {
  describe(`Document transfer cache with slow ${stage}`, () => {
    it('does not publish an older result after a newer document has been sent', async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      let preparations = 0;
      const waitForOld = async (data: Uint8Array) => {
        if (data[0] === 1) {
          started.resolve();
          await release.promise;
        }
      };
      const provider = sender(async (data) => {
        if (stage === 'validation') {await waitForOld(data);}
        return { source: data };
      }, async (data) => {
        preparations += 1;
        if (stage === 'preparation') {await waitForOld(data);}
        return data;
      });
      const { value, sent } = entry();
      const old = provider.sendDocument(value, false);
      await started.promise;
      const current = new Uint8Array([2]);
      value.document.data = current;
      await provider.sendDocument(value, true);
      release.resolve();
      await old;
      await provider.sendDocument(value, true);
      assert.deepEqual(sent.map((data) => [...data]), [[2], [2]]);
      assert.equal(value.validatedData, current);
      assert.equal(value.preparedData, current);
      assert.equal(preparations, 2, 'retry reuses the completed current preparation');
    });

    it('does not retain prepared bytes after a panel is disposed', async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      const provider = sender(async () => {
        if (stage === 'validation') {started.resolve(); await release.promise;}
        return {};
      }, async (data) => {
        if (stage === 'preparation') {started.resolve(); await release.promise;}
        return data;
      });
      const { value, sent } = entry();
      const pending = provider.sendDocument(value, false);
      await started.promise;
      value.disposed = true;
      release.resolve();
      await pending;
      assert.deepEqual(sent, []);
      assert.equal(value.validatedData, undefined);
      assert.equal(value.preparedData, undefined);
    });
  });
}
