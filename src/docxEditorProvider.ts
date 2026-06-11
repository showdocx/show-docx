import * as path from 'node:path';
import * as vscode from 'vscode';
import { DocxDocument, type DocxDocumentHost } from './docxDocument';
import {
  DocxFileTooLargeError,
  InvalidDocxError,
} from './errors';
import { loadValidatedDocx } from './docxLoader';
import { DEFAULT_CHUNK_SIZE, splitIntoChunks } from './utils/chunks';
import { getNonce } from './utils/getNonce';
import { getWebviewUri } from './utils/getWebviewUri';

type RenderMode = 'visual' | 'text';

interface ViewerSettings {
  defaultMode: RenderMode;
  defaultZoom: number;
  maxFileSizeMb: number;
  autoReload: boolean;
}

interface WebviewMessage {
  type: string;
  html?: string;
  href?: string;
  message?: string;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  document: DocxDocument;
  ready: boolean;
  disposed: boolean;
  transferId: number;
  subscriptions: vscode.Disposable[];
}

export class DocxEditorProvider implements vscode.CustomReadonlyEditorProvider<DocxDocument> {
  public static readonly viewType = 'showDocx.docxViewer';
  private readonly panels = new Set<PanelEntry>();
  private activeEntry: PanelEntry | undefined;
  private transferSequence = 0;

