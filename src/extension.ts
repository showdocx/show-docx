import * as vscode from 'vscode';
import { compareWithHead, isComparableDocx, readDocxAtRef } from './diff/compareWithHead';
import { DIFF_SCHEME, DocxDiffContentProvider } from './diff/diffProvider';
import { DocxEditorProvider } from './docxEditorProvider';
import { extractImages } from './extractImages';
import { cancelMirrorRefresh, disposeMirrorRefreshes, scheduleMirrorRefresh, writeWorkspaceMirrors } from './mirror/markdownMirror';
import { DocumentTextIndex, showWorkspaceSearch } from './search/workspaceSearch';
import { validateDocxBytes, zipValidationOptionsFor } from './docxLoader';
import { disposeLog, getLog } from './log';
import { registerChatParticipant } from './lm/chatParticipant';
import { registerReadDocxTool } from './lm/readDocxTool';
import { watchFile } from './watchFile';
import { SEARCH_FILENAME_PATTERN } from '../shared/documentExtensions';

/**
 * What the integration tests can ask of a running extension: whether a real
 * webview, in a real VS Code, received a document and rendered it. Nothing
 * else can see inside the webview, and the harness the webview tests use is
 * not VS Code. Returned only in test mode, so it is no API anyone can rely on.
 */
export interface ShowDocxTestApi {
  /** Resolves with the pages rendered, once the viewer of this document reports them. */
  whenRendered(uri: vscode.Uri): Promise<number>;
}

