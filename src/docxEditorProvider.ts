import * as path from 'node:path';
import * as vscode from 'vscode';
import { DocxDocument, type DocxDocumentHost } from './docxDocument';
import {
  DocxFileTooLargeError,
  InvalidDocxError,
} from './errors';
import { loadValidatedDocx } from './docxLoader';
import { getLog } from './log';
import { DEFAULT_CHUNK_SIZE, splitIntoChunks } from './utils/chunks';
import { getNonce } from './utils/getNonce';
import { getWebviewUri } from './utils/getWebviewUri';

type RenderMode = 'visual' | 'text';

/** Collapses the burst of file events one external save produces into one reload. */
const WATCH_DEBOUNCE_MS = 250;

interface ViewerSettings {
  defaultMode: RenderMode;
  defaultZoom: number;
  maxFileSizeMb: number;
  autoReload: boolean;
}

interface WebviewMessage {
  type: string;
  html?: string;
  markdown?: string;
  href?: string;
  message?: string;
  /** Raw diagnostic text for the log channel. Never shown to the user. */
  detail?: string;
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

  public constructor(private readonly context: vscode.ExtensionContext) { }

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocxDocument> {
    const settings = this.getSettings();
    const name = path.basename(uri.path);
    let data: Uint8Array;
    try {
      data = await this.loadDocument(uri);
    } catch (error: unknown) {
      getLog().error(`Opening ${name} failed.`, error);
      throw error;
    }
    getLog().info(`Opened ${name} (${data.byteLength} bytes).`);
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
    entry.subscriptions.push(panel.onDidDispose(() => {
      entry.disposed = true;
      this.disposeEntry(entry);
      this.panels.delete(entry);
      if (this.activeEntry === entry) {
        this.activeEntry = [...this.panels].find((candidate) => candidate.panel.active);
      }
    }));
    entry.subscriptions.push(document.onDidChange(
      () => {
        if (entry.ready) {
          void this.sendDocument(entry, true);
        }
      },
    ));
    entry.subscriptions.push(document.onDidError(
      (error) => {
        getLog().error('Reloading the document failed.', error);
        void this.notify('warning', this.toUserMessage(error));
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
    for (const entry of this.panels) {
      entry.disposed = true;
      this.disposeEntry(entry);
    }
    this.panels.clear();
    this.activeEntry = undefined;
  }

  private disposeEntry(entry: PanelEntry): void {
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.subscriptions.length = 0;
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
      case 'exportMarkdown':
        if (typeof message.markdown === 'string') {
          await this.saveMarkdown(entry.document.uri, message.markdown);
        }
        break;
      case 'exportPdf':
        if (typeof message.html === 'string') {
          await this.exportPdf(entry.document.uri, message.html);
        }
        break;
      case 'openExternal':
        if (typeof message.href === 'string') {
          await this.openExternal(message.href);
        }
        break;
      case 'error':
        getLog().error(
          `Rendering ${path.basename(entry.document.uri.path)} failed: ${message.message ?? 'unknown error'}`,
        );
        if (message.detail) {
          getLog().error(message.detail);
        }
        void this.notify(
          'error',
          message.message ?? 'ShowDocx failed to render the document.',
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

    if (!await entry.panel.webview.postMessage({
      type: 'documentStart',
      ...meta,
      totalChunks: chunks.length,
    })) {
      await this.abortTransfer(entry, meta.fileName);
      return;
    }

    for (let index = 0; index < chunks.length; index += 1) {
      if (entry.disposed || transferId !== entry.transferId) {
        return;
      }
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      // postMessage resolves false when the message was not delivered. Sending
      // the rest would complete a transfer the webview can never reassemble.
      if (!await entry.panel.webview.postMessage({
        type: 'documentChunk',
        transferId,
        index,
        data: Buffer.from(chunk).toString('base64'),
      })) {
        await this.abortTransfer(entry, meta.fileName);
        return;
      }
    }

    if (!entry.disposed && transferId === entry.transferId) {
      await entry.panel.webview.postMessage({
        type: 'documentEnd',
        transferId,
      });
    }
  }

  /**
   * Tells the webview a transfer failed so it shows its error state with the
   * retry button, rather than waiting out its stall watchdog.
   */
  private async abortTransfer(entry: PanelEntry, fileName: string): Promise<void> {
    getLog().error(`Transferring ${fileName} to the webview failed: a message was not delivered.`);
    entry.transferId = 0;
    await entry.panel.webview.postMessage({
      type: 'hostError',
      message: 'ShowDocx could not send the document to the viewer.',
    });
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

  private async saveMarkdown(sourceUri: vscode.Uri, markdown: string): Promise<void> {
    const defaultUri = sourceUri.with({
      path: sourceUri.path.replace(/\.docx$/i, '') + '.md',
    });
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'Markdown document': ['md', 'markdown'],
      },
      saveLabel: 'Export',
      title: 'Export DOCX as Markdown',
    });
    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
    void vscode.window.showInformationMessage(
      `ShowDocx exported ${path.basename(target.path)}.`,
      'Open File',
    ).then((choice) => {
      if (choice === 'Open File') {
        void vscode.commands.executeCommand('vscode.open', target);
      }
    });
  }

  private async exportPdf(sourceUri: vscode.Uri, html: string): Promise<void> {
    const defaultUri = sourceUri.with({
      path: sourceUri.path.replace(/\.docx$/i, '') + '.html',
    });

    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'Printable HTML': ['html', 'htm'],
      },
      saveLabel: 'Save',
      title: 'Save printable HTML, then use Print to PDF in your browser',
    });
    if (!target) {
      return;
    }

