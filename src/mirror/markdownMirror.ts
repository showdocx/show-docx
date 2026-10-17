import * as path from 'node:path';
import * as vscode from 'vscode';
import { convertDocxToText } from '../text/docxText';
import { SEARCH_FILENAME_PATTERN, isDocumentPath, stripDocumentExtension } from '../../shared/documentExtensions';
import { getLog } from '../log';
import { isPhysicalPathContained } from './mirrorSafety';
import { MirrorWriteQueue } from './mirrorQueue';
import type { MirrorWriteTicket } from './mirrorQueue';
import { getWorkspaceExcludePattern } from '../utils/workspaceExclude';
import type { ZipValidationOptions } from '../docxLoader';

/**
 * An optional `.md` mirror of a document, kept next to it.
 *
 * Comparing revisions inside the editor is solved (#35). This is the same
 * problem everywhere else: `git diff` in a terminal, a pull request on GitHub,
 * a code review — all of which see a DOCX as "Binary files differ". A mirror
 * committed alongside the document makes those readable.
 *
 * This writes to the user's repository, so it follows two rules:
 *
 * - **It never creates a mirror on its own.** Creating one is always something
 *   the user asked for, by name, with a count and a destination in front of
 *   them. A viewer that quietly adds files to a repository is not a viewer
 *   anyone should trust.
 * - **It only replaces what it wrote.** A file is a mirror because its first
 *   line says ShowDocx generated it from this document — not because it
 *   happens to have the right name. A hand-written `guide.md` beside
 *   `guide.docx` is someone's work, and is left alone.
 */

export type MirrorMode = 'off' | 'onChange';
const MAX_MIRROR_DOCUMENTS = 5000;

export interface MirrorSettings {
  readonly mode: MirrorMode;
  /** Where mirrors go. Empty means beside the document. */
  readonly directory: string;
}

