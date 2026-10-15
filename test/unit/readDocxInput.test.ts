import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  DEFAULT_MAX_CHARACTERS,
  ToolInputError,
  containedCandidates,
  isInsideAnyFolder,
  parseReadDocxInput,
  resolveDocxCandidates,
  truncateForModel,
} from '../../src/lm/readDocxInput';

const WORKSPACE = path.resolve('/workspace');
const OTHER = path.resolve('/elsewhere');

describe('Read tool: reading the arguments', () => {
  it('accepts a path and applies the default length', () => {
    assert.deepEqual(
      parseReadDocxInput({ filePath: 'docs/spec.docx' }),
      { filePath: 'docs/spec.docx', maxCharacters: DEFAULT_MAX_CHARACTERS },
    );
  });

  it('trims the path a model may have padded', () => {
    assert.equal(parseReadDocxInput({ filePath: '  spec.docx  ' }).filePath, 'spec.docx');
  });

  it('rejects a missing or unusable path', () => {
    for (const input of [undefined, {}, { filePath: '' }, { filePath: '   ' }, { filePath: 42 }]) {
      assert.throws(() => parseReadDocxInput(input), (error: unknown) => (
        error instanceof ToolInputError && /filePath/.test(error.message)
      ));
    }
  });

  it('accepts every Word file type', () => {
    for (const name of ['spec.docx', 'form.docm', 'letterhead.dotx', 'macro.dotm']) {
      assert.equal(parseReadDocxInput({ filePath: name }).filePath, name);
    }
  });

  it('rejects a file that is not a Word document', () => {
    // The tool must not become a way to read arbitrary files through a model.
    for (const filePath of ['notes.txt', '../../.env', 'id_rsa', 'spec.docx.exe']) {
      assert.throws(
        () => parseReadDocxInput({ filePath }),
        (error: unknown) => error instanceof ToolInputError,
      );
    }
  });

  it('accepts the extension in any casing', () => {
    assert.equal(parseReadDocxInput({ filePath: 'Spec.DOCX' }).filePath, 'Spec.DOCX');
  });

  it('bounds the length a model asks for', () => {
    assert.equal(parseReadDocxInput({ filePath: 'a.docx', maxCharacters: 500 }).maxCharacters, 500);
    assert.equal(parseReadDocxInput({ filePath: 'a.docx', maxCharacters: 0 }).maxCharacters, 1);
    assert.equal(parseReadDocxInput({ filePath: 'a.docx', maxCharacters: -5 }).maxCharacters, 1);
    assert.equal(
      parseReadDocxInput({ filePath: 'a.docx', maxCharacters: 1e12 }).maxCharacters,
      1_000_000,
    );
  });

  it('falls back to the default for a length that is not a number', () => {
    for (const maxCharacters of ['lots', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      assert.equal(
        parseReadDocxInput({ filePath: 'a.docx', maxCharacters }).maxCharacters,
        DEFAULT_MAX_CHARACTERS,
      );
    }
  });
});

describe('Read tool: resolving a path', () => {
  it('resolves a relative path against each workspace folder', () => {
    assert.deepEqual(
      resolveDocxCandidates('docs/spec.docx', [WORKSPACE, OTHER]),
      [path.join(WORKSPACE, 'docs', 'spec.docx'), path.join(OTHER, 'docs', 'spec.docx')],
    );
  });

  it('accepts an absolute path inside the workspace', () => {
    const inside = path.join(WORKSPACE, 'spec.docx');
    assert.deepEqual(resolveDocxCandidates(inside, [WORKSPACE]), [inside]);
  });

  it('refuses an absolute path outside the workspace', () => {
    assert.deepEqual(resolveDocxCandidates(path.join(OTHER, 'secret.docx'), [WORKSPACE]), []);
  });

  it('refuses a relative path that climbs out of the workspace', () => {
    // The whole point of the check: a model's arguments can be steered by text
    // it has read, so a path is a request rather than a permission.
    assert.deepEqual(
      resolveDocxCandidates(path.join('..', '..', 'private', 'secret.docx'), [WORKSPACE]),
      [],
    );
  });

  it('has nothing to offer when no folder is open', () => {
    assert.deepEqual(resolveDocxCandidates('spec.docx', []), []);
  });

  it('does not mistake a sibling folder with a shared prefix for the workspace', () => {
    const sibling = `${WORKSPACE}-private`;
    assert.equal(isInsideAnyFolder(path.join(sibling, 'secret.docx'), [WORKSPACE]), false);
  });

  it('does not accept the workspace folder itself', () => {
    assert.equal(isInsideAnyFolder(WORKSPACE, [WORKSPACE]), false);
  });
});

describe('Read tool: following links', () => {
  /** Stands in for the file system: what each path really is, if it exists. */
  function links(map: Record<string, string>): (value: string) => Promise<string> {
    return async (value) => {
      const real = map[value];
      if (real === undefined) {
        throw new Error(`ENOENT: ${value}`);
      }
      return real;
    };
  }

  it('refuses a link inside the workspace that leads outside it', async () => {
    const link = path.join(WORKSPACE, 'docs', 'link.docx');
    const realpath = links({
      [WORKSPACE]: WORKSPACE,
      [link]: path.join(OTHER, 'private', 'secret.docx'),
    });

    assert.deepEqual(await containedCandidates([link], [WORKSPACE], realpath), []);
  });

  it('reads a link that stays inside, as the file it leads to', async () => {
    const link = path.join(WORKSPACE, 'latest.docx');
    const target = path.join(WORKSPACE, 'archive', 'v3.docx');
    const realpath = links({ [WORKSPACE]: WORKSPACE, [link]: target });

    assert.deepEqual(await containedCandidates([link], [WORKSPACE], realpath), [target]);
  });

  it('still contains its files when the workspace itself was opened through a link', async () => {
    const real = path.resolve('/data/workspace');
    const candidate = path.join(WORKSPACE, 'spec.docx');
    const realpath = links({ [WORKSPACE]: real, [candidate]: path.join(real, 'spec.docx') });

    assert.deepEqual(await containedCandidates([candidate], [WORKSPACE], realpath), [path.join(real, 'spec.docx')]);
  });

  it('refuses a link to something that is not a Word document', async () => {
    const link = path.join(WORKSPACE, 'notes.docx');
    const realpath = links({ [WORKSPACE]: WORKSPACE, [link]: path.join(WORKSPACE, '.env') });

    assert.deepEqual(await containedCandidates([link], [WORKSPACE], realpath), []);
  });

  it('leaves out a path that does not exist', async () => {
    const realpath = links({ [WORKSPACE]: WORKSPACE });

    assert.deepEqual(await containedCandidates([path.join(WORKSPACE, 'gone.docx')], [WORKSPACE], realpath), []);
  });
});

describe('Read tool: bounding the output', () => {
  it('returns a short document unchanged', () => {
    assert.equal(truncateForModel('short\n', 1000), 'short\n');
  });

  it('cuts at a line boundary and says how much was left out', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}\n${'c'.repeat(60)}\n`;

    const result = truncateForModel(text, 100);

    assert.ok(result.startsWith(`${'a'.repeat(60)}\n`));
    assert.ok(!result.includes('c'.repeat(60)), 'the cut content must not be included');
    assert.match(result, /showing the first 60 of 183 characters/);
    assert.match(result, /maxCharacters/);
  });

  it('cuts mid-line rather than returning almost nothing', () => {
    // One very long first line: honouring the boundary would drop everything.
    const result = truncateForModel(`${'a'.repeat(500)}\nb\n`, 100);
    assert.ok(result.startsWith('a'.repeat(100)));
  });
});
