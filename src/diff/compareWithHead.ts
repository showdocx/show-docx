import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EmptyRepositoryError,
  GitUnavailableError,
  NotInRepositoryError,
  RevisionNotFoundError,
  createGitRunner,
  locateInRepository,
  readFileAtRef,
  refExists,
} from './git';
import { DIFF_SCHEME, WORKING_TREE, encodeDiffUri } from './diffProvider';
import type { DocxDiffContentProvider } from './diffProvider';
import { isDocumentPath } from '../../shared/documentExtensions';
import { getLog } from '../log';

/**
 * Compare a DOCX with the revision git has, in VS Code's own diff editor. Git
 * reports a DOCX as "Binary files differ" and the diff editor cannot open one,
 * so both sides are served as readable text instead.
 */

export const HEAD = 'HEAD';

/** The git executable, honouring the setting the git extension also reads. */
export function resolveGitPath(): string {
  const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  const candidate = Array.isArray(configured) ? configured[0] : configured;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : 'git';
}

export async function readDocxAtRef(uri: vscode.Uri, ref: string): Promise<Uint8Array> {
  const run = createGitRunner(resolveGitPath());
  const { root, relativePath } = await locateInRepository(uri.fsPath, run);
  return readFileAtRef(root, relativePath, ref, run);
}

/**
 * Opens the comparison, or explains why it cannot be opened. Every failure here
 * is a condition of the user's repository rather than a bug, so each one gets
 * its own message instead of a generic error.
 */
export async function compareWithHead(
  target: vscode.Uri | undefined,
  provider: DocxDiffContentProvider,
): Promise<void> {
  if (!target) {
    void vscode.window.showWarningMessage(
      'ShowDocx: open or select a .docx file to compare it with HEAD.',
    );
    return;
  }
  if (target.scheme !== 'file') {
    void vscode.window.showWarningMessage(
      'ShowDocx can only compare documents stored on this machine.',
    );
    return;
  }

  const name = path.basename(target.path);
  try {
    const run = createGitRunner(resolveGitPath());
    const { root, relativePath } = await locateInRepository(target.fsPath, run);
    if (!await refExists(root, HEAD, run)) {
      throw new EmptyRepositoryError(HEAD);
    }
    // Fail here rather than inside the content provider, where the only report
    // available is the diff editor refusing to open one of its sides.
    await readFileAtRef(root, relativePath, HEAD, run);

    const left = encodeDiffUri(target, HEAD);
    const right = encodeDiffUri(target, undefined);
    // Both sides may already be open from an earlier comparison of the same
    // document, in which case VS Code would otherwise reuse what it cached.
    provider.refresh(left);
    provider.refresh(right);

    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${name} (${HEAD} ↔ ${WORKING_TREE})`,
      { preview: true },
    );
    getLog().info(`Comparing ${relativePath} with ${HEAD}.`);
  } catch (error: unknown) {
    getLog().error(`Comparing ${name} with ${HEAD} failed.`, error);
    void vscode.window.showWarningMessage(`ShowDocx: ${toUserMessage(error, name)}`);
  }
}

function toUserMessage(error: unknown, name: string): string {
  if (error instanceof NotInRepositoryError) {
    return `${name} is not inside a git repository, so there is no revision to compare it with.`;
  }
  if (error instanceof EmptyRepositoryError) {
    return `This repository has no commits yet, so ${name} has no previous revision.`;
  }
  if (error instanceof RevisionNotFoundError) {
    return `${name} is not in ${HEAD}. A file that is new, or was renamed in the working tree, has no revision under this name.`;
  }
  if (error instanceof GitUnavailableError) {
    return error.message;
  }
  return `${name} could not be compared with ${HEAD}. See the ShowDocx log for details.`;
}

/** True for a URI the comparison command can act on. */
export function isComparableDocx(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined
    && uri.scheme !== DIFF_SCHEME
    && isDocumentPath(uri.path);
}
