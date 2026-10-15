import { strict as assert } from 'node:assert';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { after, afterEach, before, describe, it } from 'mocha';
import {
  mirrorContents,
  mirrorUriFor,
  ownsMirror,
  planMirrors,
  refreshExistingMirror,
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
