import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The slice of git ShowDocx needs: which repository a file belongs to, and what
 * that file looked like at a revision. Everything runs through an injectable
 * runner so the unit tests exercise the real argument building and error
 * mapping without a repository on disk.
 */

export interface GitResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/** git could not be started at all — not installed, or a bad `git.path`. */
export class GitUnavailableError extends Error {
  public constructor(gitPath: string) {
    super(`ShowDocx could not run git ("${gitPath}"). Install git or set the "git.path" setting.`);
    this.name = 'GitUnavailableError';
  }
}

export class NotInRepositoryError extends Error {
  public constructor() {
    super('This document is not inside a git repository.');
    this.name = 'NotInRepositoryError';
  }
}

export class RevisionNotFoundError extends Error {
  public constructor(
    public readonly ref: string,
    public readonly relativePath: string,
  ) {
    super(`"${relativePath}" does not exist in ${ref}.`);
    this.name = 'RevisionNotFoundError';
  }
}

export class EmptyRepositoryError extends Error {
  public constructor(public readonly ref: string) {
    super(`This repository has no commit to compare against yet (${ref} is unborn).`);
    this.name = 'EmptyRepositoryError';
  }
}

/** A DOCX far past the viewer's own limit should not be buffered from git either. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export function createGitRunner(gitPath: string): GitRunner {
  return (args, cwd) => new Promise<GitResult>((resolve, reject) => {
    execFile(
      gitPath,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // Reading a revision must never write to the repository the user is
        // working in, not even to refresh the index.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        // A spawn failure reports a string code such as ENOENT, an exit
        // status reports a number, and success reports no error at all.
        const spawnCode = (error as { code?: unknown } | null)?.code;
        if (typeof spawnCode === 'string') {
          reject(new GitUnavailableError(gitPath));
          return;
        }
        resolve({
          code: typeof spawnCode === 'number' ? spawnCode : 0,
          stdout,
          stderr: stderr.toString('utf8'),
        });
      },
    );
  });
}

/**
 * The repository a directory belongs to, or undefined when it belongs to none.
 * Run from the file's own directory, so a file inside a submodule resolves to
 * that submodule rather than to its parent repository.
 */
export async function findRepositoryRoot(
  directory: string,
  run: GitRunner,
): Promise<string | undefined> {
  const result = await run(['rev-parse', '--show-toplevel'], directory);
  if (result.code !== 0) {
    return undefined;
  }
  const root = decodeText(result.stdout).trim();
  return root === '' ? undefined : path.normalize(root);
}

/**
 * The path git knows a file by: relative to the repository root and always with
 * forward slashes, on every platform. Undefined when the file is outside.
 */
export function toRepositoryRelativePath(
  repositoryRoot: string,
  filePath: string,
): string | undefined {
  const relative = path.relative(repositoryRoot, filePath).replaceAll('\\', '/');
  if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

export interface RepositoryLocation {
  readonly root: string;
  readonly relativePath: string;
}

/**
 * Places a file inside its repository, or reports that it is in none.
 *
 * The path is resolved through symlinks first. git reports a repository under
 * its real path, so a directory reached through a link — macOS's /var, a linked
 * worktree, a symlinked project folder — would otherwise look as though it sat
 * outside the repository git just named.
 */
export async function locateInRepository(
  filePath: string,
  run: GitRunner,
  resolvePath: (value: string) => Promise<string> = toRealPath,
): Promise<RepositoryLocation> {
  const resolved = await resolvePath(filePath);
  const root = await findRepositoryRoot(path.dirname(resolved), run);
  if (root === undefined) {
    throw new NotInRepositoryError();
  }
  const relativePath = toRepositoryRelativePath(root, resolved);
  if (relativePath === undefined) {
    throw new NotInRepositoryError();
  }
  return { root, relativePath };
}

async function toRealPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    // A file that cannot be resolved is reported by the read that follows.
    return value;
  }
}

export async function readFileAtRef(
  repositoryRoot: string,
  relativePath: string,
  ref: string,
  run: GitRunner,
): Promise<Uint8Array> {
  const result = await run(
    ['--no-optional-locks', 'show', `${ref}:${relativePath}`],
    repositoryRoot,
  );
  if (result.code === 0) {
    return result.stdout;
  }
  throw toRevisionError(result.stderr, ref, relativePath);
}

/** Whether a revision exists — false in a repository with no commits yet. */
export async function refExists(
  repositoryRoot: string,
  ref: string,
  run: GitRunner,
): Promise<boolean> {
  const result = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repositoryRoot);
  return result.code === 0;
}

function toRevisionError(stderr: string, ref: string, relativePath: string): Error {
  // git says "unknown revision" for an unborn HEAD and "does not exist"/"exists
  // on disk, but not in" when the file itself was never committed. The two need
  // different advice, so they are told apart here rather than in the UI.
  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) {
    return new EmptyRepositoryError(ref);
  }
  return new RevisionNotFoundError(ref, relativePath);
}

function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}
