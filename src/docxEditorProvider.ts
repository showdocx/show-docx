import * as path from 'node:path';
import * as vscode from 'vscode';
import { DocxDocument, type DocxDocumentHost } from './docxDocument';
import {
  DocxFileTooLargeError,
  InvalidDocxError,
} from './errors';
import { DocumentStateStore } from './documentState';
import { loadValidatedDocx } from './docxLoader';
import { getLog } from './log';
import { refreshExistingMirror } from './mirror/markdownMirror';
import { DocumentStatusBar } from './statusBar';
import { convertDocxToPlainText, convertDocxToText } from './text/docxText';
import { countWords, readDocumentProperties } from './text/documentFacts';
import type { DocumentProperties, DocumentStats } from './text/documentFacts';
import { readDocumentStructure } from './text/documentStructure';
import type { DocumentStructure } from './text/documentStructure';
import { extractSearchText } from './text/searchText';
import { stripDocumentExtension } from '../shared/documentExtensions';
import { clamp } from '../shared/format';
import { DEFAULT_CHUNK_SIZE, splitIntoChunks } from './utils/chunks';
import { getNonce } from './utils/getNonce';
import { getWebviewUri } from './utils/getWebviewUri';
import { watchFile } from './watchFile';

type RenderMode = 'visual' | 'text';
type PageTheme = 'paper' | 'sepia' | 'dark';

/**
 * Read once, at registration: VS Code fixes this when the provider registers,
 * so changing it takes effect on the next window. The setting says so.
 */
function readRetainSetting(): boolean {
  return vscode.workspace.getConfiguration('showDocx').get<boolean>('retainHiddenTabs', false);
}

interface ViewerSettings {
  defaultMode: RenderMode;
  defaultZoom: number;
  defaultPageTheme: PageTheme;
  maxFileSizeMb: number;
  autoReload: boolean;
}

interface WebviewMessage {
  type: string;
  html?: string;
  markdown?: string;
  href?: string;
  message?: string;
  /** Pages the viewer rendered, which only Visual mode can know. */
  pages?: number;
  /** Text the reader selected, for the actions offered on a selection. */
  text?: string;
  /** Where the reader is in the document. Validated before it is stored. */
  state?: unknown;
  /** Raw diagnostic text for the log channel. Never shown to the user. */
  detail?: string;
}

interface ExportOptions {
  readonly extension: string;
  readonly filters: Record<string, string[]>;
  readonly title: string;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  document: DocxDocument;
  ready: boolean;
  disposed: boolean;
  transferId: number;
  subscriptions: vscode.Disposable[];
  /** Messages that arrived before the webview could receive them. */
  pending: unknown[];
  /** What the document says about itself, read once per document. */
  facts?: DocumentFacts;
}

interface DocumentFacts {
  readonly properties: DocumentProperties;
  readonly structure: DocumentStructure;
  readonly words: number;
  /** Pages the viewer has actually rendered, once it reports them. */
  renderedPages?: number;
}

export class DocxEditorProvider implements vscode.CustomReadonlyEditorProvider<DocxDocument> {
  public static readonly viewType = 'showDocx.docxViewer';
  private readonly panels = new Set<PanelEntry>();
  private activeEntry: PanelEntry | undefined;
  private transferSequence = 0;
  private readonly documentState: DocumentStateStore;
  private readonly statusBar = new DocumentStatusBar();

