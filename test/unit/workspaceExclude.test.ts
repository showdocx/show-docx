import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { buildExcludePattern } from '../../shared/excludePattern';

describe('Workspace exclude patterns for file searches', () => {
  it('includes standard ignored directories (node_modules, .git, .venv, vendor)', () => {
    const pattern = buildExcludePattern();
    assert.ok(pattern.includes('**/node_modules/**'));
    assert.ok(pattern.includes('**/.git/**'));
    assert.ok(pattern.includes('**/.venv/**'));
    assert.ok(pattern.includes('**/vendor/**'));
    assert.ok(pattern.startsWith('{') && pattern.endsWith('}'));
  });

  it('merges user configured patterns from files.exclude and search.exclude', () => {
    const filesExclude = { '**/custom_ignore/**': true, '**/kept/**': false };
    const searchExclude = { '**/build/**': true };
    const pattern = buildExcludePattern(filesExclude, searchExclude);
    assert.ok(pattern.includes('**/custom_ignore/**'));
    assert.ok(pattern.includes('**/build/**'));
    assert.ok(!pattern.includes('**/kept/**'));
  });
});
