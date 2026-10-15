import { strict as assert } from 'node:assert';
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';
import { mirrorContents, refreshExistingMirror } from '../../src/mirror/markdownMirror';

/**
 * What ShowDocx does differently in a workspace the user has not trusted. The
 * normal run disables workspace trust altogether, so these only run in
 * `npm run test:restricted`, where the test folder opens untrusted.
 */
describe('@restricted Restricted Mode', () => {
  let folder: string;
  /** The settings file a workspace setting is written to, inside the repository. */
  let workspaceSettings: string;
  let hadWorkspaceSettings = false;

  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();
    folder = await mkdtemp(path.join(await realpath(tmpdir()), 'showdocx-restricted-'));
    workspaceSettings = path.join(extension.extensionPath, 'test', 'workspace', '.vscode', 'settings.json');
    hadWorkspaceSettings = await stat(workspaceSettings).then(() => true, () => false);
  });

  after(async () => {
    await vscode.workspace.getConfiguration('showDocx').update(
      'markdownMirrorDirectory',
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
    if (!hadWorkspaceSettings) {
      // Writing a workspace setting created the file; leave the repository as it was.
      await rm(path.dirname(workspaceSettings), { recursive: true, force: true });
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  it('runs in a workspace that is not trusted', () => {
    // Everything below means nothing if the run did not open the folder untrusted.
    assert.equal(vscode.workspace.isTrusted, false);
  });

  it('ignores the workspace\'s own settings for where it writes', async function () {
    this.timeout(20_000);
    const configuration = vscode.workspace.getConfiguration('showDocx');
    await configuration.update('markdownMirrorDirectory', 'somewhere-else', vscode.ConfigurationTarget.Workspace);

    const value = vscode.workspace.getConfiguration('showDocx').get<string>('markdownMirrorDirectory');

    // A repository's .vscode/settings.json must not decide where ShowDocx writes.
    assert.equal(value, '');
  });

  it('does not refresh a mirror on its own', async function () {
    this.timeout(20_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    const source = vscode.Uri.file(path.join(folder, 'spec.docx'));
    await copyFile(path.join(extension.extensionPath, 'test', 'fixtures', 'simple.docx'), source.fsPath);
    const mirror = path.join(folder, 'spec.md');
    await writeFile(mirror, mirrorContents(source, 'as it was'));

    const wrote = await refreshExistingMirror(
      source,
      { read: async (uri) => new Uint8Array(await readFile(uri.fsPath)) },
      { mode: 'onChange', directory: '' },
    );

    assert.equal(wrote, false);
    assert.ok((await readFile(mirror, 'utf8')).includes('as it was'));
  });

  it('does not run git to compare a document', async function () {
    this.timeout(20_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    // A document inside this repository, which a trusted run compares.
    const document = vscode.Uri.file(path.join(extension.extensionPath, 'test', 'workspace', 'simple.docx'));

    await vscode.commands.executeCommand('showDocx.compareWithHead', document);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const diffs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTextDiff
        && tab.input.original.scheme === 'showdocx-diff');
    assert.deepEqual(diffs, []);
  });
});
