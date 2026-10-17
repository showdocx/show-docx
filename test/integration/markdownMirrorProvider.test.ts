import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, before, beforeEach, describe, it } from 'mocha';
import {
  isRealpathWithinWorkspace,
  mirrorContents,
  planMirrors,
  refreshExistingMirror,
  writePlannedMirror,
} from '../../src/mirror/markdownMirror';

/** A real workspace.fs provider boundary, with deterministic errors and link metadata. */
class MirrorProvider implements vscode.FileSystemProvider {
  readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set(['/repo']);
  readonly links = new Set<string>();
  readFailure?: unknown;
  statFailure?: unknown;
  writes = 0;

  watch(): vscode.Disposable {return new vscode.Disposable(() => undefined);}
  stat(uri: vscode.Uri): vscode.FileStat {
    if (this.statFailure !== undefined) {throw this.statFailure;}
    const contents = this.files.get(uri.path);
    const type = this.links.has(uri.path) ? vscode.FileType.SymbolicLink
      : this.directories.has(uri.path) ? vscode.FileType.Directory
        : contents ? vscode.FileType.File : undefined;
    if (type === undefined) {throw vscode.FileSystemError.FileNotFound(uri);}
    return { type, ctime: 0, mtime: 0, size: contents?.length ?? 0 };
  }
  readFile(uri: vscode.Uri): Uint8Array {
    if (uri.path.endsWith('.md') && this.readFailure !== undefined) {throw this.readFailure;}
    const contents = this.files.get(uri.path);
    if (!contents) {throw vscode.FileSystemError.FileNotFound(uri);}
    return contents;
  }
  writeFile(uri: vscode.Uri, contents: Uint8Array): void {
    this.writes += 1;
    this.files.set(uri.path, contents);
  }
  readDirectory(): [string, vscode.FileType][] {return [];}
  createDirectory(uri: vscode.Uri): void {this.directories.add(uri.path);}
  delete(uri: vscode.Uri): void {this.files.delete(uri.path);}
  rename(): void {throw vscode.FileSystemError.Unavailable('Not implemented in mirror test provider.');}
}

describe('Markdown mirror provider safety', () => {
  const source = vscode.Uri.parse('showdocx-mirror-test://authority/repo/doc.docx');
  const target = source.with({ path: '/repo/doc.md' });
  const settings = { mode: 'onChange', directory: '' } as const;
  let provider: MirrorProvider;
  let registration: vscode.Disposable;
  let bytes: Uint8Array;
  const host = { read: async (uri: vscode.Uri) => vscode.workspace.fs.readFile(uri) };

  before(async () => {
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    bytes = await readFile(path.join(extension.extensionPath, 'test', 'fixtures', 'simple.docx'));
  });
  beforeEach(() => {
    provider = new MirrorProvider();
    provider.files.set(source.path, bytes);
    provider.files.set(target.path, new TextEncoder().encode(mirrorContents(source, 'old')));
    registration = vscode.workspace.registerFileSystemProvider(source.scheme, provider, { isCaseSensitive: true });
  });
  afterEach(() => {
    registration.dispose();
    provider.changes.dispose();
  });

  it('refreshes through the virtual provider, without interpreting its fsPath as a local path', async () => {
    assert.equal(await refreshExistingMirror(source, host, settings), true);
    assert.equal(provider.writes, 1);
    assert.match(new TextDecoder().decode(provider.files.get(target.path)), /ShowDocx Sample/);
  });

  it('treats only provider FileNotFound as missing, never EACCES, EIO or raw ENOENT', async () => {
    for (const error of [
      vscode.FileSystemError.NoPermissions('EACCES'),
      vscode.FileSystemError.Unavailable('EIO'),
      Object.assign(new Error('raw missing error'), { code: 'ENOENT' }),
      new Error('unexpected provider failure'),
    ]) {
      provider.readFailure = error;
      assert.equal(await refreshExistingMirror(source, host, settings), false);
      await assert.rejects(writePlannedMirror(source, target, host));
      const plan = await planMirrors([source], '');
      assert.equal(plan?.writes.length, 0);
      assert.deepEqual(plan?.foreign, [source]);
      assert.equal(provider.writes, 0);
    }
    provider.readFailure = vscode.FileSystemError.FileNotFound(target);
    assert.equal(await refreshExistingMirror(source, host, settings), false);
    provider.readFailure = undefined;
    provider.files.delete(target.path);
    assert.equal(await writePlannedMirror(source, target, host), true);
  });

  it('refuses link metadata at the final target, ancestor directory or provider base', async () => {
    for (const link of ['/repo/doc.md', '/repo/mirrors', '/repo']) {
      provider.links.add(link);
      const directory = link === '/repo/mirrors' ? 'mirrors' : '';
      assert.equal(await refreshExistingMirror(source, host, { ...settings, directory }), false, link);
      provider.links.clear();
    }
    assert.equal(provider.writes, 0);
  });

  it('fails closed on provider stat errors and a mismatched scheme or authority', async () => {
    provider.statFailure = vscode.FileSystemError.NoPermissions('cannot inspect links');
    assert.equal(await refreshExistingMirror(source, host, settings), false);
    provider.statFailure = undefined;
    const base = source.with({ path: '/repo' });
    assert.equal(await isRealpathWithinWorkspace(target, base.with({ scheme: 'file' })), false);
    assert.equal(await isRealpathWithinWorkspace(target, base.with({ authority: 'other' })), false);
    assert.equal(provider.writes, 0);
  });

  it('rechecks read errors and ownership after conversion rather than trusting the first check', async () => {
    for (const failRead of [true, false]) {
      provider.files.set(target.path, new TextEncoder().encode(mirrorContents(source, 'old')));
      provider.readFailure = undefined;
      const changingHost = {
        read: async () => {
          if (failRead) {provider.readFailure = vscode.FileSystemError.NoPermissions('became unreadable');}
          else {provider.files.set(target.path, new TextEncoder().encode('# Handwritten while converting'));}
          return bytes;
        },
      };
      assert.equal(await refreshExistingMirror(source, changingHost, settings), false);
      assert.equal(provider.writes, 0);
    }
  });

  it('rechecks provider link metadata introduced during conversion', async () => {
    assert.equal(await refreshExistingMirror(source, {
      read: async () => {provider.links.add(target.path); return bytes;},
    }, settings), false);
    assert.equal(provider.writes, 0);
  });

  it('does not trust a plan after the confirmation boundary changes ownership or links', async () => {
    const plan = await planMirrors([source], '');
    assert.equal(plan?.writes.length, 1);
    provider.files.set(target.path, new TextEncoder().encode('# Written during confirmation'));
    assert.equal(await writePlannedMirror(source, target, host), false);
    provider.files.set(target.path, new TextEncoder().encode(mirrorContents(source, 'old')));
    provider.links.add(target.path);
    assert.equal(await writePlannedMirror(source, target, host), false);
    assert.equal(provider.writes, 0);
  });
});
