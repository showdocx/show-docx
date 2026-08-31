import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  EmptyRepositoryError,
  NotInRepositoryError,
  RevisionNotFoundError,
  findRepositoryRoot,
  locateInRepository,
  readFileAtRef,
  refExists,
  toRepositoryRelativePath,
} from '../../src/diff/git';
import type { GitResult, GitRunner } from '../../src/diff/git';

interface Invocation {
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Records what git would have been asked, and answers with a canned result. */
function fakeGit(
  reply: (args: readonly string[]) => Partial<GitResult>,
): { run: GitRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const result = reply(args);
    return {
      code: result.code ?? 0,
      stdout: result.stdout ?? new Uint8Array(),
      stderr: result.stderr ?? '',
    };
  };
  return { run, calls };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('Git: locating the repository', () => {
  it('asks git from the file directory, so a submodule resolves to itself', async () => {
    const { run, calls } = fakeGit(() => ({ stdout: bytes('/repo/module\n') }));

    const root = await findRepositoryRoot('/repo/module/docs', run);

    assert.equal(root, path.normalize('/repo/module'));
    assert.deepEqual(calls[0]?.args, ['rev-parse', '--show-toplevel']);
    assert.equal(calls[0]?.cwd, '/repo/module/docs');
  });

  it('reports no repository rather than failing', async () => {
    const { run } = fakeGit(() => ({ code: 128, stderr: 'fatal: not a git repository' }));
    assert.equal(await findRepositoryRoot('/tmp', run), undefined);
  });

  it('reports no repository when git answers with nothing', async () => {
    const { run } = fakeGit(() => ({ stdout: bytes('  \n') }));
    assert.equal(await findRepositoryRoot('/tmp', run), undefined);
  });
});

describe('Git: the path git knows a file by', () => {
  it('is relative to the repository root, with forward slashes', () => {
    assert.equal(
      toRepositoryRelativePath(path.join('/repo'), path.join('/repo', 'docs', 'spec.docx')),
      'docs/spec.docx',
    );
  });

  it('handles a file at the repository root', () => {
    assert.equal(
      toRepositoryRelativePath(path.join('/repo'), path.join('/repo', 'spec.docx')),
      'spec.docx',
    );
  });

  it('refuses a file outside the repository', () => {
    assert.equal(
      toRepositoryRelativePath(path.join('/repo'), path.join('/elsewhere', 'spec.docx')),
      undefined,
    );
  });

  it('refuses the repository root itself', () => {
    assert.equal(toRepositoryRelativePath(path.join('/repo'), path.join('/repo')), undefined);
  });
});

describe('Git: placing a file in its repository', () => {
  const resolveToReal = async (value: string) => value.replace('/var/', '/private/var/');

  it('resolves the file through symlinks before comparing it with the root', async () => {
    // git reports a repository under its real path. On macOS /var is a link to
    // /private/var, so an unresolved path looks as though it sat outside the
    // repository git just named.
    const { run } = fakeGit(() => ({ stdout: bytes('/private/var/repo\n') }));

    const location = await locateInRepository('/var/repo/spec.docx', run, resolveToReal);

    assert.equal(location.root, path.normalize('/private/var/repo'));
    assert.equal(location.relativePath, 'spec.docx');
  });

  it('reports a file that belongs to no repository', async () => {
    const { run } = fakeGit(() => ({ code: 128 }));

    await assert.rejects(
      locateInRepository('/tmp/spec.docx', run, async (value) => value),
      (error: unknown) => error instanceof NotInRepositoryError,
    );
  });

  it('reports a file that sits outside the repository git named', async () => {
    const { run } = fakeGit(() => ({ stdout: bytes('/repo\n') }));

    await assert.rejects(
      locateInRepository('/elsewhere/spec.docx', run, async (value) => value),
      (error: unknown) => error instanceof NotInRepositoryError,
    );
  });
});

describe('Git: reading a revision', () => {
  it('returns the bytes git wrote, unchanged', async () => {
    const content = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const { run, calls } = fakeGit(() => ({ stdout: content }));

    const data = await readFileAtRef('/repo', 'docs/spec.docx', 'HEAD', run);

    assert.deepEqual([...data], [...content]);
    assert.deepEqual(calls[0]?.args, ['--no-optional-locks', 'show', 'HEAD:docs/spec.docx']);
    assert.equal(calls[0]?.cwd, '/repo');
  });

  it('reports a file that is not in the revision', async () => {
    const { run } = fakeGit(() => ({
      code: 128,
      stderr: "fatal: path 'docs/spec.docx' does not exist in 'HEAD'",
    }));

    await assert.rejects(
      readFileAtRef('/repo', 'docs/spec.docx', 'HEAD', run),
      (error: unknown) => error instanceof RevisionNotFoundError,
    );
  });

  it('tells an unborn HEAD apart from a missing file', async () => {
    // A repository with no commits fails the same call for a different reason,
    // and the two need different advice.
    const { run } = fakeGit(() => ({
      code: 128,
      stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    }));

    await assert.rejects(
      readFileAtRef('/repo', 'spec.docx', 'HEAD', run),
      (error: unknown) => error instanceof EmptyRepositoryError,
    );
  });
});

describe('Git: checking a revision exists', () => {
  it('asks for the commit the ref resolves to', async () => {
    const { run, calls } = fakeGit(() => ({ code: 0 }));

    assert.equal(await refExists('/repo', 'HEAD', run), true);
    assert.deepEqual(
      calls[0]?.args,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    );
  });

  it('is false in a repository with no commits', async () => {
    const { run } = fakeGit(() => ({ code: 1 }));
    assert.equal(await refExists('/repo', 'HEAD', run), false);
  });
});
