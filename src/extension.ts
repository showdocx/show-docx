import * as vscode from 'vscode';
import { DocxEditorProvider } from './docxEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = DocxEditorProvider.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('showDocx.openWith', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage('Select a DOCX file to open with ShowDocx.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, DocxEditorProvider.viewType);
    }),
    vscode.commands.registerCommand('showDocx.exportHtml', () => {
      provider.sendToActivePanel('requestExportHtml');
    }),
    vscode.commands.registerCommand('showDocx.zoomIn', () => {
      provider.sendToActivePanel('zoomIn');
    }),
    vscode.commands.registerCommand('showDocx.zoomOut', () => {
      provider.sendToActivePanel('zoomOut');
    }),
    vscode.commands.registerCommand('showDocx.zoomReset', () => {
      provider.sendToActivePanel('zoomReset');
    }),
    vscode.commands.registerCommand('showDocx.toggleMode', () => {
      provider.sendToActivePanel('toggleMode');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('showDocx')) {
        provider.broadcastSettings();
      }
    }),
  );
}

export function deactivate(): void {
  // Disposables registered in the extension context handle cleanup.
}
