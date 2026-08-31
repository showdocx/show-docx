import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'mocha';
import {
  DOCUMENT_EXTENSIONS,
  FILENAME_PATTERN,
  RESOURCE_EXTNAME_CLAUSE,
  isDocumentPath,
  stripDocumentExtension,
} from '../../shared/documentExtensions';

describe('Word file types', () => {
  it('covers the four OOXML Word packages', () => {
    assert.deepEqual([...DOCUMENT_EXTENSIONS], ['.docx', '.docm', '.dotx', '.dotm']);
  });

  it('recognizes each of them, in any casing', () => {
    for (const extension of DOCUMENT_EXTENSIONS) {
      assert.ok(isDocumentPath(`spec${extension}`), extension);
      assert.ok(isDocumentPath(`SPEC${extension.toUpperCase()}`), extension);
      assert.ok(isDocumentPath(`/a/b/spec${extension}`), extension);
    }
  });

  it('does not recognize anything else', () => {
    for (const name of ['notes.txt', 'legacy.doc', 'sheet.xlsx', 'spec.docx.exe', 'docx', '']) {
      assert.equal(isDocumentPath(name), false, name);
    }
  });

  it('strips the extension to derive an export name', () => {
    assert.equal(stripDocumentExtension('report.docx'), 'report');
    assert.equal(stripDocumentExtension('form.docm'), 'form');
    assert.equal(stripDocumentExtension('letterhead.DOTX'), 'letterhead');
    assert.equal(stripDocumentExtension('/a/b/spec.dotm'), '/a/b/spec');
  });

  it('leaves a name it does not recognize whole', () => {
    // Truncating here would silently produce a wrong export file name.
    assert.equal(stripDocumentExtension('notes.txt'), 'notes.txt');
    assert.equal(stripDocumentExtension('report'), 'report');
  });

  it('keeps a name that only contains an extension elsewhere', () => {
    assert.equal(stripDocumentExtension('docx.notes.txt'), 'docx.notes.txt');
  });
});

describe('The manifest and the file type list', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ) as {
    contributes: {
      customEditors: Array<{ selector: Array<{ filenamePattern: string }> }>;
      menus: Record<string, Array<{ command: string; when?: string }>>;
      commands: Array<{ command: string; enablement?: string }>;
    };
  };

  it('registers the custom editor for every type', () => {
    // The manifest cannot import the list, so this is what keeps the two in step.
    assert.equal(
      manifest.contributes.customEditors[0]?.selector[0]?.filenamePattern,
      FILENAME_PATTERN,
    );
  });

  it('offers the explorer menu for every type', () => {
    for (const item of manifest.contributes.menus['explorer/context'] ?? []) {
      assert.equal(item.when, RESOURCE_EXTNAME_CLAUSE, item.command);
    }
  });

  it('enables the comparison command for every type', () => {
    const compare = manifest.contributes.commands
      .find((command) => command.command === 'showDocx.compareWithHead');
    assert.ok(compare?.enablement?.includes(RESOURCE_EXTNAME_CLAUSE));
  });
});
