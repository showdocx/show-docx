import { strict as assert } from 'node:assert';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { after, afterEach, before, describe, it } from 'mocha';
import { Document, Packer, Paragraph } from 'docx';
import {
  cancelMirrorRefresh,
  disposeMirrorRefreshes,
  isRealpathWithinWorkspace,
  mirrorContents,
  mirrorUriFor,
  ownsMirror,
  planMirrors,
  refreshExistingMirror,
  scheduleMirrorRefresh,
  writePlannedMirror,
} from '../../src/mirror/markdownMirror';

/**
 * The rule this feature lives by: it refreshes a mirror that exists and never
 * creates one. It writes to the user's repository, so that is the behaviour
 * worth testing against the real file system rather than a stub.
 */
describe('Keeping a Markdown mirror up to date', () => {
  let folder: string;
  let fixtures: string;

  const host = {
    read: async (uri: vscode.Uri) => new Uint8Array(await readFile(uri.fsPath)),
  };

  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();
    fixtures = path.join(extension.extensionPath, 'test', 'fixtures');
    folder = await mkdtemp(path.join(await realpath(tmpdir()), 'showdocx-mirror-'));
  });

  afterEach(async () => {
    await vscode.workspace.getConfiguration('showDocx').update(
      'markdownMirror',
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  async function document(name: string): Promise<vscode.Uri> {
    const target = path.join(folder, name);
    await copyFile(path.join(fixtures, 'simple.docx'), target);
    return vscode.Uri.file(target);
  }

  async function setMode(mode: string): Promise<void> {
    await vscode.workspace.getConfiguration('showDocx').update(
      'markdownMirror',
      mode,
      vscode.ConfigurationTarget.Global,
    );
  }

  it('does not create a mirror for a document that has none', async function () {
    this.timeout(60_000);
    await setMode('onChange');
    const source = await document('untouched.docx');

    const wrote = await refreshExistingMirror(source, host);

    assert.equal(wrote, false);
    // The whole rule: a viewer must not add files to someone's repository.
    await assert.rejects(readFile(path.join(folder, 'untouched.md')));
  });

  it('rewrites a mirror that is already there', async function () {
    this.timeout(60_000);
    await setMode('onChange');
    const source = await document('mirrored.docx');
    const mirror = path.join(folder, 'mirrored.md');
    await writeFile(mirror, mirrorContents(source, 'stale contents'));

    const wrote = await refreshExistingMirror(source, host);

    assert.equal(wrote, true);
    const contents = await readFile(mirror, 'utf8');
    assert.ok(contents.includes('ShowDocx Sample'), contents.slice(0, 200));
    assert.ok(!contents.includes('stale contents'));
  });

  it('leaves a file ShowDocx did not write alone, whatever its name', async function () {
    this.timeout(60_000);
    await setMode('onChange');
    const source = await document('guide.docx');
    const notes = path.join(folder, 'guide.md');
    const handWritten = '# Guide\n\nWritten by hand, next to the document.\n';
    await writeFile(notes, handWritten);

    const wrote = await refreshExistingMirror(source, host);

    assert.equal(wrote, false);
    assert.equal(await readFile(notes, 'utf8'), handWritten);
  });

  it('does not take over the mirror of another document with the same name', async function () {
    this.timeout(60_000);
    await setMode('onChange');
    const source = await document('shared.docm');
    const mirror = path.join(folder, 'shared.md');
    const other = vscode.Uri.file(path.join(folder, 'shared.docx'));
    await writeFile(mirror, mirrorContents(other, 'the other document'));

    const wrote = await refreshExistingMirror(source, host);

    assert.equal(wrote, false);
    assert.ok((await readFile(mirror, 'utf8')).includes('the other document'));
  });

  it('does nothing at all while the setting is off', async function () {
    this.timeout(60_000);
    await setMode('off');
    const source = await document('disabled.docx');
    const mirror = path.join(folder, 'disabled.md');
    await writeFile(mirror, 'left alone');

    const wrote = await refreshExistingMirror(source, host);

    assert.equal(wrote, false);
    assert.equal(await readFile(mirror, 'utf8'), 'left alone');
  });

  it('says what a mirror is and where it came from', async function () {
    this.timeout(60_000);
    await setMode('onChange');
    const source = await document('labelled.docx');
    const mirror = path.join(folder, 'labelled.md');
    await writeFile(mirror, '');

    await refreshExistingMirror(source, host);

    // Anyone meeting this file in a pull request should see in a second that it
    // is generated and which document it came from.
    const contents = await readFile(mirror, 'utf8');
    assert.match(contents, /Generated by ShowDocx from labelled\.docx/);
    assert.match(contents, /Edit the document, not this file/);
  });

  it('never lets an older read overwrite a newer refresh of the same mirror', async () => {
    const source = await document('ordered.docx');
    const target = mirrorUriFor(source, '')!;
    await writeFile(target.fsPath, mirrorContents(source, 'before'));
    const entered = deferred();
    const release = deferred();
    const oldBytes = await documentBytes('OLD conversion');
    const newBytes = await documentBytes('NEW conversion');
    let newerRead = false;
    const settings = { mode: 'onChange', directory: '' } as const;
    const old = refreshExistingMirror(source, {
      read: async () => {entered.resolve(); await release.promise; return oldBytes;},
    }, settings);
    await entered.promise;
    const newer = refreshExistingMirror(source, {
      read: async () => {newerRead = true; return newBytes;},
    }, settings);
    await Promise.resolve();
    assert.equal(newerRead, false, 'same-target work must be serialized');
    release.resolve();
    assert.equal(await old, false);
    assert.equal(await newer, true);
    const text = await readFile(target.fsPath, 'utf8');
    assert.match(text, /NEW conversion/);
    assert.doesNotMatch(text, /OLD conversion/);
  });

  it('invalidates an in-flight read immediately, not at the end of the debounce', async () => {
    await setMode('onChange');
    const source = await document('debounced.docx');
    const target = mirrorUriFor(source, '')!;
    const original = mirrorContents(source, 'before debounce');
    await writeFile(target.fsPath, original);
    const entered = deferred();
    const release = deferred();
    const pending = refreshExistingMirror(source, {
      read: async () => {entered.resolve(); await release.promise; return host.read(source);},
    });
    await entered.promise;
    scheduleMirrorRefresh(source, host);
    // Cancelling the timer too makes this test independent of machine speed:
    // neither the obsolete conversion nor the cancelled follow-up may commit.
    cancelMirrorRefresh(source);
    release.resolve();
    assert.equal(await pending, false);
    assert.equal(await readFile(target.fsPath, 'utf8'), original);
  });

  it('routes a debounced editor refresh through the same queue as direct refreshes', async () => {
    await setMode('onChange');
    const source = await document('scheduled.docx');
    const target = mirrorUriFor(source, '')!;
    await writeFile(target.fsPath, mirrorContents(source, 'before scheduled refresh'));
    const entered = deferred();
    const release = deferred();
    const latestBytes = await documentBytes('Latest scheduled refresh');
    const old = refreshExistingMirror(source, {
      read: async () => {entered.resolve(); await release.promise; return host.read(source);},
    });
    await entered.promise;
    scheduleMirrorRefresh(source, { read: async () => latestBytes });
    release.resolve();
    assert.equal(await old, false);
    await waitForMirror(target.fsPath, 'Latest scheduled refresh');
  });

  it('does not overwrite handwritten edits or recreate a removed mirror after conversion', async () => {
    for (const remove of [false, true]) {
      const source = await document(`changed-${remove}.docx`);
      const target = mirrorUriFor(source, '')!;
      await writeFile(target.fsPath, mirrorContents(source, 'before'));
      const wrote = await refreshExistingMirror(source, {
        read: async () => {
          if (remove) {await rm(target.fsPath);}
          else {await writeFile(target.fsPath, '# Handwritten during conversion');}
          return host.read(source);
        },
      }, { mode: 'onChange', directory: '' });
      assert.equal(wrote, false);
      if (remove) {await assert.rejects(readFile(target.fsPath));}
      else {assert.equal(await readFile(target.fsPath, 'utf8'), '# Handwritten during conversion');}
    }
  });

  it('cancels pending and in-flight refreshes on disposal or source deletion', async () => {
    await setMode('onChange');
    for (const dispose of [false, true]) {
      const source = await document(`cancelled-${dispose}.docx`);
      const target = mirrorUriFor(source, '')!;
      const original = mirrorContents(source, 'before cancellation');
      await writeFile(target.fsPath, original);
      const entered = deferred();
      const release = deferred();
      const pending = refreshExistingMirror(source, {
        read: async () => {entered.resolve(); await release.promise; return host.read(source);},
      });
      await entered.promise;
      scheduleMirrorRefresh(source, host);
      if (dispose) {disposeMirrorRefreshes();}
      else {cancelMirrorRefresh(source);}
      release.resolve();
      assert.equal(await pending, false);
      assert.equal(await readFile(target.fsPath, 'utf8'), original);
    }
    const source = await document('deleted-during-read.docx');
    const target = mirrorUriFor(source, '')!;
    const original = mirrorContents(source, 'before deletion');
    await writeFile(target.fsPath, original);
    assert.equal(await refreshExistingMirror(source, {
      read: async () => {const bytes = await host.read(source); await rm(source.fsPath); return bytes;},
    }, { mode: 'onChange', directory: '' }), false);
    assert.equal(await readFile(target.fsPath, 'utf8'), original);
  });

  it('accepts different Windows URI drive-letter casing for the same physical base', async function () {
    if (process.platform !== 'win32') {this.skip();}
    const base = vscode.Uri.file(folder);
    const target = vscode.Uri.joinPath(base, 'case.md');
    const upper = base.with({ path: base.path.replace(/^\/[a-z]:/i, (drive) => drive.toUpperCase()) });
    const lower = target.with({ path: target.path.replace(/^\/[a-z]:/i, (drive) => drive.toLowerCase()) });
    assert.equal(await isRealpathWithinWorkspace(lower, upper), true);
  });

  it('refuses an actual dangling final symlink and a target swapped to one during conversion', async function () {
    const base = path.join(folder, 'symlink-base');
    await mkdir(base);
    const source = vscode.Uri.file(path.join(base, 'linked.docx'));
    await copyFile(path.join(fixtures, 'simple.docx'), source.fsPath);
    const target = mirrorUriFor(source, '')!;
    const escaped = path.join(folder, 'outside-not-created.md');
    try {
      await symlink(escaped, target.fsPath, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as { code?: string }).code === 'EPERM') {this.skip();}
      throw error;
    }
    assert.equal(await isRealpathWithinWorkspace(target, vscode.Uri.file(base)), false);
    const plan = await planMirrors([source], '');
    assert.equal(plan?.writes.length, 0);
    assert.equal(await writePlannedMirror(source, target, host), false);
    await rm(target.fsPath);
    await writeFile(target.fsPath, mirrorContents(source, 'before'));
    assert.equal(await refreshExistingMirror(source, {
      read: async () => {
        const bytes = await host.read(source);
        await rm(target.fsPath);
        await symlink(escaped, target.fsPath, 'file');
        return bytes;
      },
    }, { mode: 'onChange', directory: '' }), false);
    await assert.rejects(readFile(escaped), { code: 'ENOENT' });
  });

  it('refreshes an open standalone document even when preview autoReload is off', async function () {
    this.timeout(30_000);
    const configuration = vscode.workspace.getConfiguration('showDocx');
    const previousReload = configuration.inspect<boolean>('autoReload')?.globalValue;
    const previousDirectory = configuration.inspect<string>('markdownMirrorDirectory')?.globalValue;
    const source = await document('standalone-watcher.docx');
    const target = mirrorUriFor(source, '')!;
    assert.equal(vscode.workspace.getWorkspaceFolder(source), undefined);
    try {
      await configuration.update('autoReload', false, vscode.ConfigurationTarget.Global);
      await configuration.update('markdownMirrorDirectory', '', vscode.ConfigurationTarget.Global);
      await setMode('onChange');
      await writeFile(target.fsPath, mirrorContents(source, 'stale standalone mirror'));
      await vscode.commands.executeCommand('vscode.openWith', source, 'showDocx.docxViewer');
      await delay(1_500);
      await writeFile(source.fsPath, await documentBytes('Standalone mirror updated without preview reload'));
      await waitForMirror(target.fsPath, 'Standalone mirror updated without preview reload');
    } finally {
      await setMode('off');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await configuration.update('autoReload', previousReload, vscode.ConfigurationTarget.Global);
      await configuration.update('markdownMirrorDirectory', previousDirectory, vscode.ConfigurationTarget.Global);
    }
  });

  it('refreshes an unopened workspace document through the actual extension watcher', async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension);
    assert.ok(extension.packageJSON.activationEvents.includes('onStartupFinished'));
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    const directory = await mkdtemp(path.join(workspace.uri.fsPath, 'mirror-watcher-'));
    const heard: string[] = [];
    const observer = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = observer.onDidChange((uri) => heard.push(uri.toString()));
    try {
      const source = vscode.Uri.file(path.join(directory, 'unopened.DOCX'));
      const target = mirrorUriFor(source, '')!;
      await writeFile(source.fsPath, await documentBytes('Before watcher change'));
      await writeFile(target.fsPath, mirrorContents(source, 'stale'));
      await setMode('onChange');
      // The real file watcher starts asynchronously in VS Code.
      await delay(1_500);
      await writeFile(source.fsPath, await documentBytes('After watcher change'));
      try {
        await waitForMirror(target.fsPath, 'After watcher change');
      } catch (error) {
        assert.fail([
          String(error),
          `Events: ${JSON.stringify(heard)}`,
          `Base: ${workspace.uri.toString()}; target: ${target.toString()}`,
          `Contained: ${await isRealpathWithinWorkspace(target, workspace.uri)}`,
          `Contents: ${await readFile(target.fsPath, 'utf8')}`,
        ].join('\n'));
      }
    } finally {
      changed.dispose();
      observer.dispose();
      await setMode('off');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });
});

