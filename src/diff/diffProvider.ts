import * as path from 'node:path';
import * as vscode from 'vscode';
import { convertDocxToText } from './docxText';
import { getLog } from '../log';

/**
 * Serves the readable text of a DOCX revision to the diff editor, as a virtual
 * read-only document. VS Code's diff editor works on text, and this is the text
 * it is given for each side.
 */

export const DIFF_SCHEME = 'showdocx-diff';

/** Marks the side of the diff that reads the file as it is on disk. */
export const WORKING_TREE = 'working tree';

export interface DiffSource {
  /** The DOCX the text was produced from. */
  readonly uri: vscode.Uri;
  /** The git revision, or undefined for the file on disk. */
  readonly ref: string | undefined;
}

/**
 * Builds the URI for one side of the diff. The `.md` suffix is what gives the
 * document Markdown highlighting; the label before it is what the diff editor
 * shows above that side.
 */
export function encodeDiffUri(source: vscode.Uri, ref: string | undefined): vscode.Uri {
  const label = `${path.basename(source.path)} (${ref ?? WORKING_TREE})`;
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${label}.md`,
    query: `ref=${encodeURIComponent(ref ?? '')}&source=${encodeURIComponent(source.toString())}`,
  });
}

export function decodeDiffUri(uri: vscode.Uri): DiffSource | undefined {
  const parameters = new Map<string, string>();
  for (const pair of uri.query.split('&')) {
    const separator = pair.indexOf('=');
    if (separator > 0) {
      parameters.set(pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1)));
    }
  }

  const source = parameters.get('source');
  if (!source) {
    return undefined;
  }
  try {
    const ref = parameters.get('ref');
    return { uri: vscode.Uri.parse(source, true), ref: ref === '' ? undefined : ref };
  } catch {
    return undefined;
  }
}

export interface DiffContentHost {
  /** Reads the document as it is on disk, size-checked like the viewer does. */
  readWorkingTree(uri: vscode.Uri): Promise<Uint8Array>;
  /** Reads the document as it was at a git revision. */
  readAtRef(uri: vscode.Uri, ref: string): Promise<Uint8Array>;
  /** Watches the file on disk, so an open diff does not go stale. */
  watch(uri: vscode.Uri, onChange: () => void): vscode.Disposable;
}

export class DocxDiffContentProvider
implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  /** One watcher per open working-tree side, keyed by its virtual URI. */
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(private readonly host: DiffContentHost) {
    this.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === DIFF_SCHEME) {
        this.stopWatching(document.uri);
      }
    }));
  }

  public async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const source = decodeDiffUri(uri);
    if (!source) {
      throw new Error('ShowDocx could not tell which document this comparison is for.');
    }

    const data = source.ref === undefined
      ? await this.readAndWatchWorkingTree(uri, source.uri)
      : await this.host.readAtRef(source.uri, source.ref);
    if (token.isCancellationRequested) {
      return '';
    }

    const { text, messages } = await convertDocxToText(data);
    for (const message of messages) {
      getLog().warn(`${path.basename(source.uri.path)}: ${message}`);
    }
    // An empty document would leave the diff editor blank with no explanation.
    return text === '' ? '(this revision has no readable text)\n' : text;
  }

  /** Re-reads both sides of a comparison that is already open. */
  public refresh(uri: vscode.Uri): void {
    this.changeEmitter.fire(uri);
  }

  public dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.changeEmitter.dispose();
  }

  private async readAndWatchWorkingTree(
    diffUri: vscode.Uri,
    source: vscode.Uri,
  ): Promise<Uint8Array> {
    const key = diffUri.toString();
    if (!this.watchers.has(key)) {
      this.watchers.set(key, this.host.watch(source, () => this.changeEmitter.fire(diffUri)));
    }
    return this.host.readWorkingTree(source);
  }

  private stopWatching(uri: vscode.Uri): void {
    const key = uri.toString();
    this.watchers.get(key)?.dispose();
    this.watchers.delete(key);
  }
}
