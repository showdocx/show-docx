import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, it } from 'mocha';
import { DocxEditorProvider } from '../../src/docxEditorProvider';

describe('DOCX custom editor provider', () => {
  let provider: DocxEditorProvider | undefined;

  afterEach(async () => {
    provider?.dispose();
    provider = undefined;
    await vscode.workspace.getConfiguration('showDocx').update(
      'maxFileSizeMb',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('opens a valid DOCX with the ShowDocx custom editor', async function () {
    this.timeout(20_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    await extension.activate();

    const fixture = vscode.Uri.file(
      path.join(extension.extensionPath, 'test', 'fixtures', 'simple.docx'),
    );
    await vscode.commands.executeCommand(
      'vscode.openWith',
      fixture,
      'showDocx.docxViewer',
    );

    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom
        && input.viewType === 'showDocx.docxViewer';
    });

    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom);
    assert.equal(input.viewType, 'showDocx.docxViewer');
  });

  it('rejects invalid DOCX files', async () => {
    const extension = await activateExtension();
    provider = new DocxEditorProvider({} as vscode.ExtensionContext);
    const fixture = vscode.Uri.file(
      path.join(extension.extensionPath, 'test', 'fixtures', 'corrupted.docx'),
    );

    await assert.rejects(
      provider.openCustomDocument(
        fixture,
        { backupId: undefined, untitledDocumentData: undefined },
        new vscode.CancellationTokenSource().token,
      ),
      /not a valid DOCX/i,
    );
  });

  it('rejects files above the configured limit', async () => {
    const extension = await activateExtension();
    await vscode.workspace.getConfiguration('showDocx').update(
      'maxFileSizeMb',
      1,
      vscode.ConfigurationTarget.Global,
    );
    provider = new DocxEditorProvider({} as vscode.ExtensionContext);
    const fixture = vscode.Uri.file(
      path.join(extension.extensionPath, 'test', 'fixtures', 'large-file.docx'),
    );

    await assert.rejects(
      provider.openCustomDocument(
        fixture,
        { backupId: undefined, untitledDocumentData: undefined },
        new vscode.CancellationTokenSource().token,
      ),
      /exceeds maximum/i,
    );
  });
});

async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension('showdocx.show-docx');
  assert.ok(extension);
  await extension.activate();
  return extension;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the ShowDocx editor to open.');
}