  public static register(context: vscode.ExtensionContext): DocxEditorProvider {
    const provider = new DocxEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        DocxEditorProvider.viewType,
        provider,
        {
          supportsMultipleEditorsPerDocument: false,
          webviewOptions: {
            retainContextWhenHidden: true,
          },
        },
      ),
      provider,
    );
    return provider;
  }

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocxDocument> {
    const settings = this.getSettings();
    const data = await this.loadDocument(uri);
    const host = this.createDocumentHost(settings.autoReload);
    const document = new DocxDocument(uri, data, host);
    if (settings.autoReload) {
      document.startWatching();
    }
    return document;
  }

  public async resolveCustomEditor(
    document: DocxDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    const entry: PanelEntry = {
      panel,
      document,
      ready: false,
      disposed: false,
      transferId: 0,
      subscriptions: [],
    };
    this.panels.add(entry);
    this.activeEntry = entry;

    entry.subscriptions.push(panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.onMessage(entry, message),
    ));
    entry.subscriptions.push(panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) {
          this.activeEntry = entry;
        }
      },
    ));
    panel.onDidDispose(
      () => {
        entry.disposed = true;
        for (const subscription of entry.subscriptions) {
          subscription.dispose();
        }
        entry.subscriptions.length = 0;
        this.panels.delete(entry);
        if (this.activeEntry === entry) {
          this.activeEntry = [...this.panels].find((candidate) => candidate.panel.active);
        }
      },
      undefined,
      this.context.subscriptions,
    );
    entry.subscriptions.push(document.onDidChange(
      () => {
        if (entry.ready) {
          void this.sendDocument(entry, true);
        }
      },
    ));
    entry.subscriptions.push(document.onDidError(
      (error) => {
        void vscode.window.showWarningMessage(`ShowDocx: ${this.toUserMessage(error)}`);
      },
    ));

    panel.webview.html = this.getHtmlForWebview(panel.webview);
  }

  public sendToActivePanel(type: string): boolean {
    const entry = this.getActiveEntry();
    if (!entry) {
      return false;
    }
    void entry.panel.webview.postMessage({ type });
    return true;
  }

  public broadcastSettings(): void {
    const settings = this.getSettings();
    for (const entry of this.panels) {
      if (!entry.disposed) {
        void entry.panel.webview.postMessage({
          type: 'settingsChanged',
          settings,
        });
      }
    }
  }

  public dispose(): void {
    this.panels.clear();
    this.activeEntry = undefined;
  }

  private getActiveEntry(): PanelEntry | undefined {
    if (this.activeEntry && !this.activeEntry.disposed) {
      return this.activeEntry;
    }
    return [...this.panels].find((entry) => entry.panel.active && !entry.disposed);
  }

  private async onMessage(entry: PanelEntry, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        entry.ready = true;
        await this.sendDocument(entry, false);
        break;
      case 'retry':
        await this.sendDocument(entry, true);
        break;
      case 'exportHtml':
        if (typeof message.html === 'string') {
          await this.saveHtml(entry.document.uri, message.html);
        }
        break;
      case 'openExternal':
        if (typeof message.href === 'string') {
          await this.openExternal(message.href);
        }
        break;
      case 'error':
        void vscode.window.showErrorMessage(
          message.message ? `ShowDocx: ${message.message}` : 'ShowDocx failed to render the document.',
        );
        break;
      default:
        break;
    }
  }

  private async sendDocument(entry: PanelEntry, reload: boolean): Promise<void> {
    if (entry.disposed) {
      return;
    }

    const transferId = ++this.transferSequence;
    entry.transferId = transferId;
    const data = entry.document.data;
    const chunks = splitIntoChunks(data, DEFAULT_CHUNK_SIZE);
    const meta = {
      transferId,
      fileName: path.basename(entry.document.uri.path),
      fileSize: data.byteLength,
      settings: this.getSettings(),
      reload,
    };

    if (chunks.length === 1) {
      await entry.panel.webview.postMessage({
        type: 'document',
        ...meta,
        data: Buffer.from(data).toString('base64'),
      });
      return;
    }

    await entry.panel.webview.postMessage({
      type: 'documentStart',
      ...meta,
      totalChunks: chunks.length,
    });

    for (let index = 0; index < chunks.length; index += 1) {
      if (entry.disposed || transferId !== entry.transferId) {
        return;
      }
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      await entry.panel.webview.postMessage({
        type: 'documentChunk',
        transferId,
        index,
        data: Buffer.from(chunk).toString('base64'),
      });
    }

    if (!entry.disposed && transferId === entry.transferId) {
      await entry.panel.webview.postMessage({
        type: 'documentEnd',
        transferId,
      });
    }
  }

  private async saveHtml(sourceUri: vscode.Uri, html: string): Promise<void> {
    const defaultUri = sourceUri.with({
      path: sourceUri.path.replace(/\.docx$/i, '') + '.html',
    });
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'HTML document': ['html', 'htm'],
      },
      saveLabel: 'Export',
      title: 'Export DOCX as HTML',
    });
    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
    void vscode.window.showInformationMessage(
      `ShowDocx exported ${path.basename(target.path)}.`,
      'Open File',
    ).then((choice) => {
      if (choice === 'Open File') {
        void vscode.commands.executeCommand('vscode.open', target);
      }
    });
  }

  private async openExternal(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (!['https', 'http', 'mailto'].includes(uri.scheme.toLowerCase())) {
      return;
    }
    await vscode.env.openExternal(uri);
  }

  private createDocumentHost(enableWatch: boolean): DocxDocumentHost {
    return {
      readFile: (uri) => this.loadDocument(uri),
      watch: (uri, onChange) => {
        if (!enableWatch) {
          return { dispose: () => undefined };
        }

        const fileName = path.basename(uri.path);
        const pattern = uri.scheme === 'file'
          ? new vscode.RelativePattern(path.dirname(uri.fsPath), fileName)
          : `**/${fileName}`;
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const matches = (candidate: vscode.Uri) => candidate.toString() === uri.toString();
        const subscriptions = [
          watcher.onDidChange((candidate) => matches(candidate) && onChange()),
          watcher.onDidCreate((candidate) => matches(candidate) && onChange()),
          watcher.onDidDelete((candidate) => matches(candidate) && onChange()),
        ];
        return vscode.Disposable.from(watcher, ...subscriptions);
      },
    };
  }

  private loadDocument(uri: vscode.Uri): Promise<Uint8Array> {
    const maxSize = this.getSettings().maxFileSizeMb * 1024 * 1024;
    return loadValidatedDocx(uri, maxSize, vscode.workspace.fs);
  }

  private getSettings(): ViewerSettings {
    const configuration = vscode.workspace.getConfiguration('showDocx');
    return {
      defaultMode: configuration.get<RenderMode>('defaultMode', 'visual'),
      defaultZoom: clamp(configuration.get<number>('defaultZoom', 100), 25, 400),
      maxFileSizeMb: clamp(configuration.get<number>('maxFileSizeMb', 100), 1, 500),
      autoReload: configuration.get<boolean>('autoReload', true),
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = getWebviewUri(
      webview,
      this.context.extensionUri,
      'dist',
      'webview',
      'main.js',
    );
    const styleUri = getWebviewUri(
      webview,
      this.context.extensionUri,
      'dist',
      'webview',
      'main.css',
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>ShowDocx</title>
</head>
<body>
  <div id="app" class="showdocx-app">
    <header class="showdocx-toolbar" role="toolbar" aria-label="Document viewer controls">
      <div class="toolbar-file">
        <span class="codicon codicon-file-word" aria-hidden="true"></span>
        <span id="file-name" class="file-name">DOCX document</span>
        <span id="file-size" class="file-size"></span>
      </div>
      <div class="toolbar-group mode-switcher" aria-label="Rendering mode">
        <button id="mode-visual" class="toolbar-button mode-button" type="button" aria-pressed="true">
          <span class="codicon codicon-preview"></span><span>Visual</span>
        </button>
        <button id="mode-text" class="toolbar-button mode-button" type="button" aria-pressed="false">
          <span class="codicon codicon-list-tree"></span><span>Text</span>
        </button>
      </div>
      <div class="toolbar-spacer"></div>
      <button id="warnings-button" class="toolbar-button icon-button hidden" type="button" title="Rendering warnings" aria-label="Show rendering warnings">
        <span class="codicon codicon-warning"></span><span id="warning-count"></span>
      </button>
      <button id="print-button" class="toolbar-button" type="button" title="Print document">
        <span class="codicon codicon-printer"></span><span>Print</span>
      </button>
      <button id="export-button" class="toolbar-button" type="button" title="Export semantic HTML">
        <span class="codicon codicon-export"></span><span>HTML</span>
      </button>
      <div class="toolbar-group zoom-controls" aria-label="Zoom controls">
        <button id="zoom-out" class="toolbar-button icon-button" type="button" title="Zoom out" aria-label="Zoom out">
          <span class="codicon codicon-zoom-out"></span>
        </button>
        <button id="zoom-reset" class="zoom-value" type="button" title="Reset zoom">100%</button>
        <button id="zoom-in" class="toolbar-button icon-button" type="button" title="Zoom in" aria-label="Zoom in">
          <span class="codicon codicon-zoom-in"></span>
        </button>
      </div>
    </header>
    <aside id="warnings-panel" class="warnings-panel hidden" aria-live="polite"></aside>
    <main id="viewport" class="showdocx-viewport">
      <div id="loading" class="showdocx-loading">
        <div class="spinner" aria-hidden="true"></div>
        <div id="loading-label">Waiting for document...</div>
        <div class="progress-track"><div id="progress-bar" class="progress-bar"></div></div>
      </div>
      <section id="error-state" class="showdocx-error hidden" role="alert">
        <span class="codicon codicon-error error-icon" aria-hidden="true"></span>
        <h1>Unable to preview this document</h1>
        <p id="error-message"></p>
        <button id="retry-button" class="primary-button" type="button">Try again</button>
      </section>
      <div id="zoom-frame" class="zoom-frame hidden">
        <div id="zoom-surface" class="zoom-surface">
          <div id="visual-container" class="render-container visual-container"></div>
          <article id="text-container" class="render-container showdocx-text hidden"></article>
        </div>
      </div>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private toUserMessage(error: unknown): string {
    console.error('ShowDocx failed to reload the document.', error);
    if (error instanceof DocxFileTooLargeError || error instanceof InvalidDocxError) {
      return error.message;
    }
    if (error instanceof vscode.FileSystemError) {
      return 'The document is unavailable or was removed. The last valid preview is still shown.';
    }
    return 'The document changed, but ShowDocx could not reload it. The last valid preview is still shown.';
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