export function activate(context: vscode.ExtensionContext): ShowDocxTestApi | undefined {
  const log = getLog();
  log.info('ShowDocx activated.');
  const provider = DocxEditorProvider.register(context);
  // The workspace search reads documents nobody opened; it applies the same
  // size limit as opening one.
  const documentText = new DocumentTextIndex(vscode.workspace.fs, {
    maxFileSize: () => provider.maxFileSize,
  });

  const documentWatcher = vscode.workspace.createFileSystemWatcher('**/' + SEARCH_FILENAME_PATTERN);
  const mirrorHost = {
    read: (uri: vscode.Uri) => provider.readDocument(uri),
    zipValidationOptions: () => zipValidationOptionsFor(provider.maxFileSize),
  };
  context.subscriptions.push(
    documentWatcher,
    documentWatcher.onDidChange((uri) => {
      documentText.forget(uri);
      scheduleMirrorRefresh(uri, mirrorHost);
    }),
    documentWatcher.onDidCreate((uri) => {
      documentText.forget(uri);
      scheduleMirrorRefresh(uri, mirrorHost);
    }),
    documentWatcher.onDidDelete((uri) => {
      documentText.forget(uri);
      cancelMirrorRefresh(uri);
    }),
    { dispose: disposeMirrorRefreshes },
  );

  const diffProvider = new DocxDiffContentProvider({
    readWorkingTree: (uri) => provider.readDocument(uri),
    readAtRef: async (uri, ref) => {
      // A comparison restored from an earlier session reaches here without the
      // command's own check.
      if (!vscode.workspace.isTrusted) {
        throw new Error('ShowDocx does not run git in a restricted workspace.');
      }
      const maxSize = provider.maxFileSize;
      return validateDocxBytes(await readDocxAtRef(uri, ref, maxSize), maxSize);
    },
    watch: watchFile,
    zipValidationOptions: () => zipValidationOptionsFor(provider.maxFileSize),
  });

  /**
   * The explorer and SCM menus pass the file they were invoked on; the palette
   * and the editor title bar pass nothing, so the focused document stands in.
   */
  const resolveCompareTarget = (uri?: vscode.Uri): vscode.Uri | undefined => {
    if (isComparableDocx(uri)) {
      return uri;
    }
    const active = provider.getActiveDocumentUri();
    if (isComparableDocx(active)) {
      return active;
    }
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    return isComparableDocx(editorUri) ? editorUri : undefined;
  };

  // Undefined on a VS Code without the language model tool API, which is the
  // supported case rather than a failure: engines stays at ^1.85.0.
  const readDocxTool = registerReadDocxTool({
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath),
    read: (uri) => provider.readDocument(uri),
    zipValidationOptions: () => zipValidationOptionsFor(provider.maxFileSize),
  });
  if (readDocxTool) {
    context.subscriptions.push(readDocxTool);
  }

  // Undefined on a VS Code without the chat API, which is supported rather than
  // a failure, for the same reason the tool above is feature-detected.
  const chatParticipant = registerChatParticipant(context, {
    activeDocument: () => provider.getActiveDocumentUri(),
    read: (uri) => provider.readDocument(uri),
    zipValidationOptions: () => zipValidationOptionsFor(provider.maxFileSize),
  });
  if (chatParticipant) {
    context.subscriptions.push(chatParticipant);
  }

  context.subscriptions.push(
    log,
    diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
    vscode.commands.registerCommand('showDocx.compareWithHead', async (uri?: vscode.Uri) => {
      await compareWithHead(resolveCompareTarget(uri), diffProvider);
    }),
    vscode.commands.registerCommand('showDocx.showLog', () => {
      log.show();
    }),
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
    vscode.commands.registerCommand('showDocx.exportMarkdown', () => {
      provider.sendToActivePanel('requestExportMarkdown');
    }),
    vscode.commands.registerCommand('showDocx.exportPdf', () => {
      provider.sendToActivePanel('requestExportPdf');
    }),
    vscode.commands.registerCommand('showDocx.copyAsMarkdown', () => {
      provider.sendToActivePanel('requestCopyMarkdown');
    }),
    vscode.commands.registerCommand('showDocx.copyAsText', () => {
      provider.sendToActivePanel('requestCopyText');
    }),
    vscode.commands.registerCommand('showDocx.search', () => {
      provider.sendToActivePanel('search');
    }),
    vscode.commands.registerCommand('showDocx.searchWorkspace', (query?: unknown) => {
      showWorkspaceSearch(documentText, typeof query === 'string' ? query : undefined);
    }),
    vscode.commands.registerCommand('showDocx.showProperties', () => {
      provider.sendToActivePanel('showProperties');
    }),
    vscode.commands.registerCommand('showDocx.writeMarkdownMirror', async () => {
      await writeWorkspaceMirrors(mirrorHost);
    }),
    vscode.commands.registerCommand('showDocx.extractImages', async (uri?: vscode.Uri) => {
      await extractImages(resolveCompareTarget(uri), {
        read: (target) => provider.readDocument(target),
        zipValidationOptions: () => zipValidationOptionsFor(provider.maxFileSize),
      });
    }),
    // Opens the in-document search already carrying a query. Not in the command
    // palette: it takes an argument, and the workspace search is what sends it.
    vscode.commands.registerCommand('showDocx.searchFor', (query?: unknown) => {
      provider.sendToActivePanel('search', {
        query: typeof query === 'string' ? query : undefined,
      });
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
    vscode.commands.registerCommand('showDocx.cyclePageTheme', () => {
      provider.sendToActivePanel('cyclePageTheme');
    }),
    vscode.commands.registerCommand('showDocx.fitToWidth', () => {
      provider.sendToActivePanel('fitWidth');
    }),
    vscode.commands.registerCommand('showDocx.fitToPage', () => {
      provider.sendToActivePanel('fitPage');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('showDocx')) {
        provider.broadcastSettings();
      }
    }),
  );

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    whenRendered: (uri) => new Promise<number>((resolve) => {
      const subscription = provider.onDidRender((event) => {
        if (event.uri.toString() === uri.toString()) {
          subscription.dispose();
          resolve(event.pages);
        }
      });
    }),
  };
}

export function deactivate(): void {
  // Disposables registered in the extension context handle cleanup.
  disposeLog();
}
