import * as path from 'node:path';
import * as vscode from 'vscode';
import { convertDocxToText } from '../text/docxText';
import { FILENAME_PATTERN, stripDocumentExtension } from '../../shared/documentExtensions';
import { getLog } from '../log';

/**
 * An optional `.md` mirror of a document, kept next to it.
 *
 * Comparing revisions inside the editor is solved (#35). This is the same
 * problem everywhere else: `git diff` in a terminal, a pull request on GitHub,
 * a code review — all of which see a DOCX as "Binary files differ". A mirror
 * committed alongside the document makes those readable.
 *
 * This writes to the user's repository, so it follows one rule: **it refreshes
 * a mirror that already exists, and never creates one on its own.** Creating a
 * mirror is always something the user asked for, by name, with a count and a
 * destination in front of them. A viewer that quietly adds files to a
 * repository is not a viewer anyone should trust.
 */

export type MirrorMode = 'off' | 'onChange';

export interface MirrorSettings {
  readonly mode: MirrorMode;
  /** Where mirrors go. Empty means beside the document. */
  readonly directory: string;
}

export interface MirrorHost {
  read(uri: vscode.Uri): Promise<Uint8Array>;
}

export function readMirrorSettings(): MirrorSettings {
  const configuration = vscode.workspace.getConfiguration('showDocx');
  const mode = configuration.get<string>('markdownMirror', 'off');
  return {
    mode: mode === 'onChange' ? 'onChange' : 'off',
    directory: (configuration.get<string>('markdownMirrorDirectory', '') ?? '').trim(),
  };
}

/**
 * Where a document's mirror belongs. A configured directory is resolved against
 * the document's workspace folder, so one setting works for every document in
 * the workspace rather than only the folder it was written in.
 */
export function mirrorUriFor(source: vscode.Uri, directory: string): vscode.Uri {
  const name = `${path.posix.basename(stripDocumentExtension(source.path))}.md`;
  if (directory === '') {
    return source.with({ path: `${path.posix.dirname(source.path)}/${name}` });
  }
  const folder = vscode.workspace.getWorkspaceFolder(source);
  const base = folder ? folder.uri : source.with({ path: path.posix.dirname(source.path) });
  return vscode.Uri.joinPath(base, directory, name);
}

/**
 * Rewrites a mirror that is already there. Called when a document changes on
 * disk; a document with no mirror is left alone, which is the whole rule.
 */
export async function refreshExistingMirror(
  source: vscode.Uri,
  host: MirrorHost,
  settings: MirrorSettings = readMirrorSettings(),
): Promise<boolean> {
  if (settings.mode !== 'onChange') {
    return false;
  }
  const target = mirrorUriFor(source, settings.directory);
  if (!await exists(target)) {
    return false;
  }
  try {
    await writeMirror(source, target, host);
    getLog().info(`Refreshed the Markdown mirror ${path.basename(target.path)}.`);
    return true;
  } catch (error: unknown) {
    getLog().error(`Refreshing the mirror of ${path.basename(source.path)} failed.`, error);
    return false;
  }
}

/**
 * Writes mirrors for every Word document in the workspace, after saying how
 * many and where. This is the only path that creates a file.
 */
export async function writeWorkspaceMirrors(host: MirrorHost): Promise<void> {
  const settings = readMirrorSettings();
  const documents = await vscode.workspace.findFiles(
    `**/${FILENAME_PATTERN}`,
    '**/node_modules/**',
  );
  if (documents.length === 0) {
    void vscode.window.showInformationMessage('ShowDocx: no Word documents in this workspace.');
    return;
  }

  const where = settings.directory === ''
    ? 'beside each document'
    : `in ${settings.directory}`;
  const choice = await vscode.window.showWarningMessage(
    `Write a Markdown mirror for ${documents.length} document${documents.length === 1 ? '' : 's'}?`,
    {
      modal: true,
      detail: `A .md file will be written ${where}, and any existing mirror will be replaced.`
        + ' They are meant to be committed, so that git and code review can read'
        + ' what changed in a document.',
    },
    'Write mirrors',
  );
  if (choice !== 'Write mirrors') {
    return;
  }

  let written = 0;
  const failures: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ShowDocx: writing Markdown mirrors' },
    async (progress) => {
      for (const [index, document] of documents.entries()) {
        progress.report({
          message: `${index + 1} of ${documents.length}`,
          increment: 100 / documents.length,
        });
        try {
          await writeMirror(document, mirrorUriFor(document, settings.directory), host);
          written += 1;
        } catch (error: unknown) {
          // One unreadable document must not end the run over the others.
          getLog().error(`Mirroring ${path.basename(document.path)} failed.`, error);
          failures.push(path.basename(document.path));
        }
      }
    },
  );

  const summary = failures.length === 0
    ? `ShowDocx wrote ${written} Markdown mirror${written === 1 ? '' : 's'}.`
    : `ShowDocx wrote ${written} mirror${written === 1 ? '' : 's'}; ${failures.length} failed.`
      + ' See the ShowDocx log.';
  void vscode.window.showInformationMessage(summary);
}

async function writeMirror(
  source: vscode.Uri,
  target: vscode.Uri,
  host: MirrorHost,
): Promise<void> {
  const { text } = await convertDocxToText(await host.read(source), {
    // A mirror is read as a diff, so the numbering that keeps a diff small is
    // the right one — the same text the editor's own comparison shows.
    stableOrderedNumbers: true,
  });
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(mirrorContents(source, text)));
}

/**
 * The mirror's contents, with a line saying what it is. Anyone who meets one of
 * these files in a pull request should be able to tell in a second that it is
 * generated and which document it came from.
 */
export function mirrorContents(source: vscode.Uri, text: string): string {
  const name = path.posix.basename(source.path);
  return `<!-- Generated by ShowDocx from ${name}. Edit the document, not this file. -->\n\n${text}`;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
