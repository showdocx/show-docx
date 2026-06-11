import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { describe, it } from 'mocha';

describe('ShowDocx extension', () => {
  it('activates and registers its public commands', async () => {
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'showDocx.openWith',
      'showDocx.exportHtml',
      'showDocx.zoomIn',
      'showDocx.zoomOut',
      'showDocx.zoomReset',
      'showDocx.toggleMode',
    ]) {
      assert.ok(commands.includes(command), `Expected command ${command} to be registered.`);
    }
  });
});
