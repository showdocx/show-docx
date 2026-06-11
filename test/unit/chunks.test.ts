import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { splitIntoChunks } from '../../src/utils/chunks';

describe('splitIntoChunks', () => {
  it('keeps small data in one chunk', () => {
    const data = Uint8Array.from([1, 2, 3]);
    const chunks = splitIntoChunks(data, 8);
    assert.equal(chunks.length, 1);
    assert.deepEqual([...chunks[0]!], [1, 2, 3]);
  });

  it('splits and preserves all bytes', () => {
    const data = Uint8Array.from({ length: 10 }, (_, index) => index);
    const chunks = splitIntoChunks(data, 4);
    assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [4, 4, 2]);
    assert.deepEqual([...chunks[0]!, ...chunks[1]!, ...chunks[2]!], [...data]);
  });

  it('rejects invalid chunk sizes', () => {
    assert.throws(() => splitIntoChunks(new Uint8Array(), 0), RangeError);
  });
});