describe('Where a mirror belongs', () => {
  const source = vscode.Uri.file(path.join(path.sep, 'repo', 'docs', 'spec.docx'));

  it('sits beside the document by default', () => {
    const mirror = mirrorUriFor(source, '');
    assert.ok(mirror);
    assert.equal(path.posix.basename(mirror.path), 'spec.md');
    assert.equal(path.posix.dirname(mirror.path), path.posix.dirname(source.path));
  });

  it('names a mirror after the document, whichever Word type it is', () => {
    for (const name of ['form.docm', 'letterhead.dotx', 'macro.dotm']) {
      const document = source.with({ path: `/repo/${name}` });
      assert.equal(path.posix.basename(mirrorUriFor(document, '')?.path ?? ''), `${name.split('.')[0]}.md`);
    }
  });

  it('labels the mirror with the document it came from', () => {
    assert.match(mirrorContents(source, 'body'), /^<!-- Generated by ShowDocx from spec\.docx/);
    assert.ok(mirrorContents(source, 'body').endsWith('body'));
  });

  it('goes into a directory inside the folder it is resolved against', () => {
    assert.equal(mirrorUriFor(source, 'mirrors/markdown')?.path, '/repo/docs/mirrors/markdown/spec.md');
    assert.equal(mirrorUriFor(source, 'mirrors\\markdown')?.path, '/repo/docs/mirrors/markdown/spec.md');
  });

  it('refuses a directory that would leave that folder', () => {
    // The setting can come from the repository's own settings file, so a
    // document someone else wrote must not choose a file outside it.
    const outside = ['..', '../../.claude', 'mirrors/../../elsewhere', '/etc', 'C:\\Users', '\\\\server\\share'];
    for (const directory of outside) {
      assert.equal(mirrorUriFor(source, directory), undefined, directory);
    }
  });

  it('recognises only its own mirrors, or an empty placeholder', () => {
    assert.ok(ownsMirror(mirrorContents(source, 'body'), source));
    assert.ok(ownsMirror('', source));
    assert.ok(ownsMirror('\uFEFF\n', source));
    // A mirror written before labels became paths names only the file.
    assert.ok(ownsMirror('<!-- Generated by ShowDocx from spec.docx. Edit the document, not this file. -->\n\nold', source));
    assert.ok(!ownsMirror('# Spec\n\nWritten by hand.', source));
    assert.ok(!ownsMirror(mirrorContents(source.with({ path: '/repo/docs/other.docx' }), 'body'), source));
  });
});

