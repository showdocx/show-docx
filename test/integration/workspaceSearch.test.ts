import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
