import * as vscode from 'vscode';
import { describeDocument } from './text/documentFacts';
import type { DocumentStats } from './text/documentFacts';

/**
 * How much document this is, while one is open: pages, words and a reading
 * time. It answers "is this worth starting now?" before the reader commits to
 * it, and the word count is what anyone writing to a limit is looking for.
 */
export class DocumentStatusBar {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      'showDocx.documentStats',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = 'ShowDocx document';
    this.item.command = 'showDocx.showProperties';
  }

  public update(stats: DocumentStats | undefined): void {
    if (!stats || stats.words === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(file-word) ${describeDocument(stats)}`;
    this.item.tooltip = 'ShowDocx: show document properties';
    this.item.show();
  }

  public hide(): void {
    this.item.hide();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
