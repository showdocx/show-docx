import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { getNonce } from '../../src/utils/getNonce';

describe('getNonce', () => {
  it('returns a URL-safe nonce with the requested length', () => {
    const nonce = getNonce(48);
    assert.equal(nonce.length, 48);
    assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  });

  it('generates unique values', () => {
    const values = new Set(Array.from({ length: 100 }, () => getNonce()));
    assert.equal(values.size, 100);
  });

  it('rejects unsafe lengths', () => {
    assert.throws(() => getNonce(8), RangeError);
  });
});
