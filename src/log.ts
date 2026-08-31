import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/**
 * The extension's log channel, created on first use. Diagnostic detail goes
 * here — user-facing notifications stay short and free of stack traces.
 */
export function getLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('ShowDocx', { log: true });
  return channel;
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
