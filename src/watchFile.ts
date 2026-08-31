import * as path from 'node:path';
import * as vscode from 'vscode';

/** Collapses the burst of file events one external save produces into one call. */
const WATCH_DEBOUNCE_MS = 250;

/**
 * Watches a single file for changes on disk.
 *
 * Word and LibreOffice write a document several times during a single save —
 * temp file, rename, final write. Without the delay each of those events is a
 * full reload, and a partially written file can even pass the signature check
 * and flash a corruption error.
 */
export function watchFile(uri: vscode.Uri, onChange: () => void): vscode.Disposable {
  const fileName = path.basename(uri.path);
  const pattern = uri.scheme === 'file'
    ? new vscode.RelativePattern(path.dirname(uri.fsPath), fileName)
    : `**/${fileName}`;
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const matches = (candidate: vscode.Uri) => candidate.toString() === uri.toString();

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

  return vscode.Disposable.from(
    watcher,
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
  );
}
