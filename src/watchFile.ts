import * as path from 'node:path';
import * as vscode from 'vscode';

/** Characters a glob reads as syntax: wildcards, ranges and alternations. */
const GLOB_SYNTAX = /[*?[\]{}]/;

/**
 * What to watch for one file: the file's own folder, without recursion.
 *
 * The pattern is a glob, so a name is only usable as one when it holds no glob
 * syntax. "Rapor [v2].docx" read as a glob is "Rapor v.docx" or "Rapor 2.docx",
 * and never matched the file itself — its changes simply never arrived. Such a
 * name is watched as `*`, every file in the folder, which costs one URI
 * comparison per event: the listeners below already accept only the file.
 */
export function watchPatternFor(uri: vscode.Uri): vscode.RelativePattern {
  const fileName = path.posix.basename(uri.path);
  const folder = uri.with({ path: path.posix.dirname(uri.path) });
  return new vscode.RelativePattern(folder, GLOB_SYNTAX.test(fileName) ? '*' : fileName);
}

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
  const watcher = vscode.workspace.createFileSystemWatcher(watchPatternFor(uri));
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
