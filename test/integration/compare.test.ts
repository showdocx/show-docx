import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import { decodeDiffUri, encodeDiffUri } from '../../src/diff/diffProvider';

const run = promisify(execFile);

describe('Comparing a DOCX with HEAD', () => {
  let repository: string | undefined;
  let document: vscode.Uri | undefined;
  let fixtures: string;

  before(async function () {
    this.timeout(60_000);
    const extension = await activate();
    fixtures = path.join(extension.extensionPath, 'test', 'fixtures');

    if (!await hasGit()) {
      // Without git there is nothing to compare against. Skipping is honest;
      // silently passing would hide a broken feature.
      this.skip();
    }
    repository = await createRepository(fixtures);
    document = vscode.Uri.file(path.join(repository, 'spec.docx'));
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (repository) {
      await removeTemporary(repository);
    }
  });

  it('registers the comparison command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('showDocx.compareWithHead'));
  });

  it('opens the diff editor with both revisions of the document', async function () {
    this.timeout(60_000);
    assert.ok(document);

    await vscode.commands.executeCommand('showDocx.compareWithHead', document);
    await waitFor(() => currentDiffInput() !== undefined, 'the diff editor to open');

    const input = currentDiffInput();
    assert.ok(input, 'expected a diff editor');
    assert.equal(input.original.scheme, 'showdocx-diff');
    assert.equal(input.modified.scheme, 'showdocx-diff');

    const original = decodeDiffUri(input.original);
    const modified = decodeDiffUri(input.modified);
    assert.equal(original?.ref, 'HEAD');
    assert.equal(modified?.ref, undefined);
    assert.equal(original?.uri.fsPath, document.fsPath);
  });

  it('serves each side as the readable text of that revision', async function () {
    this.timeout(60_000);
    assert.ok(document);

    await vscode.commands.executeCommand('showDocx.compareWithHead', document);
    await waitFor(() => currentDiffInput() !== undefined, 'the diff editor to open');
    const input = currentDiffInput();
    assert.ok(input);

    const committed = (await vscode.workspace.openTextDocument(input.original)).getText();
    const working = (await vscode.workspace.openTextDocument(input.modified)).getText();

    // The repository holds simple.docx committed and with-headings.docx on disk.
    assert.ok(committed.includes('ShowDocx Sample'), committed.slice(0, 200));
    assert.ok(working.includes('# Chapter 1: Getting Started'), working.slice(0, 200));
    assert.notEqual(committed, working);
    // Neither side may leak the binary it was produced from.
    assert.ok(!committed.includes('PK'));
  });

  it('does not open a diff for a document outside a repository', async function () {
    this.timeout(60_000);
    const outside = await mkdtemp(path.join(await realpath(tmpdir()), 'showdocx-loose-'));
    try {
      const loose = vscode.Uri.file(path.join(outside, 'loose.docx'));
      await copyFile(path.join(fixtures, 'simple.docx'), loose.fsPath);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      await vscode.commands.executeCommand('showDocx.compareWithHead', loose);

      assert.equal(currentDiffInput(), undefined, 'expected no diff editor');
    } finally {
      await removeTemporary(outside);
    }
  });
});

describe('Diff document URIs', () => {
  const source = vscode.Uri.file(path.join('/repo', 'docs', 'a spec & draft.docx'));

  it('survives the round trip VS Code puts a URI through', () => {
    const encoded = encodeDiffUri(source, 'HEAD');
    const reparsed = vscode.Uri.parse(encoded.toString(), true);
    const decoded = decodeDiffUri(reparsed);

    assert.equal(decoded?.ref, 'HEAD');
    assert.equal(decoded?.uri.toString(), source.toString());
  });

  it('marks the working tree side by having no revision', () => {
    assert.equal(decodeDiffUri(encodeDiffUri(source, undefined))?.ref, undefined);
  });

  it('names each side after the document and its revision', () => {
    assert.ok(encodeDiffUri(source, 'HEAD').path.endsWith('a spec & draft.docx (HEAD).md'));
    assert.ok(encodeDiffUri(source, undefined).path.endsWith('(working tree).md'));
  });

  it('gives two documents from different folders different URIs', () => {
    const other = vscode.Uri.file(path.join('/repo', 'other', 'a spec & draft.docx'));
    assert.notEqual(
      encodeDiffUri(source, 'HEAD').toString(),
      encodeDiffUri(other, 'HEAD').toString(),
    );
  });

  it('rejects a URI that names no document', () => {
    assert.equal(decodeDiffUri(vscode.Uri.parse('showdocx-diff:/x.md')), undefined);
  });
});

async function activate(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension('showdocx.show-docx');
  assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
  await extension.activate();
  return extension;
}

async function hasGit(): Promise<boolean> {
  try {
    await run('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** A repository with one revision committed and a different document on disk. */
async function createRepository(fixtures: string): Promise<string> {
  // realpath first: on macOS the temp directory is reached through a symlink,
  // and git reports the repository under its resolved path.
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'showdocx-diff-'));
  const target = path.join(root, 'spec.docx');
  const git = (...args: string[]) => run('git', args, { cwd: root });

  await git('init', '--quiet');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'ShowDocx Test');
  await copyFile(path.join(fixtures, 'simple.docx'), target);
  await git('add', 'spec.docx');
  await git('commit', '--quiet', '--no-gpg-sign', '-m', 'Add the specification');
  await copyFile(path.join(fixtures, 'with-headings.docx'), target);

  return root;
}

/**
 * Removes a temporary directory, patiently.
 *
 * Windows keeps a handle on a directory that was watched or read a moment ago,
 * and closing an editor does not release it synchronously. This is housekeeping
 * on a temp directory the operating system will reclaim anyway, so it retries
 * and then gives up rather than failing a run over it.
 */
async function removeTemporary(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error: unknown) {
    console.warn(`Could not remove the temporary directory ${directory}:`, error);
  }
}

function currentDiffInput(): vscode.TabInputTextDiff | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff
        && tab.input.original.scheme === 'showdocx-diff') {
        return tab.input;
      }
    }
  }
  return undefined;
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
