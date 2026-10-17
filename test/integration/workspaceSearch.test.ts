import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import JSZip from 'jszip';
import { DocxFileTooLargeError } from '../../src/errors';
import { after, before, describe, it } from 'mocha';
import { DocumentTextIndex, searchDocuments } from '../../src/search/workspaceSearch';

/**
 * Searching inside documents, over real files, through the real file system.
 * The matching itself is unit tested; what this covers is the pass over a set
 * of documents, the cache, and opening a result in the viewer.
 */
describe('Searching inside every document', () => {
  let files: vscode.Uri[] = [];
  let index: DocumentTextIndex;

  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();

    const fixtures = path.join(extension.extensionPath, 'test', 'fixtures');
    files = ['simple.docx', 'with-headings.docx', 'with-tables.docx', 'with-images.docx']
      .map((name) => vscode.Uri.file(path.join(fixtures, name)));
    index = new DocumentTextIndex();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('finds a phrase and says which document it is in', async function () {
    this.timeout(60_000);

    const { hits } = await searchDocuments(files, 'Getting Started', index);

    assert.equal(hits.length, 1);
    assert.equal(path.basename(hits[0]?.uri.path ?? ''), 'with-headings.docx');
    assert.ok(hits[0]?.text.includes('Getting Started'));
  });

  it('finds the same words in more than one document', async function () {
    this.timeout(60_000);

    const { hits } = await searchDocuments(files, 'ShowDocx', index);
    const named = new Set(hits.map((hit) => path.basename(hit.uri.path)));

    assert.ok(named.size > 1, `expected several documents, got ${[...named].join(', ')}`);
  });

  it('finds text inside a table, which is where a specification keeps its detail', async function () {
    this.timeout(60_000);

    const { hits } = await searchDocuments(files, 'Theme colors', index);

    assert.equal(path.basename(hits[0]?.uri.path ?? ''), 'with-tables.docx');
  });

  it('reports no hits rather than failing when nothing matches', async function () {
    this.timeout(60_000);

    const outcome = await searchDocuments(files, 'quixotic aardvark', index);

    assert.deepEqual(outcome.hits, []);
    assert.equal(outcome.failures, 0);
  });

  it('carries on past a document it cannot read', async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    const corrupted = vscode.Uri.file(
      path.join(extension.extensionPath, 'test', 'fixtures', 'corrupted.docx'),
    );

    const outcome = await searchDocuments([corrupted, ...files], 'ShowDocx', index);

    assert.equal(outcome.failures, 1, 'the corrupted document should be reported');
    assert.ok(outcome.hits.length > 0, 'the readable documents should still be searched');
  });

  it('does not read a document above the size limit at all', async function () {
    this.timeout(60_000);
    const read: string[] = [];
    const limited = new DocumentTextIndex({
      stat: (uri) => vscode.workspace.fs.stat(uri),
      readFile: (uri) => {
        read.push(path.basename(uri.path));
        return vscode.workspace.fs.readFile(uri);
      },
    }, { maxFileSize: () => 12 * 1024 });
    const large = files.find((uri) => uri.path.endsWith('with-images.docx'));
    assert.ok(large);

    const outcome = await searchDocuments(files, 'ShowDocx', limited);

    // The fixture with images is larger than 12 KB; the others are not.
    assert.equal(outcome.failures, 1);
    assert.ok(!read.includes('with-images.docx'), read.join(', '));
    assert.ok(outcome.hits.length > 0);
  });

  it('does not cache an individual document that exceeds its budget', async function () {
    this.timeout(60_000);
    const small = new DocumentTextIndex(vscode.workspace.fs, { maxCachedCharacters: 1 });

    await searchDocuments(files.slice(0, 2), 'ShowDocx', small);

    assert.equal(small.size, 0);
  });

  it('stops when the search is cancelled', async function () {
    this.timeout(60_000);
    const source = new vscode.CancellationTokenSource();
    source.cancel();

    const outcome = await searchDocuments(files, 'ShowDocx', index, source.token);

    assert.deepEqual(outcome.hits, []);
  });

  it('reads a document once and remembers it', async function () {
    this.timeout(60_000);
    const fresh = new DocumentTextIndex();
    const one = files.slice(0, 1);

    await searchDocuments(one, 'ShowDocx', fresh);
    assert.equal(fresh.size, 1);

    const before = Date.now();
    await searchDocuments(one, 'Overview', fresh);
    const elapsed = Date.now() - before;

    assert.equal(fresh.size, 1, 'the same file should not be stored twice');
    assert.ok(elapsed < 200, `a cached search should be quick, took ${elapsed}ms`);
  });

  it('applies a reduced size limit before returning cached text', async () => {
    const uri = files[0];
    assert.ok(uri);
    let limit = 100 * 1024 * 1024;
    let reads = 0;
    const limited = new DocumentTextIndex({
      stat: (target) => vscode.workspace.fs.stat(target),
      readFile: (target) => {
        reads += 1;
        return vscode.workspace.fs.readFile(target);
      },
    }, { maxFileSize: () => limit });
    await limited.textOf(uri);
    limit = 1;
    await assert.rejects(limited.textOf(uri), DocxFileTooLargeError);
    assert.equal(reads, 1);
  });

  for (const invalidation of ['forget', 'clear'] as const) {
    it(`does not let an old in-flight read refill the cache after ${invalidation}`, async () => {
      const alpha = await searchDocument('Alpha alpha');
      const bravo = await searchDocument('Bravo bravo');
      const uri = vscode.Uri.parse('memory:/unchanged-stamp.docx');
      let started!: () => void;
      const reading = new Promise<void>((resolve) => { started = resolve; });
      let release!: (data: Uint8Array) => void;
      const oldBytes = new Promise<Uint8Array>((resolve) => { release = resolve; });
      let reads = 0;
      const fresh = new DocumentTextIndex({
        stat: async () => ({ ctime: 1, mtime: 1, size: alpha.byteLength, type: vscode.FileType.File }),
        readFile: async () => {
          if (++reads === 1) {
            started();
            return oldBytes;
          }
          return bravo;
        },
      });
      const old = fresh.textOf(uri);
      await reading;
      if (invalidation === 'forget') {fresh.forget(uri);}
      else {fresh.clear();}
      assert.equal(await fresh.textOf(uri), 'Bravo bravo');
      release(alpha);
      assert.equal(await old, 'Alpha alpha');
      assert.equal(await fresh.textOf(uri), 'Bravo bravo');
      assert.equal(reads, 2);
    });
  }

  it('does not cache a provider whose modification time is unknown', async () => {
    const data = await searchDocument('No reliable timestamp');
    let reads = 0;
    const fresh = new DocumentTextIndex({
      stat: async () => ({ ctime: 0, mtime: 0, size: data.byteLength, type: vscode.FileType.File }),
      readFile: async () => { reads += 1; return data; },
    });
    const uri = vscode.Uri.parse('memory:/no-timestamp.docx');
    await fresh.textOf(uri);
    await fresh.textOf(uri);
    assert.equal(reads, 2);
    assert.equal(fresh.size, 0);
  });

  it('evicts the least recently used entry while retaining entries that fit', async () => {
    const data = await searchDocument('Alpha');
    const reads = new Map<string, number>();
    const fresh = new DocumentTextIndex({
      stat: async () => ({ ctime: 1, mtime: 1, size: data.byteLength, type: vscode.FileType.File }),
      readFile: async (uri) => {
        reads.set(uri.path, (reads.get(uri.path) ?? 0) + 1);
        return data;
      },
    }, { maxCachedCharacters: 10 });
    const a = vscode.Uri.parse('memory:/a.docx');
    const b = vscode.Uri.parse('memory:/b.docx');
    const c = vscode.Uri.parse('memory:/c.docx');
    await fresh.textOf(a);
    await fresh.textOf(b);
    await fresh.textOf(a);
    await fresh.textOf(c);
    await fresh.textOf(a);
    assert.equal(reads.get(a.path), 1);
    assert.equal(fresh.size, 2);
    await fresh.textOf(b);
    assert.equal(reads.get(b.path), 2);
  });

  it('opens a result in the viewer, with the query in hand', async function () {
    this.timeout(60_000);
    const { hits } = await searchDocuments(files, 'Getting Started', index);
    const hit = hits[0];
    assert.ok(hit);

    await vscode.commands.executeCommand('vscode.openWith', hit.uri, 'showDocx.docxViewer');
    await vscode.commands.executeCommand('showDocx.searchFor', 'Getting Started');

    // The viewer takes it from here; what matters at this seam is that the
    // document opened in it and the command was accepted.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom);
    assert.equal(input.viewType, 'showDocx.docxViewer');
    assert.equal(input.uri.fsPath, hit.uri.fsPath);
  });
});

async function searchDocument(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}
