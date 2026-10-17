import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { MirrorWriteQueue } from '../../src/mirror/mirrorQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {resolve = done;});
  return { promise, resolve };
}

describe('Markdown mirror write queue', () => {
  it('invalidates an old conversion when a newer refresh is reserved, before its debounce fires', async () => {
    const queue = new MirrorWriteQueue();
    const started = deferred();
    const release = deferred();
    const old = queue.reserve('target');
    const writes: string[] = [];
    const first = old.run(async (isCurrent) => {
      started.resolve();
      await release.promise;
      if (!isCurrent()) {return false;}
      writes.push('old');
      return true;
    });
    await started.promise;
    const newer = queue.reserve('target');
    assert.equal(old.isCurrent(), false);
    release.resolve();
    assert.equal(await first, false);
    // Simulate the debounce callback not running until the old work has finished.
    assert.equal(await newer.run(async () => {writes.push('new'); return true;}), true);
    assert.deepEqual(writes, ['new']);
  });

  it('serializes an already-started write so the newer write always finishes last', async () => {
    const queue = new MirrorWriteQueue();
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = queue.reserve('same').run(async () => {
      started.resolve();
      await release.promise;
      order.push('old write completed');
      return true;
    });
    await started.promise;
    const next = queue.reserve('same').run(async () => {
      order.push('new write completed');
      return true;
    });
    await Promise.resolve();
    assert.deepEqual(order, []);
    release.resolve();
    await Promise.all([first, next]);
    assert.deepEqual(order, ['old write completed', 'new write completed']);
  });

  it('cancels stale pending and in-flight work without affecting another target', async () => {
    const queue = new MirrorWriteQueue();
    const pending = queue.reserve('deleted');
    pending.cancel();
    assert.equal(await pending.run(async () => {throw new Error('must not run');}), false);
    const other = queue.reserve('other');
    assert.equal(await other.run(async () => true), true);
    const next = queue.reserve('deleted');
    assert.equal(await next.run(async () => true), true);
  });

  it('recovers after errors and lets distinct targets proceed independently', async () => {
    const queue = new MirrorWriteQueue();
    const started = deferred();
    const release = deferred();
    const broken = queue.reserve('broken').run(async () => {
      started.resolve();
      await release.promise;
      throw new Error('read failure');
    });
    const rejected = assert.rejects(broken, /read failure/);
    await started.promise;
    assert.equal(await queue.reserve('unrelated').run(async () => true), true);
    const recovery = queue.reserve('broken').run(async () => true);
    release.resolve();
    await rejected;
    assert.equal(await recovery, true);
  });
});