describe('Planning a run of mirrors', () => {
  const root = (): vscode.Uri => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Expected the test workspace to be open.');
    return folder.uri;
  };
  const absent = async (): Promise<string | undefined> => undefined;
  const paths = (uris: readonly vscode.Uri[] | undefined): string[] => (uris ?? []).map((uri) => uri.path).sort();

  it('writes neither of two documents whose mirrors would be the same file', async () => {
    const base = root();
    const pair = [vscode.Uri.joinPath(base, 'x.docx'), vscode.Uri.joinPath(base, 'x.docm')];
    const nested = [vscode.Uri.joinPath(base, 'a', 'spec.docx'), vscode.Uri.joinPath(base, 'b', 'Spec.docx')];
    const alone = vscode.Uri.joinPath(base, 'alone.docx');

    const beside = await planMirrors([...pair, ...nested, alone], '', absent);
    assert.deepEqual(paths(beside?.collisions), paths(pair));
    assert.deepEqual(paths(beside?.writes.map((entry) => entry.source)), paths([...nested, alone]));

    // With one directory for every mirror, the two spec.docx land on one file.
    const together = await planMirrors([...nested, alone], 'mirrors', absent);
    assert.deepEqual(paths(together?.collisions), paths(nested));
    assert.deepEqual(paths(together?.writes.map((entry) => entry.source)), [alone.path]);
  });

  it('skips a document whose mirror name belongs to a file ShowDocx did not write', async () => {
    const base = root();
    const handWritten = vscode.Uri.joinPath(base, 'guide.docx');
    const mirrored = vscode.Uri.joinPath(base, 'spec.docx');
    const existing = new Map([
      [vscode.Uri.joinPath(base, 'guide.md').toString(), '# Guide, written by hand'],
      [vscode.Uri.joinPath(base, 'spec.md').toString(), mirrorContents(mirrored, 'old')],
    ]);

    const plan = await planMirrors([handWritten, mirrored], '', async (target) => existing.get(target.toString()));

    assert.deepEqual(paths(plan?.foreign), [handWritten.path]);
    assert.deepEqual(paths(plan?.writes.map((entry) => entry.source)), [mirrored.path]);
  });

  it('plans nothing for a directory outside the workspace folder', async () => {
    assert.equal(await planMirrors([vscode.Uri.joinPath(root(), 'spec.docx')], '../outside', absent), undefined);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {resolve = done;});
  return { promise, resolve };
}

async function documentBytes(text: string): Promise<Uint8Array> {
  return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMirror(file: string, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await readFile(file, 'utf8')).includes(expected)) {return;}
    await delay(100);
  }
  assert.fail(`The workspace watcher did not refresh the mirror with ${JSON.stringify(expected)}.`);
}