export interface MirrorHost {
  read(uri: vscode.Uri): Promise<Uint8Array>;
  zipValidationOptions?(): ZipValidationOptions;
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
 * Whether a configured directory can only ever name a folder inside the one it
 * is resolved against. The setting can come from a repository's own
 * `.vscode/settings.json`, so `..` or an absolute path would let a document
 * someone else wrote decide which file outside the workspace gets replaced.
 */
export function isContainedDirectory(directory: string): boolean {
  if (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)) {
    return false;
  }
  return !directory.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * Where a document's mirror belongs, or undefined when the configured directory
 * would put it outside the folder it is resolved against. A configured directory
 * is resolved against the document's workspace folder, so one setting works for
 * every document in the workspace rather than only the folder it was written in.
 */
export function mirrorUriFor(source: vscode.Uri, directory: string): vscode.Uri | undefined {
  const name = `${path.posix.basename(stripDocumentExtension(source.path))}.md`;
  if (directory === '') {
    return source.with({ path: `${path.posix.dirname(source.path)}/${name}` });
  }
  if (!isContainedDirectory(directory)) {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(source);
  const base = folder ? folder.uri : source.with({ path: path.posix.dirname(source.path) });
  const target = vscode.Uri.joinPath(base, directory.replaceAll('\\', '/'), name);
  const root = base.path.endsWith('/') ? base.path : `${base.path}/`;
  return target.path.startsWith(root) ? target : undefined;
}

/** Physical containment for local files; other providers must expose no links along the path. */
export async function isRealpathWithinWorkspace(target: vscode.Uri, base: vscode.Uri): Promise<boolean> {
  if (target.scheme !== base.scheme || target.authority !== base.authority) {return false;}
  if (target.scheme === 'file') {
    // URI paths preserve drive-letter casing; native paths compare it correctly on Windows.
    return isPhysicalPathContained(target.fsPath, base.fsPath);
  }
  const relative = path.posix.relative(base.path, target.path);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {return false;}

  // Never interpret a remote/virtual URI's fsPath on the extension host. The
  // provider API has no readlink, so links (including dangling ones) are refused.
  try {
    const basePath = base.path.replace(/\/+$/, '') || '/';
    let current = target;
    while (true) {
      try {
        const stat = await vscode.workspace.fs.stat(current);
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {return false;}
        if (current.path === basePath && (stat.type & vscode.FileType.Directory) === 0) {return false;}
      } catch (error) {
        if (!isFileNotFound(error) || current.path === basePath) {return false;}
      }
      if (current.path === basePath) {return true;}
      const parent = path.posix.dirname(current.path);
      if (parent === current.path) {return false;}
      current = current.with({ path: parent });
    }
  } catch {
    return false;
  }
}

function mirrorBase(source: vscode.Uri): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(source)?.uri
    ?? source.with({ path: path.posix.dirname(source.path) });
}

const writeQueue = new MirrorWriteQueue();
const requests = new Map<string, Set<MirrorWriteTicket>>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reserveWrite(source: vscode.Uri, target: vscode.Uri): MirrorWriteTicket {
  // Match planning's conservative collision handling on case-insensitive disks.
  const ticket = writeQueue.reserve(target.toString().toLowerCase());
  const key = source.toString();
  const pending = requests.get(key) ?? new Set<MirrorWriteTicket>();
  pending.add(ticket);
  requests.set(key, pending);
  return ticket;
}

function releaseWrite(source: vscode.Uri, ticket: MirrorWriteTicket): void {
  const key = source.toString();
  const pending = requests.get(key);
  pending?.delete(ticket);
  if (pending?.size === 0) {requests.delete(key);}
}

/** Shared by workspace watchers and the editor's single-file watcher (also outside the workspace). */
export function scheduleMirrorRefresh(source: vscode.Uri, host: MirrorHost): void {
  if (!isDocumentPath(source.path)) {return;}
  cancelMirrorRefresh(source);
  const settings = readMirrorSettings();
  if (settings.mode !== 'onChange' || !vscode.workspace.isTrusted) {return;}
  const target = mirrorUriFor(source, settings.directory);
  if (!target) {return;}
  // Reserve now, not when the timer fires: a save invalidates an old conversion immediately.
  const ticket = reserveWrite(source, target);
  refreshTimers.set(source.toString(), setTimeout(() => {
    refreshTimers.delete(source.toString());
    void refreshReserved(source, target, host, ticket);
  }, 300));
}

/** Deletion invalidates queued and in-flight conversions, not just a debounce timer. */
export function cancelMirrorRefresh(source: vscode.Uri): void {
  const key = source.toString();
  const timer = refreshTimers.get(key);
  if (timer !== undefined) {clearTimeout(timer);}
  refreshTimers.delete(key);
  for (const ticket of requests.get(key) ?? []) {ticket.cancel();}
  requests.delete(key);
}

export function disposeMirrorRefreshes(): void {
  for (const timer of refreshTimers.values()) {clearTimeout(timer);}
  refreshTimers.clear();
  for (const pending of requests.values()) {
    for (const ticket of pending) {ticket.cancel();}
  }
  requests.clear();
}

/**
 * How a mirror names its document: the path inside the workspace folder, or
 * the file name for a document outside any folder. A path rather than a name,
 * so two `spec.docx` in different folders never claim the same mirror.
 */
export function mirrorLabel(source: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(source);
  let label: string;
  if (folder) {
    const relative = source.scheme === 'file'
      ? path.relative(folder.uri.fsPath, source.fsPath).split(path.sep).join('/')
      : path.posix.relative(folder.uri.path, source.path);
    if (relative !== '' && !relative.startsWith('..')) {
      label = relative;
    } else {
      label = path.posix.basename(source.path);
    }
  } else {
    label = path.posix.basename(source.path);
  }
  // A filename is user controlled. Keep it from closing the generated comment
  // or splitting its header across lines.
  return label.replaceAll('-->', '-- >').replaceAll(/[\r\n]/g, ' ');
}

const HEADER = /^<!-- Generated by ShowDocx from (.+?)\. Edit the document, not this file\. -->/;

/**
 * Whether ShowDocx may replace a file with this document's mirror: the file says
 * it was generated from this document, or it is empty — an empty file is a
 * placeholder someone created to ask for a mirror, and holds nothing to lose.
 * A mirror written before labels became paths names only the file, which still
 * counts as this document's.
 */
export function ownsMirror(contents: string, source: vscode.Uri): boolean {
  // An editor may have saved the file with a byte order mark.
  const text = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  if (text.trim() === '') {
    return true;
  }
  const label = HEADER.exec(text)?.[1];
  return label !== undefined
    && (label === mirrorLabel(source) || label === path.posix.basename(source.path));
}

/**
 * Rewrites a mirror that is already there. Called when a document changes on
 * disk; a document with no mirror is left alone, which is the first rule, and a
 * file ShowDocx did not write is left alone, which is the second.
 */
export async function refreshExistingMirror(
  source: vscode.Uri,
  host: MirrorHost,
  settings: MirrorSettings = readMirrorSettings(),
): Promise<boolean> {
  if (settings.mode !== 'onChange') {
    return false;
  }
  if (!vscode.workspace.isTrusted) {
    // Restricted Mode is for not acting on a repository by yourself.
    return false;
  }
  const target = mirrorUriFor(source, settings.directory);
  if (!target) {
    getLog().warn(`Not refreshing the mirror of ${path.basename(source.path)}: showDocx.markdownMirrorDirectory must be a relative path inside the workspace folder.`);
    return false;
  }
  return refreshReserved(source, target, host, reserveWrite(source, target));
}

async function refreshReserved(
  source: vscode.Uri,
  target: vscode.Uri,
  host: MirrorHost,
  ticket: MirrorWriteTicket,
): Promise<boolean> {
  try {
    const written = await ticket.run((isCurrent) => writeMirror(source, target, host, false, isCurrent));
    if (written) {getLog().info(`Refreshed the Markdown mirror ${path.basename(target.path)}.`);}
    return written;
  } catch (error: unknown) {
    getLog().error(`Refreshing the mirror of ${path.basename(source.path)} failed.`, error);
    return false;
  } finally {
    releaseWrite(source, ticket);
  }
}

export interface MirrorPlan {
  /** Documents whose mirror can be written, with where it goes. */
  readonly writes: Array<{ readonly source: vscode.Uri; readonly target: vscode.Uri }>;
  /** Documents that share a mirror with another; none of them is written. */
  readonly collisions: vscode.Uri[];
  /** Documents whose mirror is foreign, unreadable, or cannot be safely contained. */
  readonly foreign: vscode.Uri[];
}

/**
 * Decides, before anything is written, what a run would do. Two documents
 * whose mirrors land on the same file — `x.docx` beside `x.docm`, or two
 * `spec.docx` with a mirror directory set — would silently overwrite each
 * other, so neither is written and both are reported. Case is ignored when
 * comparing, because the file systems most people use ignore it too.
 */
export async function planMirrors(
  documents: readonly vscode.Uri[],
  directory: string,
  readExisting: (target: vscode.Uri) => Promise<string | undefined> = readText,
): Promise<MirrorPlan | undefined> {
  const byTarget = new Map<string, Array<{ source: vscode.Uri; target: vscode.Uri }>>();
  for (const source of documents) {
    const target = mirrorUriFor(source, directory);
    if (!target) {
      return undefined;
    }
    const key = target.toString().toLowerCase();
    byTarget.set(key, [...(byTarget.get(key) ?? []), { source, target }]);
  }

  const writes: MirrorPlan['writes'][number][] = [];
  const collisions: vscode.Uri[] = [];
  const foreign: vscode.Uri[] = [];
  for (const group of byTarget.values()) {
    const [only, ...others] = group;
    if (!only) {
      continue;
    }
    if (others.length > 0) {
      collisions.push(...group.map((entry) => entry.source));
      continue;
    }
    if (!(await isRealpathWithinWorkspace(only.target, mirrorBase(only.source)))) {
      foreign.push(only.source);
      continue;
    }
    let existing: string | undefined;
    try {
      existing = await readExisting(only.target);
    } catch (error) {
      getLog().error(`Not mirroring ${path.basename(only.source.path)}: checking the existing mirror failed.`, error);
      foreign.push(only.source);
      continue;
    }
    if (existing !== undefined && !ownsMirror(existing, only.source)) {
      foreign.push(only.source);
      continue;
    }
    writes.push(only);
  }
  return { writes, collisions, foreign };
}

/**
 * Writes mirrors for every Word document in the workspace, after saying how
 * many and where. This is the only path that creates a file.
 */
export async function writeWorkspaceMirrors(host: MirrorHost): Promise<void> {
  const settings = readMirrorSettings();
  const documents = await vscode.workspace.findFiles(
    '**/' + SEARCH_FILENAME_PATTERN,
    getWorkspaceExcludePattern(),
    MAX_MIRROR_DOCUMENTS + 1,
  );
  if (documents.length > MAX_MIRROR_DOCUMENTS) {
    void vscode.window.showWarningMessage(
      `ShowDocx: more than ${MAX_MIRROR_DOCUMENTS} Word documents were found. Narrow the workspace before writing mirrors.`,
    );
    return;
  }
  if (documents.length === 0) {
    void vscode.window.showInformationMessage('ShowDocx: no Word documents in this workspace.');
    return;
  }

  const plan = await planMirrors(documents, settings.directory);
  if (!plan) {
    void vscode.window.showErrorMessage(
      `ShowDocx: showDocx.markdownMirrorDirectory ("${settings.directory}") must be a relative path inside the workspace folder.`,
    );
    return;
  }
  for (const source of plan.collisions) {
    getLog().warn(`Not mirroring ${vscode.workspace.asRelativePath(source)}: another document's mirror has the same name.`);
  }
  for (const source of plan.foreign) {
    getLog().warn(`Not mirroring ${vscode.workspace.asRelativePath(source)}: its mirror is foreign, unreadable, or cannot be safely contained.`);
  }
  const skipped = plan.collisions.length + plan.foreign.length;
  if (plan.writes.length === 0) {
    void vscode.window.showWarningMessage(
      `ShowDocx: no mirror can be written. ${skipped} document${skipped === 1 ? '' : 's'} skipped; see the ShowDocx log.`,
    );
    return;
  }

  const where = settings.directory === ''
    ? 'beside each document'
    : `in ${settings.directory}`;
  const skippedNote = skipped === 0
    ? ''
    : ` ${skipped} document${skipped === 1 ? ' is' : 's are'} skipped because of mirror collisions, ownership or safety checks; see the ShowDocx log.`;
  const count = plan.writes.length;
  const choice = await vscode.window.showWarningMessage(
    `Write a Markdown mirror for ${count} document${count === 1 ? '' : 's'}?`,
    {
      modal: true,
      detail: `A .md file will be written ${where}. A mirror ShowDocx wrote earlier is replaced;`
        + ' any other file is left alone.'
        + skippedNote
        + ' Mirrors are meant to be committed, so that git and code review can read'
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
      for (const [index, { source, target }] of plan.writes.entries()) {
        progress.report({
          message: `${index + 1} of ${count}`,
          increment: 100 / count,
        });
        try {
          if (await writePlannedMirror(source, target, host)) {written += 1;}
          else {failures.push(path.basename(source.path));}
        } catch (error: unknown) {
          // One unreadable document must not end the run over the others.
          getLog().error(`Mirroring ${path.basename(source.path)} failed.`, error);
          failures.push(path.basename(source.path));
        }
      }
    },
  );

  const parts = [`ShowDocx wrote ${written} Markdown mirror${written === 1 ? '' : 's'}`];
  if (failures.length > 0) {
    parts.push(`${failures.length} failed`);
  }
  if (skipped > 0) {
    parts.push(`${skipped} skipped`);
  }
  const summary = `${parts.join('; ')}.${failures.length + skipped > 0 ? ' See the ShowDocx log.' : ''}`;
  void vscode.window.showInformationMessage(summary);
}

/** Commit one entry after explicit batch confirmation; the plan itself grants no ownership. */
export async function writePlannedMirror(source: vscode.Uri, target: vscode.Uri, host: MirrorHost): Promise<boolean> {
  const ticket = reserveWrite(source, target);
  try {
    return await ticket.run((isCurrent) => writeMirror(source, target, host, true, isCurrent));
  } finally {
    releaseWrite(source, ticket);
  }
}

async function writeMirror(
  source: vscode.Uri,
  target: vscode.Uri,
  host: MirrorHost,
  allowCreate: boolean,
  isCurrent: () => boolean,
): Promise<boolean> {
  const canWrite = async (): Promise<boolean> => {
    if (!isCurrent() || (!allowCreate && !vscode.workspace.isTrusted)) {return false;}
    if (!(await isRealpathWithinWorkspace(target, mirrorBase(source)))) {
      getLog().warn(`Not mirroring ${path.basename(source.path)}: mirror containment could not be verified.`);
      return false;
    }
    const existing = await readText(target);
    if (existing === undefined ? !allowCreate : !ownsMirror(existing, source)) {
      getLog().warn(`Not mirroring ${path.basename(source.path)}: its mirror is missing or is not owned by this document.`);
      return false;
    }
    return isCurrent();
  };
  if (!(await canWrite())) {return false;}
  const { text } = await convertDocxToText(await host.read(source), {
    // A mirror is read as a diff, so the numbering that keeps a diff small is
    // the right one — the same text the editor's own comparison shows.
    stableOrderedNumbers: true,
  }, host.zipValidationOptions?.());
  const contents = new TextEncoder().encode(mirrorContents(source, text));
  if (!isCurrent()) {return false;}
  // The document may have been deleted while conversion was in flight.
  await vscode.workspace.fs.stat(source);
  // Planning, confirmation and conversion all await user/provider work. Recheck
  // ownership and physical containment at the actual commit, under the same queue.
  if (!(await canWrite())) {return false;}
  await vscode.workspace.fs.writeFile(target, contents);
  return true;
}

/**
 * The mirror's contents, with a line saying what it is. Anyone who meets one of
 * these files in a pull request should be able to tell in a second that it is
 * generated and which document it came from — and so can ShowDocx, which only
 * ever replaces a file whose first line says this.
 */
export function mirrorContents(source: vscode.Uri, text: string): string {
  return `<!-- Generated by ShowDocx from ${mirrorLabel(source)}. Edit the document, not this file. -->\n\n${text}`;
}

/** A file's text, or undefined when there is no file to read. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    if (isFileNotFound(error)) {return undefined;}
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}
