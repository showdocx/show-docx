import type * as vscode from 'vscode';

export interface DocxDocumentHost {
  readFile(uri: vscode.Uri): PromiseLike<Uint8Array>;
  watch(uri: vscode.Uri, onChange: () => void): vscode.Disposable;
}

class EventEmitter<T> implements vscode.Disposable {
  private readonly listeners = new Set<(event: T) => unknown>();
  private disposed = false;

  public readonly event: vscode.Event<T> = (listener, thisArgs, disposables) => {
    if (this.disposed) {
      return { dispose: () => undefined };
    }

    const callback = thisArgs === undefined
      ? listener
      : (event: T) => listener.call(thisArgs, event);
    this.listeners.add(callback);
    const disposable = {
      dispose: () => this.listeners.delete(callback),
    };
    disposables?.push(disposable);
    return disposable;
  };

  public fire(event: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export class DocxDocument implements vscode.CustomDocument {
  private dataValue: Uint8Array;
  private watcher: vscode.Disposable | undefined;
  private disposed = false;
  private reloadInFlight = false;
  private reloadPending = false;

  private readonly changeEmitter = new EventEmitter<Uint8Array>();
  private readonly errorEmitter = new EventEmitter<unknown>();

  public readonly onDidChange = this.changeEmitter.event;
  public readonly onDidError = this.errorEmitter.event;

  public constructor(
    public readonly uri: vscode.Uri,
    data: Uint8Array,
    private readonly host: DocxDocumentHost,
  ) {
    this.dataValue = data;
  }

  public get data(): Uint8Array {
    return this.dataValue;
  }

  public get watching(): boolean {
    return this.watcher !== undefined;
  }

  public startWatching(): void {
    if (this.watcher || this.disposed) {
      return;
    }
    this.watcher = this.host.watch(this.uri, () => {
      void this.reload();
    });
  }

  public stopWatching(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  /**
   * Reads the file again and reports the new contents. With `onlyIfChanged`,
   * contents identical to what is already shown are not reported — for
   * catching up after watching resumes, when nothing may have changed at all.
   */
  public async reload(options: { readonly onlyIfChanged?: boolean } = {}): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.reloadInFlight) {
      this.reloadPending = true;
      return;
    }

    this.reloadInFlight = true;
    try {
      do {
        this.reloadPending = false;
        try {
          const data = await this.host.readFile(this.uri);
          if (this.disposed) {
            return;
          }
          if (options.onlyIfChanged && sameBytes(data, this.dataValue)) {
            continue;
          }
          this.dataValue = data;
          this.changeEmitter.fire(data);
        } catch (error: unknown) {
          if (!this.disposed) {
            this.errorEmitter.fire(error);
          }
        }
      } while (this.reloadPending && !this.disposed);
    } finally {
      this.reloadInFlight = false;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopWatching();
    this.changeEmitter.dispose();
    this.errorEmitter.dispose();
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
