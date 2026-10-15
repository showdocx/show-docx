import { strict as assert } from 'node:assert';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import { watchFile, watchPatternFor } from '../../src/watchFile';

/**
 * Watching one document on the real file system. The names below are the ones
 * a glob reads as syntax; before the pattern was chosen with that in mind, a
 * change to any of them simply never arrived.
 */
describe('Watching a document for changes on disk', () => {
  let folder: string;

  before(async () => {
    folder = await mkdtemp(path.join(await realpath(tmpdir()), 'showdocx-watch-'));
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('watches a plain name by name, and a name with glob syntax by its folder', () => {
    assert.equal(watchPatternFor(vscode.Uri.file(path.join(folder, 'plain.docx'))).pattern, 'plain.docx');
    for (const name of ['Rapor [v2].docx', 'notes{1}.docx', 'draft?.docx', 'star*.docx']) {
      assert.equal(watchPatternFor(vscode.Uri.file(path.join(folder, name))).pattern, '*', name);
    }
  });

  it('hears a change to a document whatever its name, and only that document', async function () {
    this.timeout(30_000);
    const names = ['plain.docx', 'Rapor [v2].docx', 'notes{1}.docx'];
    const heard = new Map(names.map((name) => [name, 0]));
    const watchers: vscode.Disposable[] = [];
    for (const name of names) {
      await writeFile(path.join(folder, name), 'initial');
    }
    // Give the watchers time to start before anything changes.
    for (const name of names) {
      watchers.push(watchFile(vscode.Uri.file(path.join(folder, name)), () => {
        heard.set(name, (heard.get(name) ?? 0) + 1);
      }));
    }
    await delay(1_500);
    for (const name of names) {
      heard.set(name, 0);
    }

    try {
      await writeFile(path.join(folder, 'Rapor [v2].docx'), 'changed');
      await writeFile(path.join(folder, 'notes{1}.docx'), 'changed');
      await writeFile(path.join(folder, 'plain.docx'), 'changed');
      await waitFor(() => names.every((name) => (heard.get(name) ?? 0) > 0), 15_000);

      // The bracketed names watch the whole folder; the other files' changes
      // still reach only their own listener, so each heard one burst at most.
      const before = new Map(heard);
      await writeFile(path.join(folder, 'unrelated.docx'), 'noise');
      await delay(1_500);
      assert.deepEqual([...heard], [...before]);
    } finally {
      for (const watcher of watchers) {
        watcher.dispose();
      }
    }
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the file watcher.');
    }
    await delay(100);
  }
}