    const printHtml = html.includes('</body>')
      ? html.replace(
        '</body>',
        '<script>window.addEventListener("load", function() { setTimeout(function() { window.print(); }, 400); });</script></body>',
      )
      : html;

    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(printHtml));
    await vscode.env.openExternal(target);

    void vscode.window.showInformationMessage(
      `ShowDocx saved ${path.basename(target.path)} and opened your browser's print dialog. Choose "Save as PDF" there to produce the PDF.`,
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
    // This is the restriction behind the manifest's untrustedWorkspaces:
    // "limited". A document from an untrusted folder must not be able to send
    // the user to a destination it chose.
    if (!vscode.workspace.isTrusted) {
      getLog().warn(`Blocked a link in a restricted workspace: ${uri.toString()}`);
      void vscode.window.showWarningMessage(
        'ShowDocx does not open links from documents in a restricted workspace. Trust this workspace to enable them.',
      );
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

        // Word and LibreOffice write a document several times during a single
        // save — temp file, rename, final write. Without a delay each of those
        // events is a full transfer and re-render, and a partially written file
        // can even pass the signature check and flash a corruption error.
        let pending: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
          if (pending) {
            clearTimeout(pending);
          }
          pending = setTimeout(() => {
            pending = undefined;
            onChange();
          }, WATCH_DEBOUNCE_MS);
        };

        const subscriptions = [
          watcher.onDidChange((candidate) => matches(candidate) && schedule()),
          watcher.onDidCreate((candidate) => matches(candidate) && schedule()),
          watcher.onDidDelete((candidate) => matches(candidate) && schedule()),
          {
            dispose: () => {
              if (pending) {
                clearTimeout(pending);
                pending = undefined;
              }
            },
          },
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
      <div class="toolbar-group view-toggles" aria-label="View panels">
        <button id="outline-toggle" class="toolbar-button icon-button" type="button" title="Document outline" aria-label="Toggle document outline" aria-pressed="false">
          <span class="codicon codicon-list-flat"></span>
        </button>
        <button id="comments-toggle" class="toolbar-button icon-button" type="button" title="Comments and changes" aria-label="Toggle comments and changes" aria-pressed="false">
          <span class="codicon codicon-comment-discussion"></span><span id="comment-count" class="badge hidden"></span>
        </button>
        <button id="search-toggle" class="toolbar-button icon-button" type="button" title="Find in document (Ctrl+F)" aria-label="Find in document">
          <span class="codicon codicon-search"></span>
        </button>
      </div>
      <div class="toolbar-spacer"></div>
      <button id="warnings-button" class="toolbar-button icon-button hidden" type="button" title="Rendering warnings" aria-label="Show rendering warnings">
        <span class="codicon codicon-warning"></span><span id="warning-count"></span>
      </button>
      <div class="toolbar-group export-controls" aria-label="Export options">
        <button id="export-button" class="toolbar-button" type="button" title="Export semantic HTML">
          <span class="codicon codicon-export"></span><span>HTML</span>
        </button>
        <button id="export-md-button" class="toolbar-button" type="button" title="Export Markdown">
          <span class="codicon codicon-markdown"></span><span>MD</span>
        </button>
        <button id="export-pdf-button" class="toolbar-button" type="button" title="Save printable HTML and open your browser's print dialog">
          <span class="codicon codicon-file-pdf"></span><span>PDF</span>
        </button>
      </div>
      <button id="print-button" class="toolbar-button" type="button" title="Save printable HTML and open your browser's print dialog">
        <span class="codicon codicon-printer"></span><span>Print</span>
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
    <div id="search-bar" class="showdocx-search-bar hidden" role="search" aria-label="Find in document">
      <span class="codicon codicon-search search-icon" aria-hidden="true"></span>
      <input id="search-input" type="text" placeholder="Find in document..." aria-label="Find in document" />
      <span id="search-count" class="search-count">0/0</span>
      <button id="search-prev" class="toolbar-button icon-button" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match">
        <span class="codicon codicon-arrow-up"></span>
      </button>
      <button id="search-next" class="toolbar-button icon-button" type="button" title="Next match (Enter)" aria-label="Next match">
        <span class="codicon codicon-arrow-down"></span>
      </button>
      <button id="search-close" class="toolbar-button icon-button" type="button" title="Close search (Escape)" aria-label="Close search">
        <span class="codicon codicon-close"></span>
      </button>
    </div>
    <div class="showdocx-main-area">
      <aside id="outline-sidebar" class="showdocx-sidebar showdocx-outline hidden" aria-label="Document outline">
        <div class="sidebar-header">
          <span class="sidebar-title"><span class="codicon codicon-list-flat"></span> Outline</span>
          <button id="outline-close" class="toolbar-button icon-button" type="button" title="Close outline" aria-label="Close outline">
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        <nav id="outline-list" class="sidebar-content outline-list"></nav>
      </aside>
      <aside id="comments-sidebar" class="showdocx-sidebar showdocx-comments hidden" aria-label="Comments and changes">
        <div class="sidebar-header">
          <span class="sidebar-title"><span class="codicon codicon-comment-discussion"></span> Comments</span>
          <button id="comments-close" class="toolbar-button icon-button" type="button" title="Close comments" aria-label="Close comments">
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        <div id="comments-list" class="sidebar-content comments-list"></div>
      </aside>
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
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Shows a short notification with a Show Log action. The detail behind it is
   * already in the log channel — never put it in the message itself.
   */
  private async notify(kind: 'error' | 'warning', message: string): Promise<void> {
    const text = `ShowDocx: ${message}`;
    const choice = kind === 'error'
      ? await vscode.window.showErrorMessage(text, 'Show Log')
      : await vscode.window.showWarningMessage(text, 'Show Log');
    if (choice === 'Show Log') {
      getLog().show();
    }
  }

  private toUserMessage(error: unknown): string {
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