  public static register(context: vscode.ExtensionContext): DocxEditorProvider {
    const provider = new DocxEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        DocxEditorProvider.viewType,
        provider,
        {
          supportsMultipleEditorsPerDocument: false,
          webviewOptions: {
            // Off by default. Keeping a hidden tab rendered holds its whole
            // document and DOM in memory for something nobody is looking at,
            // and that grows with every open tab; VS Code's own documentation
            // calls the overhead high. The cost of not keeping it is one
            // re-render on return -- measured at about 190ms for a document of
            // 4,000 paragraphs -- and the reader lands back where they were,
            // because the reading position is restored either way.
            retainContextWhenHidden: readRetainSetting(),
          },
        },
      ),
      provider,
    );
    return provider;
  }

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.documentState = new DocumentStateStore(context.workspaceState);
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocxDocument> {
    const settings = this.getSettings();
    const name = path.basename(uri.path);
    let data: Uint8Array;
    try {
      data = await this.readDocument(uri);
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
      pending: [],
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
        this.refreshStatusBar();
      },
    ));
    entry.subscriptions.push(panel.onDidDispose(() => {
      entry.disposed = true;
      this.disposeEntry(entry);
      this.panels.delete(entry);
      if (this.activeEntry === entry) {
        this.activeEntry = [...this.panels].find((candidate) => candidate.panel.active);
      }
      this.refreshStatusBar();
    }));
    entry.subscriptions.push(document.onDidChange(
      () => {
        if (entry.ready) {
          void this.sendDocument(entry, true);
        }
        // Only ever rewrites a mirror that is already there; see markdownMirror.
        void refreshExistingMirror(document.uri, { read: (uri) => this.readDocument(uri) });
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

  /** The document in the focused viewer, for commands invoked without a target. */
  public getActiveDocumentUri(): vscode.Uri | undefined {
    return this.getActiveEntry()?.document.uri;
  }

  public sendToActivePanel(type: string, payload?: Record<string, unknown>): boolean {
    const entry = this.getActiveEntry();
    if (!entry) {
      return false;
    }
    const message = { type, ...payload };
    if (entry.ready) {
      void entry.panel.webview.postMessage(message);
    } else {
      // A command can reach a viewer that is still loading — opening a document
      // from the workspace search does exactly that. Holding the message is the
      // difference between the search opening at the match and doing nothing.
      entry.pending.push(message);
    }
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
    this.statusBar.dispose();
  }

  /** What the focused document says about itself, for the properties command. */
  public getActiveProperties(): DocumentProperties | undefined {
    return this.getActiveEntry()?.facts?.properties;
  }

  private refreshStatusBar(): void {
    const entry = this.getActiveEntry();
    if (!entry || !entry.panel.active || !entry.facts) {
      this.statusBar.hide();
      return;
    }
    const { facts } = entry;
    const stats: DocumentStats = {
      words: facts.words,
      pages: facts.renderedPages ?? facts.properties.pages,
    };
    this.statusBar.update(stats);
  }

  /**
   * Reads what the document says about itself, once. A failure here is never a
   * reason to stop showing the document, so it leaves the facts unknown.
   */
  private async readFacts(entry: PanelEntry): Promise<void> {
    try {
      const data = entry.document.data;
      const [properties, structure, text] = await Promise.all([
        readDocumentProperties(data),
        readDocumentStructure(data),
        extractSearchText(data),
      ]);
      if (entry.disposed) {
        return;
      }
      entry.facts = { properties, structure, words: countWords(text) };
      this.refreshStatusBar();
      // Sent separately rather than with the document: reading the package must
      // not hold up showing it.
      void entry.panel.webview.postMessage({
        type: 'documentDetails',
        properties,
        structure,
      });
    } catch (error: unknown) {
      getLog().warn(
        `Could not read the properties of ${path.basename(entry.document.uri.path)}.`,
        error,
      );
    }
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
      case 'ready': {
        entry.ready = true;
        await this.sendDocument(entry, false);
        const pending = entry.pending.splice(0);
        for (const queued of pending) {
          void entry.panel.webview.postMessage(queued);
        }
        break;
      }
      case 'retry':
        await this.sendDocument(entry, true);
        break;
      case 'exportHtml':
        if (typeof message.html === 'string') {
          await this.saveHtml(entry.document.uri, message.html);
        }
        break;
      case 'exportMarkdown':
        await this.saveMarkdown(entry.document);
        break;
      case 'copyMarkdown':
        await this.copyToClipboard(entry.document, 'Markdown');
        break;
      case 'copyText':
        await this.copyToClipboard(entry.document, 'plain text');
        break;
      case 'exportPdf':
        if (typeof message.html === 'string') {
          await this.exportPdf(entry.document.uri, message.html);
        }
        break;
      case 'documentStats':
        if (entry.facts && typeof message.pages === 'number' && message.pages > 0) {
          entry.facts.renderedPages = message.pages;
          this.refreshStatusBar();
        }
        break;
      case 'copySelection':
        if (typeof message.text === 'string' && message.text !== '') {
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.setStatusBarMessage('ShowDocx copied the selection.', 4000);
        }
        break;
      case 'searchWorkspaceFor':
        if (typeof message.text === 'string') {
          void vscode.commands.executeCommand('showDocx.searchWorkspace', message.text);
        }
        break;
      case 'requestGoToPage':
        await this.askForPage(entry, message.pages ?? 0);
        break;
      case 'persistState':
        await this.documentState.set(entry.document.uri.toString(), message.state);
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
    entry.facts = undefined;
    void this.readFacts(entry);
    const data = entry.document.data;
    const chunks = splitIntoChunks(data, DEFAULT_CHUNK_SIZE);
    const meta = {
      transferId,
      fileName: path.basename(entry.document.uri.path),
      fileSize: data.byteLength,
      settings: this.getSettings(),
      // Travels with the document, so restoring the reading position costs no
      // extra round trip.
      savedState: this.documentState.get(entry.document.uri.toString()),
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
    const target = await this.writeExport(sourceUri, html, {
      extension: '.html',
      filters: { 'HTML document': ['html', 'htm'] },
      title: 'Export as HTML',
    });
    if (target) {
      this.announceExport(target);
    }
  }

  private async saveMarkdown(document: DocxDocument): Promise<void> {
    const markdown = await this.toMarkdown(document);
    const target = await this.writeExport(document.uri, markdown, {
      extension: '.md',
      filters: { 'Markdown document': ['md', 'markdown'] },
      title: 'Export as Markdown',
    });
    if (target) {
      this.announceExport(target);
    }
  }

  /**
   * Writes an export and says where it went. Which file that is depends on
   * showDocx.exportLocation: "ask" opens the save dialog, "alongside" writes
   * next to the document, because filling in the same dialog on every export of
   * the same file is friction with no decision behind it.
   */
  private async writeExport(
    sourceUri: vscode.Uri,
    contents: string,
    options: ExportOptions,
  ): Promise<vscode.Uri | undefined> {
    const target = await this.resolveExportTarget(sourceUri, options);
    if (!target) {
      return undefined;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(contents));
    return target;
  }

  private async resolveExportTarget(
    sourceUri: vscode.Uri,
    options: ExportOptions,
  ): Promise<vscode.Uri | undefined> {
    const defaultUri = sourceUri.with({
      path: stripDocumentExtension(sourceUri.path) + options.extension,
    });
    if (this.getExportLocation() === 'ask') {
      return vscode.window.showSaveDialog({
        defaultUri,
        filters: options.filters,
        saveLabel: 'Export',
        title: options.title,
      });
    }

    // Skipping the dialog must not mean silently replacing someone's work.
    if (await this.exists(defaultUri)) {
      const choice = await vscode.window.showWarningMessage(
        `${path.basename(defaultUri.path)} already exists. Replace it?`,
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') {
        return undefined;
      }
    }
    return defaultUri;
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private announceExport(target: vscode.Uri): void {
    void vscode.window.showInformationMessage(
      `ShowDocx exported ${path.basename(target.path)}.`,
      'Open File',
    ).then((choice) => {
      if (choice === 'Open File') {
        void vscode.commands.executeCommand('vscode.open', target);
      }
    });
  }

  /**
   * Most of the time the content is wanted in an issue, a message or a code
   * comment rather than in a file, which through the export dialog is a
   * seven-step round trip through a file the user then deletes.
   */
  /**
   * Asks which page to go to. The input belongs to the editor rather than the
   * webview, so it looks and behaves like every other prompt in VS Code.
   */
  private async askForPage(entry: PanelEntry, total: number): Promise<void> {
    if (total <= 0) {
      return;
    }
    const answer = await vscode.window.showInputBox({
      title: 'Go to page',
      prompt: `This document has ${total} page${total === 1 ? '' : 's'}.`,
      validateInput: (value) => {
        const page = Number(value.trim());
        return Number.isInteger(page) && page >= 1 && page <= total
          ? undefined
          : `Enter a page number between 1 and ${total}.`;
      },
    });
    const page = Number((answer ?? '').trim());
    if (Number.isInteger(page) && page >= 1) {
      void entry.panel.webview.postMessage({ type: 'goToPage', page });
    }
  }

  private async copyToClipboard(
    document: DocxDocument,
    format: 'Markdown' | 'plain text',
  ): Promise<void> {
    const name = path.basename(document.uri.path);
    try {
      const text = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `ShowDocx: reading ${name}...` },
        () => (format === 'Markdown'
          ? this.toMarkdown(document)
          : this.toPlainText(document)),
      );
      if (text === '') {
        void vscode.window.showWarningMessage(`ShowDocx: ${name} has no text to copy.`);
        return;
      }
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage(`ShowDocx copied ${name} as ${format}.`, 4000);
    } catch (error: unknown) {
      getLog().error(`Copying ${name} as ${format} failed.`, error);
      void this.notify('error', `${name} could not be converted to ${format}.`);
    }
  }

  /**
   * The Markdown every caller gets: the export, the clipboard and the language
   * model tool all read the same converter, so one document is one answer.
   * Ordered lists are numbered for real here, unlike in a diff, because the
   * numbers are part of what a reader is copying.
   */
  private async toMarkdown(document: DocxDocument): Promise<string> {
    const { text, messages } = await convertDocxToText(document.data, {
      stableOrderedNumbers: false,
    });
    this.logConversion(document, messages);
    return text;
  }

  private async toPlainText(document: DocxDocument): Promise<string> {
    const { text, messages } = await convertDocxToPlainText(document.data);
    this.logConversion(document, messages);
    return text;
  }

  private logConversion(document: DocxDocument, messages: readonly string[]): void {
    const name = path.basename(document.uri.path);
    for (const message of messages) {
      getLog().warn(`${name}: ${message}`);
    }
  }

  private async exportPdf(sourceUri: vscode.Uri, html: string): Promise<void> {
    const printHtml = html.includes('</body>')
      ? html.replace(
        '</body>',
        '<script>window.addEventListener("load", function() { setTimeout(function() { window.print(); }, 400); });</script></body>',
      )
      : html;

    const target = await this.writeExport(sourceUri, printHtml, {
      extension: '.html',
      filters: { 'Printable HTML': ['html', 'htm'] },
      title: 'Save printable HTML, then use Print to PDF in your browser',
    });
    if (!target) {
      return;
    }
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
      readFile: (uri) => this.readDocument(uri),
      watch: (uri, onChange) => (enableWatch
        ? watchFile(uri, onChange)
        : { dispose: () => undefined }),
    };
  }

  /** Reads a DOCX under the viewer's own size and signature checks. */
  public readDocument(uri: vscode.Uri): Promise<Uint8Array> {
    return loadValidatedDocx(uri, this.maxFileSize, vscode.workspace.fs);
  }

  private getExportLocation(): 'ask' | 'alongside' {
    return vscode.workspace.getConfiguration('showDocx')
      .get<'ask' | 'alongside'>('exportLocation', 'ask') === 'alongside'
      ? 'alongside'
      : 'ask';
  }

  public get maxFileSize(): number {
    return this.getSettings().maxFileSizeMb * 1024 * 1024;
  }

  private getSettings(): ViewerSettings {
    const configuration = vscode.workspace.getConfiguration('showDocx');
    return {
      defaultMode: configuration.get<RenderMode>('defaultMode', 'visual'),
      defaultZoom: clamp(configuration.get<number>('defaultZoom', 100), 25, 400),
      defaultPageTheme: configuration.get<PageTheme>('defaultPageTheme', 'paper'),
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
        <button id="properties-toggle" class="toolbar-button icon-button" type="button" title="Document properties" aria-label="Toggle document properties" aria-pressed="false">
          <span class="codicon codicon-info"></span>
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
        <button id="copy-md-button" class="toolbar-button icon-button" type="button" title="Copy the document to the clipboard as Markdown" aria-label="Copy as Markdown">
          <span class="codicon codicon-copy"></span>
        </button>
        <button id="copy-text-button" class="toolbar-button icon-button" type="button" title="Copy the document to the clipboard as plain text" aria-label="Copy as plain text">
          <span class="codicon codicon-symbol-text"></span>
        </button>
      </div>
      <button id="print-button" class="toolbar-button" type="button" title="Save printable HTML and open your browser's print dialog">
        <span class="codicon codicon-printer"></span><span>Print</span>
      </button>
      <button id="page-theme-button" class="toolbar-button icon-button" type="button" title="Page theme" aria-label="Page theme">
        <span class="codicon codicon-color-mode"></span>
      </button>
      <button id="page-indicator" class="toolbar-button page-indicator hidden" type="button" title="Go to a page" aria-label="Go to a page">1 / 1</button>
      <button id="fit-button" class="toolbar-button icon-button" type="button" title="Fit the page to the panel" aria-label="Fit the page to the panel">
        <span class="codicon codicon-screen-full"></span>
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
      <aside id="properties-sidebar" class="showdocx-sidebar showdocx-properties hidden" aria-label="Document properties">
        <div class="sidebar-header">
          <span class="sidebar-title"><span class="codicon codicon-info"></span> Properties</span>
          <button id="properties-close" class="toolbar-button icon-button" type="button" title="Close properties" aria-label="Close properties">
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        <div id="properties-list" class="sidebar-content properties-list"></div>
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
  <div id="context-menu" class="showdocx-context-menu hidden" role="menu"></div>
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

