import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { after, before, describe, it } from 'mocha';

/**
 * The clipboard commands end to end: host to webview and back, then into the
 * real clipboard. The conversion itself is covered by unit tests; what this
 * proves is that pressing the command puts the document where the user can
 * paste it.
 */
describe('Copying a document to the clipboard', () => {
  let fixtures: string;
  let originalClipboard = '';

  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();
    fixtures = path.join(extension.extensionPath, 'test', 'fixtures');

    // These tests write to the real clipboard, so put back what was there.
    originalClipboard = await vscode.env.clipboard.readText();
  });

  after(async () => {
    await vscode.env.clipboard.writeText(originalClipboard);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('copies the document as Markdown', async function () {
    this.timeout(60_000);

    const text = await copyWith('showDocx.copyAsMarkdown', 'simple.docx');

    assert.ok(text.includes('ShowDocx Sample'), text.slice(0, 200));
    assert.ok(text.includes('- Visual page rendering'), 'a list should survive');
    assert.ok(text.includes('**bold**'), 'emphasis should survive');
  });

  it('copies a table as rows rather than loose paragraphs', async function () {
    this.timeout(60_000);

    const text = await copyWith('showDocx.copyAsMarkdown', 'with-tables.docx');

    assert.ok(
      text.includes('| Page layout | Preserved | Simplified |'),
      text.slice(0, 300),
    );
  });

  it('copies plain text with no markup at all', async function () {
    this.timeout(60_000);

    const text = await copyWith('showDocx.copyAsText', 'simple.docx');

    assert.ok(text.includes('ShowDocx Sample'));
    assert.ok(!text.includes('**'), 'plain text must carry no emphasis markers');
    assert.ok(!text.includes('# '), 'plain text must carry no heading markers');
  });

  async function copyWith(command: string, fixture: string): Promise<string> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.env.clipboard.writeText('');

    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(path.join(fixtures, fixture)),
      'showDocx.docxViewer',
    );
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom
        && input.viewType === 'showDocx.docxViewer';
    }, 'the viewer to open');

    // The webview relays the command, so it has to have finished loading. Asking
    // again costs nothing and removes the race.
    let copied = '';
    for (let attempt = 0; attempt < 40 && copied === ''; attempt += 1) {
      await vscode.commands.executeCommand(command);
      for (let wait = 0; wait < 10 && copied === ''; wait += 1) {
        await delay(100);
        copied = await vscode.env.clipboard.readText();
      }
    }
    assert.notEqual(copied, '', `${command} put nothing on the clipboard`);
    return copied;
  }
});

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
