import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import { isPhysicalPathContained } from '../../src/mirror/mirrorSafety';
import type { PhysicalPathHost } from '../../src/mirror/mirrorSafety';

const root = path.resolve('mirror-test-root');
const outside = path.resolve('mirror-test-outside');
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

function fakePaths(links: ReadonlyMap<string, string> = new Map()): PhysicalPathHost {
  return {
    realpath: async (file) => {
      if ([root, outside, path.parse(root).root].includes(file)) {return file;}
      throw missing();
    },
    lstat: async (file) => {
      if (links.has(file)) {return { isSymbolicLink: () => true };}
      throw missing();
    },
    readlink: async (file) => {
      const target = links.get(file);
      assert.ok(target);
      return target;
    },
  };
}

describe('Markdown mirror physical containment', () => {
  it('allows an ordinary missing suffix inside the physical base', async () => {
    assert.equal(await isPhysicalPathContained(path.join(root, 'new', 'doc.md'), root, fakePaths()), true);
  });

  it('resolves a dangling final link instead of treating it as a missing mirror', async () => {
    const target = path.join(root, 'doc.md');
    const host = fakePaths(new Map([[target, path.join(outside, 'not-created.md')]]));
    assert.equal(await isPhysicalPathContained(target, root, host), false);
  });

  it('resolves dangling ancestor links, relative targets and chained links', async () => {
    const directory = path.join(root, 'mirrors');
    const intermediate = path.join(root, 'redirect');
    const host = fakePaths(new Map([
      [directory, 'redirect'],
      [intermediate, path.join(outside, 'not-created')],
    ]));
    assert.equal(await isPhysicalPathContained(path.join(directory, 'doc.md'), root, host), false);
  });

  it('resolves symlinks before collapsing parent segments in a dangling link target', async () => {
    const target = path.join(root, 'doc.md');
    const host = fakePaths(new Map([
      [target, `redirect${path.sep}..${path.sep}escaped.md`],
      [path.join(root, 'redirect'), path.join(outside, 'nested')],
    ]));
    assert.equal(await isPhysicalPathContained(target, root, host), false);
  });

  it('allows a dangling final link only when its eventual target remains inside the base', async () => {
    const target = path.join(root, 'doc.md');
    assert.equal(await isPhysicalPathContained(target, root,
      fakePaths(new Map([[target, 'inside.md']]))), true);
  });

  it('fails closed on realpath errors other than ENOENT, without trying a parent', async () => {
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP']) {
      const host = fakePaths();
      const calls: string[] = [];
      host.realpath = async (file) => {
        calls.push(file);
        if (file === root) {return root;}
        throw Object.assign(new Error(code), { code });
      };
      const target = path.join(root, 'doc.md');
      assert.equal(await isPhysicalPathContained(target, root, host), false, code);
      assert.deepEqual(calls, [root, target], code);
    }
  });

  it('does not swallow lstat/readlink failures or a dangling link cycle', async () => {
    const target = path.join(root, 'doc.md');
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const statHost = fakePaths();
    statHost.lstat = async () => {throw denied;};
    assert.equal(await isPhysicalPathContained(target, root, statHost), false);
    const linkHost = fakePaths(new Map([[target, 'other.md']]));
    linkHost.readlink = async () => {throw denied;};
    assert.equal(await isPhysicalPathContained(target, root, linkHost), false);
    assert.equal(await isPhysicalPathContained(target, root, fakePaths(new Map([
      [target, 'other.md'], [path.join(root, 'other.md'), 'doc.md'],
    ]))), false);
  });

  it('checks an actual dangling link when the OS permits creating one', async function () {
    const temporary = await mkdtemp(path.join(await realpath(tmpdir()), 'mirror-safety-'));
    try {
      const base = path.join(temporary, 'repo');
      await mkdir(base);
      const target = path.join(base, 'doc.md');
      try {
        await symlink(path.join(temporary, 'not-created.md'), target, 'file');
      } catch (error) {
        if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') {
          this.skip();
        }
        throw error;
      }
      assert.equal(await isPhysicalPathContained(target, base), false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
